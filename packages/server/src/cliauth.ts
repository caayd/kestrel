import { Context, Effect, Layer } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  BadRequest,
  InternalError,
  type CliAuthStatus,
  type CliLoginStart,
  type CliProvider,
} from "@cloudagents/protocol"
import { Config } from "./config"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "./process"
import { cliBwrapArgs, findExecutable } from "./sandbox"

/*
 * Per-user subscription logins of the agent CLIs (Claude Pro/Max, ChatGPT). Each signed-in user's
 * login is written by the unmodified CLI into `<dataDir>/users/<login>/<provider dir>`; the CLI
 * itself reads and refreshes it. Only a login flag, an account label and the provider's own sign-in
 * link or device code leave this module: never tokens, key fragments or file contents.
 */

const USER_PATTERN = /^[A-Za-z0-9-]{1,39}$/
const STATUS_TIMEOUT_MS = 15_000
const LINK_TIMEOUT_MS = 20_000
const CODE_TIMEOUT_MS = 60_000
/** A sign-in that is not finished within this is killed. */
const PENDING_TTL_MS = 15 * 60_000
const CODE_MAX = 512
/**
 * The CLI's reply to a code it will not accept (it asks again instead of exiting). Observed: "Invalid code. Please make
 * sure the full code was copied."; anything else counts as success only once the CLI exits 0.
 */
const CODE_REJECTED = /\b(Invalid code|OAuth error)\b/i
const MESSAGE_MAX = 200

const PROVIDERS: ReadonlyArray<CliProvider> = ["claude-cli", "codex-cli"]

interface ProviderSpec {
  /** Directory under the user's root that the CLI uses as its config home. */
  readonly dir: string
  readonly bin: string
  readonly status: ReadonlyArray<string>
  readonly login: ReadonlyArray<string>
  readonly logout: ReadonlyArray<string>
}

const SPECS: Record<CliProvider, ProviderSpec> = {
  "claude-cli": {
    dir: "claude",
    bin: "claude",
    status: ["auth", "status", "--json"],
    login: ["auth", "login"],
    logout: ["auth", "logout"],
  },
  "codex-cli": {
    dir: "codex",
    bin: "codex",
    status: ["login", "status"],
    login: ["login", "--device-auth"],
    logout: ["logout"],
  },
}

/** A provider the user is logged in to, with the host directory holding that login. */
export interface CliLoginDir {
  readonly provider: CliProvider
  readonly dir: string
}

export interface CliAuthShape {
  readonly status: (user: string) => Effect.Effect<ReadonlyArray<CliAuthStatus>, BadRequest | InternalError>
  readonly startLogin: (user: string, provider: CliProvider) => Effect.Effect<CliLoginStart, BadRequest | InternalError>
  readonly submitCode: (
    user: string,
    provider: CliProvider,
    code: string,
  ) => Effect.Effect<CliAuthStatus, BadRequest | InternalError>
  readonly logout: (user: string, provider: CliProvider) => Effect.Effect<void, BadRequest | InternalError>
  /** The providers `user` is logged in to; a sandboxed run binds these directories in. */
  readonly loggedInDirs: (user: string) => Effect.Effect<ReadonlyArray<CliLoginDir>, BadRequest | InternalError>
  /** Kills sign-ins still waiting for the user; called on box shutdown. */
  readonly shutdown: () => Effect.Effect<void>
}

export class CliAuth extends Context.Tag("cloudagents/CliAuth")<CliAuth, CliAuthShape>() {}

interface Output {
  readonly stdout: string
  readonly stderr: string
}

