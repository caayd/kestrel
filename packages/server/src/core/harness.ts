import { Context, Effect, Either, Layer, Runtime } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { basename, join } from "node:path"
import { InternalError, type CliProvider, type Message, type Run, type ServerEvent, type Task } from "@cloudagents/protocol"
import { CliAuth } from "../cliauth"
import { CredentialBroker } from "../broker"
import { Config } from "../config"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { SANDBOX_HOME, agentHome, initBox, prepareLaunch, sandboxSettingsOf } from "../sandbox"
import { EventHub } from "./events"
import { StateStore, newId, nowIso, type Mutable } from "./state"

export interface AgentHarnessShape {
  /**
   * Starts the harness for a run that is already persisted as `running` (see Core.sendMessage).
   * On spawn failure the run is aborted before the error is returned. `user` is the signed-in user
   * the run is for: their CLI logins replace the broker's API keys, and the broker uses their keys.
   */
  readonly spawn: (
    task: Task,
    run: Run,
    prompt: string,
    display: string | null,
    user: string,
  ) => Effect.Effect<void, InternalError>
  /** Kills a running run and marks it cancelled. Idempotent for already-finished runs. */
  readonly cancel: (runId: string) => Effect.Effect<void, InternalError>
  /** Marks a run that never started as failed. */
  readonly abort: (runId: string, reason: string) => Effect.Effect<void, InternalError>
  /** Cancels every active run; used at shutdown. */
  readonly stopAll: () => Effect.Effect<void>
}

export class AgentHarness extends Context.Tag("cloudagents/AgentHarness")<AgentHarness, AgentHarnessShape>() {}

interface ActiveRun {
  readonly child: ChildProcess
  readonly log: WriteStream
  readonly taskId: string
  readonly stdoutLines: string[]
  readonly stderrLines: string[]
  resultText: string | null
}

const KILL_GRACE_MS = 3000

/** Env var pointing each CLI at a user's login, and the broker keys that login replaces. */
const LOGIN_ENV: Record<CliProvider, { readonly env: string; readonly broker: ReadonlyArray<string> }> = {
  "claude-cli": { env: "CLAUDE_CONFIG_DIR", broker: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] },
  "codex-cli": { env: "CODEX_HOME", broker: ["OPENAI_API_KEY", "OPENAI_BASE_URL"] },
}