/** A concrete process to run: the CLI itself, or bwrap wrapping it. */
interface Invocation {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

/** Runs a CLI. Non-zero exits still yield output (both CLIs exit 1 when logged out); null when not installed. */
const runCli = (inv: Invocation, label: string): Effect.Effect<Output | null, InternalError> =>
  Effect.async<Output | null, InternalError>((resume) => {
    execFile(inv.file, [...inv.args], { env: { ...inv.env }, timeout: STATUS_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resume(Effect.succeed(null))
      if (err && err.killed) return resume(Effect.fail(new InternalError({ message: `${label}: timed out` })))
      resume(Effect.succeed({ stdout, stderr }))
    })
  })

const parseClaudeStatus = (out: Output): Effect.Effect<CliAuthStatus, InternalError> =>
  Effect.gen(function* () {
    let parsed: unknown
    try {
      parsed = JSON.parse(out.stdout)
    } catch {
      return yield* Effect.fail(new InternalError({ message: "claude auth status: unreadable output" }))
    }
    if (typeof parsed !== "object" || parsed === null || !("loggedIn" in parsed) || typeof parsed.loggedIn !== "boolean") {
      return yield* Effect.fail(new InternalError({ message: "claude auth status: unexpected output" }))
    }
    const field = (name: string): string | null => {
      const value = (parsed as Record<string, unknown>)[name]
      return typeof value === "string" && value !== "" ? value : null
    }
    // claude.ai logins carry email/orgName; API-key logins only an auth method.
    const account = parsed.loggedIn ? (field("email") ?? field("orgName") ?? field("authMethod")) : null
    return { provider: "claude-cli", loggedIn: parsed.loggedIn, account }
  })

const parseCodexStatus = (out: Output): Effect.Effect<CliAuthStatus, InternalError> =>
  Effect.gen(function* () {
    const text = `${out.stdout}\n${out.stderr}`
    if (/^Not logged in/m.test(text)) return { provider: "codex-cli", loggedIn: false, account: null }
    // e.g. "Logged in using ChatGPT", "Logged in using an API key - sk-…": the part after " - " is
    // a key fragment and is dropped.
    const match = /^Logged in using (?:an? )?(.+?)(?: - .*)?$/m.exec(text)
    if (!match) return yield* Effect.fail(new InternalError({ message: "codex login status: unexpected output" }))
    return { provider: "codex-cli", loggedIn: true, account: match[1] ?? null }
  })

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

/** The sign-in link (and, for codex, the device code) once the CLI has printed them; null until then. */
const parseLink = (provider: CliProvider, text: string): { url: string; userCode: string | null } | null => {
  const clean = stripAnsi(text)
  if (provider === "claude-cli") {
    // The line ends with the link, so a half-written link is not taken.
    const url = /https:\/\/[^\s]*claude\.(?:com|ai)\/[^\s]*(?=\r?\n)/.exec(clean)?.[0]
    return url === undefined ? null : { url, userCode: null }
  }
  const lines = clean.split(/\r?\n/).map((line) => line.trim())
  const url = lines.map((line) => /^https:\/\/auth\.openai\.com\/\S*$/.exec(line)?.[0]).find((u) => u !== undefined)
  const at = lines.findIndex((line) => /one-time code/i.test(line))
  const userCode = at < 0 ? undefined : lines.slice(at + 1).find((line) => line !== "")
  if (url === undefined || userCode === undefined || !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(userCode)) return null
  return { url, userCode }
}

/** Last meaningful CLI output line, with links and the submitted code hidden, capped for an error message. */
const lastLine = (text: string, secrets: ReadonlyArray<string>): string => {
  const redacted = secrets.reduce(
    (acc, secret) => acc.split(secret).join("<code>"),
    stripAnsi(text).replace(/https?:\/\/\S+/g, "<link>"),
  )
  const line = redacted
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop()
  return (line ?? "").slice(0, MESSAGE_MAX)
}

interface Pending {
  readonly key: string
  readonly child: ChildProcess
  /** Everything the CLI has printed so far (stdout and stderr). */
  output: string
  /** Resolves with the exit code once the process has closed (null when it never started). */
  readonly done: Promise<number | null>
  /** Run after each chunk of output and on close; wakes whoever is waiting. */
  readonly listeners: Set<() => void>
  timer: NodeJS.Timeout
}

/** Resolves with the first parse of the output that succeeds, or null on close or timeout. */
const waitFor = <A>(entry: Pending, parse: (text: string) => A | null, timeoutMs: number): Promise<A | null> => {
  const { promise, resolve } = Promise.withResolvers<A | null>()
  const finish = (value: A | null) => {
    clearTimeout(timer)
    entry.listeners.delete(check)
    resolve(value)
  }
  const check = () => {
    const found = parse(entry.output)
    if (found !== null) finish(found)
  }
  const timer = setTimeout(() => finish(null), timeoutMs)
  entry.listeners.add(check)
  void entry.done.then(() => finish(parse(entry.output)))
  check()
  return promise
}

export const CliAuthLive = Layer.effect(
  CliAuth,
  Effect.gen(function* () {
    const config = yield* Config
    const pending = new Map<string, Pending>()
    const keyOf = (user: string, provider: CliProvider) => `${user}\0${provider}`

    const killEntry = (entry: Pending) => {
      clearTimeout(entry.timer)
      if (pending.get(entry.key) === entry) pending.delete(entry.key)
      killProcessGroup(entry.child.pid, "SIGKILL")
    }

    // Sign-ins are children of the box; a box exiting must not leave them running.
    process.on("exit", () => {
      for (const entry of pending.values()) killProcessGroup(entry.child.pid, "SIGKILL")
    })

    /** The user's root, which is also the CLIs' HOME. Only plain logins name a directory. */
    const rootOf = (user: string): Effect.Effect<string, BadRequest> =>
      USER_PATTERN.test(user)
        ? Effect.succeed(join(config.dataDir, "users", user))
        : Effect.fail(new BadRequest({ message: "signed-in user is not a valid login" }))

    const providerDir = (user: string, provider: CliProvider): Effect.Effect<string, BadRequest> =>
      Effect.map(rootOf(user), (root) => join(root, SPECS[provider].dir))

    const ensureDir = (path: string): Effect.Effect<void, InternalError> =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(path, { recursive: true, mode: 0o700 })
          await chmod(path, 0o700)
        },
        catch: () => new InternalError({ message: "cannot create the sign-in directory" }),
      })

    const ensureUserDirs = (user: string, provider: CliProvider): Effect.Effect<void, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const root = yield* rootOf(user)
        yield* ensureDir(join(config.dataDir, "users"))
        yield* ensureDir(root)
        yield* ensureDir(yield* providerDir(user, provider))
      })

    /** Environment for running a CLI as `user`: their HOME and config dirs, never the box user's login. */
    const cliEnv = (user: string): Effect.Effect<Record<string, string>, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const root = yield* rootOf(user)
        const path = config.sandboxPath ?? (config.sandboxEnabled ? null : (process.env.PATH ?? "/usr/bin:/bin"))
        if (path === null) {
          return yield* Effect.fail(
            new InternalError({ message: "CLOUDAGENTS_SANDBOX_PATH is not set; the agent CLIs are not on the toolchain" }),
          )
        }
        const ssl = config.sandboxSslCertFile
        return {
          PATH: path,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, SPECS["claude-cli"].dir),
          CODEX_HOME: join(root, SPECS["codex-cli"].dir),
          BROWSER: "/bin/false",
          NO_COLOR: "1",
          ...(ssl === null ? {} : { SSL_CERT_FILE: ssl, NIX_SSL_CERT_FILE: ssl }),
        }
      })

    /**
     * How to run `bin args` for `user`: inside bwrap with only the user's dir writable, so it dies with the box and
     * sees nothing else of the host; directly only when the sandbox is disabled (local debugging).
     */
    const invoke = (
      user: string,
      bin: string,
      args: ReadonlyArray<string>,
    ): Effect.Effect<Invocation, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const env = yield* cliEnv(user)
        if (!config.sandboxEnabled) return { file: bin, args, env }
        const bwrap = findExecutable("bwrap")
        if (bwrap === null) return yield* Effect.fail(new InternalError({ message: "bwrap (bubblewrap) not found on PATH" }))
        const root = yield* rootOf(user)
        return { file: bwrap, args: cliBwrapArgs(root, env, [bin, ...args]), env: {} }
      })

    const readStatus = (user: string, provider: CliProvider): Effect.Effect<CliAuthStatus, BadRequest | InternalError> =>
      Effect.gen(function* () {
        // No directory means no login: skip spawning the CLI.
        const dir = yield* providerDir(user, provider)
        const present = yield* Effect.promise(() => stat(dir).then((s) => s.isDirectory(), () => false))
        if (!present) return { provider, loggedIn: false, account: null }
        const inv = yield* invoke(user, SPECS[provider].bin, SPECS[provider].status)
        const out = yield* runCli(inv, `${SPECS[provider].bin} status`)
        if (out === null) return { provider, loggedIn: false, account: null }
        return provider === "claude-cli" ? yield* parseClaudeStatus(out) : yield* parseCodexStatus(out)
      })

    const status = (user: string) =>
      Effect.all(
        PROVIDERS.map((provider) => readStatus(user, provider)),
        { concurrency: "unbounded" },
      )

    const startLogin = (user: string, provider: CliProvider): Effect.Effect<CliLoginStart, BadRequest | InternalError> =>
      Effect.gen(function* () {
        const spec = SPECS[provider]
        yield* ensureUserDirs(user, provider)
        const key = keyOf(user, provider)
        const previous = pending.get(key)
        if (previous) killEntry(previous)
        const inv = yield* invoke(user, spec.bin, spec.login)
        const child = yield* Effect.try({
          try: () =>
            ownGroup(spawn(inv.file, [...inv.args], { env: { ...inv.env }, stdio: ["pipe", "pipe", "pipe"], detached: NEW_PROCESS_GROUP })),
          catch: () => new InternalError({ message: `${spec.bin} could not be started` }),
        })
        child.stdin?.on("error", () => {})
        const { promise: done, resolve: settle } = Promise.withResolvers<number | null>()
        child.once("error", () => settle(null))
        child.once("close", (code) => settle(code))
        const expiresAt = Date.now() + PENDING_TTL_MS
        const entry: Pending = {
          key,
          child,
          output: "",
          done,
          listeners: new Set(),
          timer: setTimeout(() => killEntry(entry), PENDING_TTL_MS),
        }
        const onChunk = (chunk: Buffer) => {
          entry.output += chunk.toString("utf8")
          for (const listener of entry.listeners) listener()
        }
        child.stdout?.on("data", onChunk)
        child.stderr?.on("data", onChunk)
        child.on("close", () => {
          clearTimeout(entry.timer)
          if (pending.get(key) === entry) pending.delete(key)
          for (const listener of entry.listeners) listener()
        })
        pending.set(key, entry)

        const link = yield* Effect.promise(() => waitFor(entry, (text) => parseLink(provider, text), LINK_TIMEOUT_MS))
        if (link === null) {
          killEntry(entry)
          const detail = lastLine(entry.output, [])
          return yield* Effect.fail(
            new InternalError({ message: `${spec.bin} did not print a sign-in link${detail === "" ? "" : `: ${detail}`}` }),
          )
        }
        return {
          provider,
          url: link.url,
          userCode: link.userCode,
          needsCode: provider === "claude-cli",
          expiresAt: new Date(expiresAt).toISOString(),
        }
      })

    const submitCode = (
      user: string,
      provider: CliProvider,
      code: string,
    ): Effect.Effect<CliAuthStatus, BadRequest | InternalError> =>
      Effect.gen(function* () {
        yield* rootOf(user)
        if (provider !== "claude-cli") {
          return yield* Effect.fail(
            new BadRequest({ message: "codex-cli signs in with a device code on the provider's page; there is no code to submit" }),
          )
        }
        const text = code.trim()
        if (text === "") return yield* Effect.fail(new BadRequest({ message: "code is empty" }))
        if (/[\r\n]/.test(text) || text.length > CODE_MAX) {
          return yield* Effect.fail(new BadRequest({ message: "code must be one line of at most 512 characters" }))
        }
        const entry = pending.get(keyOf(user, provider))
        if (!entry) {
          return yield* Effect.fail(new BadRequest({ message: "no sign-in is pending for claude-cli; start one first" }))
        }
        const before = entry.output.length
        entry.child.stdin?.write(`${text}\n`)
        // A rejected code gets the CLI's answer while the sign-in stays pending, so the user can retry;
        // the CLI does not exit on rejection.
        const rejection = yield* Effect.promise(() =>
          waitFor(
            entry,
            (output) => {
              const reply = output.slice(before)
              return CODE_REJECTED.test(reply) ? lastLine(reply, [text]) : null
            },
            CODE_TIMEOUT_MS,
          ),
        )
        if (rejection !== null) return yield* Effect.fail(new BadRequest({ message: rejection }))
        // An accepted code ends the CLI with exit 0; no exit by now means it did not answer in time.
        if (entry.child.exitCode === null) {
          killEntry(entry)
          return yield* Effect.fail(new InternalError({ message: "claude: the code was not checked in time" }))
        }
        if (entry.child.exitCode !== 0) {
          const detail = lastLine(entry.output.slice(before), [text])
          return yield* Effect.fail(new BadRequest({ message: detail === "" ? "the code was rejected" : detail }))
        }
        return yield* readStatus(user, provider)
      })

    const logout = (user: string, provider: CliProvider): Effect.Effect<void, BadRequest | InternalError> =>
      Effect.gen(function* () {
        yield* rootOf(user)
        const current = pending.get(keyOf(user, provider))
        if (current) killEntry(current)
        const dir = yield* providerDir(user, provider)
        const present = yield* Effect.promise(() => stat(dir).then((s) => s.isDirectory(), () => false))
        // Revoke with the CLI when there is a login to revoke; a failed revoke still removes the local login.
        if (present) {
          const inv = yield* invoke(user, SPECS[provider].bin, SPECS[provider].logout)
          yield* runCli(inv, `${SPECS[provider].bin} logout`).pipe(Effect.ignore)
        }
        yield* Effect.tryPromise({
          try: () => rm(dir, { recursive: true, force: true }),
          catch: () => new InternalError({ message: "cannot remove the sign-in directory" }),
        })
      })

    const loggedInDirs = (user: string): Effect.Effect<ReadonlyArray<CliLoginDir>, BadRequest | InternalError> =>
      Effect.map(
        Effect.all(
          PROVIDERS.map((provider) =>
            Effect.flatMap(readStatus(user, provider), (s) =>
              s.loggedIn
                ? Effect.map(providerDir(user, provider), (dir): CliLoginDir | null => ({ provider, dir }))
                : Effect.succeed(null),
            ).pipe(
              // A status check that fails must not block runs: the run falls back to the broker's keys.
              Effect.catchAll((e) =>
                Effect.as(Effect.logWarning(`${provider} status for ${user} failed: ${e.message}`), null),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
        (dirs) => dirs.filter((d): d is CliLoginDir => d !== null),
      )

    const shutdown = () =>
      Effect.sync(() => {
        for (const entry of [...pending.values()]) killEntry(entry)
      })

    return { status, startLogin, submitCode, logout, loggedInDirs, shutdown }
  }),
)