export const AgentHarnessLive = Layer.effect(
  AgentHarness,
  Effect.gen(function* () {
    const config = yield* Config
    const store = yield* StateStore
    const hub = yield* EventHub
    const broker = yield* CredentialBroker
    const cliAuth = yield* CliAuth
    const settings = sandboxSettingsOf(config)
    if (settings.systemd) {
      yield* initBox(settings.systemd)
      yield* Effect.logInfo(
        `agent sandboxes run in systemd slice ${settings.systemd.boxSlice}.slice, per task: MemoryMax=${settings.systemd.limits.memoryMax} CPUQuota=${settings.systemd.limits.cpuQuota} TasksMax=${settings.systemd.limits.tasksMax}`,
      )
    }
    const runtime = yield* Effect.runtime<never>()
    const runFork = Runtime.runFork(runtime)
    const active = new Map<string, ActiveRun>()

    const publish = hub.publish

    /** Applies `f` to a run and its task inside one state update; publishes what changed. */
    const patchRunAndTask = (
      runId: string,
      f: (run: Mutable<Run>, task: Mutable<Task>) => void,
    ): Effect.Effect<void, InternalError> =>
      Effect.gen(function* () {
        const changed = yield* store.update((s) => {
          const run = s.runs.find((r) => r.id === runId)
          if (!run) return Either.right(null)
          const task = s.tasks.find((t) => t.id === run.taskId)
          if (!task) return Either.right(null)
          f(run, task)
          task.updatedAt = nowIso()
          return Either.right({ run: { ...run }, task: { ...task } })
        })
        if (changed === null) return
        publish({ _tag: "run.updated", run: changed.run })
        publish({ _tag: "task.updated", task: changed.task })
      })

    const finish = (runId: string, exitCode: number | null, spawnError: string | null) =>
      Effect.gen(function* () {
        // The run's broker token dies with the run, whatever the outcome.
        yield* broker.revoke(runId)
        const entry = active.get(runId)
        if (!entry) return
        active.delete(runId)
        entry.log.end()
        if (spawnError) entry.stderrLines.push(spawnError)

        const outcome = yield* store.update((s) => {
          const run = s.runs.find((r) => r.id === runId)
          // Cancelled (or otherwise finished) runs keep their state.
          if (!run || run.status !== "running") return Either.right(null)
          const task = s.tasks.find((t) => t.id === run.taskId)
          if (!task) return Either.right(null)
          const ok = exitCode === 0
          const now = nowIso()
          run.status = ok ? "succeeded" : "failed"
          run.exitCode = exitCode
          run.endedAt = now
          // An agent that asked for input keeps that state until the user answers.
          if (task.status !== "needs_input") task.status = ok ? "done" : "failed"
          task.updatedAt = now
          const text =
            entry.resultText ??
            (entry.stdoutLines.join("\n").trim() ||
              entry.stderrLines.join("\n").trim() ||
              (ok ? "Run finished with no output." : `Run failed (exit code ${exitCode ?? "none"}).`))
          const message: Message = {
            id: newId(),
            taskId: task.id,
            role: "agent",
            text,
            runId,
            createdAt: now,
          }
          s.messages.push(message)
          return Either.right({ run: { ...run }, task: { ...task }, message })
        })
        if (outcome === null) return
        publish({ _tag: "message.created", message: outcome.message })
        publish({ _tag: "run.updated", run: outcome.run })
        publish({ _tag: "task.updated", task: outcome.task })
      }).pipe(
        Effect.catchAll((e) => Effect.logError(`run ${runId} finalize failed: ${e.message}`)),
      )

    const handleLine = (runId: string, stream: "stdout" | "stderr", line: string) => {
      const entry = active.get(runId)
      if (!entry) return
      entry.log.write(`${line}\n`)
      if (stream === "stderr") {
        entry.stderrLines.push(line)
        publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream, text: line })
        return
      }
      const trimmed = line.trim()
      if (trimmed.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "type" in parsed &&
            parsed.type === "result" &&
            "result" in parsed &&
            typeof parsed.result === "string"
          ) {
            entry.resultText = parsed.result
          }
          publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream: "event", text: line })
          return
        } catch {
          // not JSON after all; fall through to raw stdout
        }
      }
      entry.stdoutLines.push(line)
      publish({ _tag: "agent.output", taskId: entry.taskId, runId, stream: "stdout", text: line })
    }

    const shape: AgentHarnessShape = {
      spawn: (task, run, prompt, display, user) =>
        Effect.gen(function* () {
          const runDir = join(config.runsDir, run.id)
          const homeDir = join(config.homesDir, task.id)
          const mcpUrl = `${config.mcpBaseUrl}/mcp/${task.id}`
          const mcpConfigHost = join(homeDir, ".cloudagents", "mcp.json")
          const mcpConfigAgent = join(agentHome(settings, homeDir), ".cloudagents", "mcp.json")

          const started = yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(runDir, { recursive: true })
                await mkdir(join(homeDir, ".cloudagents"), { recursive: true })
                await writeFile(
                  mcpConfigHost,
                  JSON.stringify({ mcpServers: { cloudagents: { type: "http", url: mcpUrl } } }, null, 2),
                  "utf8",
                )
              },
              catch: (e) => new InternalError({ message: `cannot prepare run dir: ${String(e)}` }),
            })

            // A user's own CLI logins replace the broker's API keys for that provider.
            const logins = yield* cliAuth.loggedInDirs(user).pipe(Effect.mapError((e) => new InternalError({ message: e.message })))
            const loginDirs = logins.map((login) => ({
              provider: login.provider,
              host: login.dir,
              // Sandboxed runs see the login under their home; unsandboxed runs read it in place.
              inside: settings.enabled ? join(SANDBOX_HOME, ".kestrel", basename(login.dir)) : login.dir,
            }))
            const dropped = new Set(logins.flatMap((login) => LOGIN_ENV[login.provider].broker))
            const brokerEnv = yield* broker.issue(run.id, user)
            const keptBroker = Object.fromEntries(Object.entries(brokerEnv).filter(([key]) => !dropped.has(key)))
            const loginEnv = Object.fromEntries(loginDirs.map((d) => [LOGIN_ENV[d.provider].env, d.inside]))
            const launch = yield* prepareLaunch({
              settings,
              taskId: task.id,
              kind: "run",
              worktreePath: task.worktreePath,
              gitCommonDir: join(config.reposDir, task.repoId, ".git"),
              homeDir,
              display,
              env: {
                CLOUDAGENTS_PROMPT: prompt,
                CLOUDAGENTS_MCP_CONFIG: mcpConfigAgent,
                CLOUDAGENTS_MCP_URL: mcpUrl,
                CLOUDAGENTS_TASK_ID: task.id,
                CLOUDAGENTS_RUN_ID: run.id,
                ...keptBroker,
                ...loginEnv,
              },
              command: config.agentCommand,
              roBinds: config.fakeAgentRoBinds,
              binds: loginDirs.map((d) => ({ host: d.host, sandbox: d.inside })),
            })

            return yield* Effect.try({
              try: () => {
                const child = ownGroup(
                  spawn(launch.file, [...launch.args], {
                    cwd: launch.cwd,
                    env: { ...launch.env },
                    detached: NEW_PROCESS_GROUP,
                    stdio: ["ignore", "pipe", "pipe"],
                  }),
                )
                const log = createWriteStream(join(runDir, "output.log"), { flags: "a" })
                const entry: ActiveRun = {
                  child,
                  log,
                  taskId: task.id,
                  stdoutLines: [],
                  stderrLines: [],
                  resultText: null,
                }
                active.set(run.id, entry)
                createInterface({ input: child.stdout }).on("line", (line) => handleLine(run.id, "stdout", line))
                createInterface({ input: child.stderr }).on("line", (line) => handleLine(run.id, "stderr", line))
                child.on("error", (err) => {
                  runFork(finish(run.id, null, `failed to start agent: ${err.message}`))
                })
                child.on("close", (code) => {
                  runFork(finish(run.id, code, null))
                })
                return null
              },
              catch: (e) => new InternalError({ message: `failed to spawn agent: ${String(e)}` }),
            })
          }).pipe(Effect.either)

          if (Either.isLeft(started)) {
            yield* shape.abort(run.id, started.left.message)
            return yield* Effect.fail(started.left)
          }
        }),

      cancel: (runId) =>
        Effect.gen(function* () {
          yield* broker.revoke(runId)
          const entry = active.get(runId)
          if (entry) {
            killProcessGroup(entry.child.pid, "SIGTERM")
            const timer = setTimeout(() => {
              if (active.has(runId)) killProcessGroup(entry.child.pid, "SIGKILL")
            }, KILL_GRACE_MS)
            timer.unref()
          }
          yield* patchRunAndTask(runId, (run, task) => {
            if (run.status !== "running") return
            run.status = "cancelled"
            run.exitCode = null
            run.endedAt = nowIso()
            task.status = "idle"
          })
        }),

      abort: (runId, reason) =>
        Effect.gen(function* () {
          yield* broker.revoke(runId)
          const now = nowIso()
          const outcome = yield* store.update((s) => {
            const run = s.runs.find((r) => r.id === runId)
            if (!run || run.status !== "running") return Either.right(null)
            const task = s.tasks.find((t) => t.id === run.taskId)
            if (!task) return Either.right(null)
            run.status = "failed"
            run.exitCode = null
            run.endedAt = now
            task.status = "failed"
            task.updatedAt = now
            const message: Message = {
              id: newId(),
              taskId: task.id,
              role: "system",
              text: `Run could not start: ${reason}`,
              runId,
              createdAt: now,
            }
            s.messages.push(message)
            return Either.right({ run: { ...run }, task: { ...task }, message })
          })
          if (outcome === null) return
          publish({ _tag: "message.created", message: outcome.message })
          publish({ _tag: "run.updated", run: outcome.run })
          publish({ _tag: "task.updated", task: outcome.task })
        }),

      stopAll: () =>
        Effect.forEach([...active.keys()], (runId) => shape.cancel(runId).pipe(Effect.ignore), {
          discard: true,
        }),
    }
    return shape
  }),
)
