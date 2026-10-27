import { Effect } from "effect"
import { spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { InternalError } from "@cloudagents/protocol"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup, platformEnv, shell } from "../process"
import { ensureTaskNet, joinTaskNet } from "./netns"
import { applyTaskLimits, busEnv, scopeArgs, type LaunchKind, type SystemdSettings } from "./systemd"

export { stopAllTaskNets, stopTaskNet } from "./netns"
export { initBox, removeTask, type LaunchKind, type SystemdSettings } from "./systemd"

/** Where the per-task home is mounted inside the sandbox. */
export const SANDBOX_HOME = "/home/agent"

/** Host paths exposed read-only when present; enough for DNS, TLS and passwd lookups. */
const SYSTEM_RO_FILES = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ssl",
]

/** A host dir bound read-write at a path inside the sandbox. */
export interface SandboxBind {
  readonly host: string
  readonly sandbox: string
}

export interface BwrapOptions {
  readonly worktreePath: string
  /** Git common dir of the task's repo (worktrees need it for index/refs). Absolute. */
  readonly gitCommonDir: string
  /** Host dir for the persisted per-task home, bound rw at /home/agent. */
  readonly homeDir: string
  /** X display number of the task desktop; its socket is bound when given. */
  readonly display?: number
  /** Exact environment of the sandboxed process. Nothing else from the host is passed. */
  readonly env: Readonly<Record<string, string>>
  readonly command: string
  /** Extra host paths mounted read-only at the same location (fake agent only). */
  readonly roBinds?: ReadonlyArray<string>
  /** Host dirs bound read-write inside the sandbox (a signed-in user's CLI logins). */
  readonly binds?: ReadonlyArray<SandboxBind>
}

/** Returns the full argv, starting with the `bwrap` executable name. */
export const buildBwrapArgv = (opts: BwrapOptions): string[] => {
  const argv: string[] = [
    "bwrap",
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    // The network is the task's own namespace, which the launch joins before bwrap (see netns.ts).
    "--share-net",
    // That namespace maps the box user to root; keep the agent on the box user's own ids (agent CLIs refuse root).
    "--uid",
    String(process.getuid?.() ?? 0),
    "--gid",
    String(process.getgid?.() ?? 0),
    "--clearenv",
    "--ro-bind",
    "/nix/store",
    "/nix/store",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // Nothing under /home is visible except the task home and the worktree binds below.
    "--tmpfs",
    "/home",
    "--bind",
    opts.homeDir,
    SANDBOX_HOME,
    "--bind",
    opts.worktreePath,
    opts.worktreePath,
    "--bind",
    opts.gitCommonDir,
    opts.gitCommonDir,
  ]
  for (const bind of opts.binds ?? []) argv.push("--bind", bind.host, bind.sandbox)
  // The agent commits through the shared git dir, but must not control what host-side git runs:
  // repo config (fsmonitor, filters, diff drivers, ...) and hooks stay read-only, other tasks'
  // worktree admin dirs are read-only, and this task's admin dir keeps its `commondir`/`gitdir`
  // pointers read-only so they cannot redirect host git to an agent-made git dir.
  for (const name of ["config", "hooks"]) {
    const path = join(opts.gitCommonDir, name)
    if (existsSync(path)) argv.push("--ro-bind", path, path)
  }
  const adminRoot = join(opts.gitCommonDir, "worktrees")
  const adminDir = join(adminRoot, basename(opts.worktreePath))
  if (existsSync(adminRoot)) argv.push("--ro-bind", adminRoot, adminRoot)
  if (existsSync(adminDir)) argv.push("--bind", adminDir, adminDir)
  for (const name of ["commondir", "gitdir"]) {
    const path = join(adminDir, name)
    if (existsSync(path)) argv.push("--ro-bind", path, path)
  }
  for (const path of opts.roBinds ?? []) argv.push("--ro-bind", path, path)
  for (const file of SYSTEM_RO_FILES) {
    if (existsSync(file)) argv.push("--ro-bind", file, file)
  }
  if (opts.display !== undefined) {
    const socket = x11Socket(opts.display)
    argv.push("--bind", socket, socket)
  }
  for (const [name, value] of Object.entries(opts.env)) argv.push("--setenv", name, value)
  argv.push("--chdir", opts.worktreePath, "--", "sh", "-c", opts.command)
  return argv
}

/**
 * bwrap args (without the executable) that run `command` with only `homeDir` writable: for the agent CLIs' own
 * sign-in/status/logout on the box. The process dies with the box (--die-with-parent) and sees nothing of the host
 * beyond /nix/store and the DNS/TLS files.
 */
export const cliBwrapArgs = (
  homeDir: string,
  env: Readonly<Record<string, string>>,
  command: ReadonlyArray<string>,
): string[] => {
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--share-net",
    "--clearenv",
    "--ro-bind",
    "/nix/store",
    "/nix/store",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--bind",
    homeDir,
    homeDir,
  ]
  for (const file of SYSTEM_RO_FILES) {
    if (existsSync(file)) argv.push("--ro-bind", file, file)
  }
  for (const [name, value] of Object.entries(env)) argv.push("--setenv", name, value)
  argv.push("--chdir", homeDir, "--", ...command)
  return argv
}

export const x11Socket = (display: number): string => `/tmp/.X11-unix/X${display}`

/** Parses ":101" into 101 when the desktop socket exists on the host. */
export const displayNumber = (display: string | null): number | undefined => {
  const match = display === null ? null : /^:(\d+)$/.exec(display)
  if (!match) return undefined
  const n = Number(match[1])
  return existsSync(x11Socket(n)) ? n : undefined
}

export interface SandboxSettings {
  /** False only with `CLOUDAGENTS_SANDBOX=0` (local debugging). */
  readonly enabled: boolean
  /** `CLOUDAGENTS_SANDBOX_PATH`; required when enabled. */
  readonly binPath: string | null
  /** `CLOUDAGENTS_SANDBOX_SSL`: CA bundle path, exposed as SSL_CERT_FILE. */
  readonly sslCertFile: string | null
  /** Per-task systemd resource limits; null only with `CLOUDAGENTS_SYSTEMD=0`. */
  readonly systemd: SystemdSettings | null
  /** Box HTTP port, forwarded into each task's network namespace for the broker and MCP. */
  readonly boxPort: number
}

export interface LaunchRequest {
  readonly settings: SandboxSettings
  /** Task the process belongs to; its systemd slice carries the resource limits. */
  readonly taskId: string
  readonly kind: LaunchKind
  readonly worktreePath: string
  readonly homeDir: string
  /** X display string (e.g. ":101") of the task desktop, or null. */
  readonly display: string | null
  /**
   * Git common dir of the task's repo, derived from server state (never from the worktree,
   * whose `.git` file the agent can rewrite).
   */
  readonly gitCommonDir: string
  /** Variables beyond the base allowlist (CLOUDAGENTS_*, broker env). Never host env. */
  readonly env: Readonly<Record<string, string>>
  readonly command: string
  readonly roBinds?: ReadonlyArray<string>
  /** Host dirs bound read-write inside the sandbox (a signed-in user's CLI logins). */
  readonly binds?: ReadonlyArray<SandboxBind>
}

export interface Launch {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** HOME as the process sees it (`/home/agent` when sandboxed). */
  readonly home: string
}

/** HOME as seen by the launched process; use it to build paths the process reads. */
export const agentHome = (settings: SandboxSettings, homeDir: string): string =>
  settings.enabled ? SANDBOX_HOME : homeDir

export const sandboxSettingsOf = (config: {
  readonly sandboxEnabled: boolean
  readonly sandboxPath: string | null
  readonly sandboxSslCertFile: string | null
  readonly systemd: SystemdSettings | null
  readonly port: number
}): SandboxSettings => ({
  enabled: config.sandboxEnabled,
  binPath: config.sandboxPath,
  sslCertFile: config.sandboxSslCertFile,
  systemd: config.systemd,
  boxPort: config.port,
})

export const findExecutable = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Turns a launch request into the concrete process to spawn. Sandboxed launches join the task's
 * network namespace (`nsenter`, started on first use) and run in bubblewrap; the env inside is
 * exactly the base allowlist plus `req.env`. With systemd limits on, the process starts through
 * `systemd-run --scope` in the task's slice. systemd-run and nsenter exec in place, so the spawned
 * pid is still the sandbox's and process-group signals reach it.
 */
export const prepareLaunch = (req: LaunchRequest): Effect.Effect<Launch, InternalError> =>
  Effect.gen(function* () {
    const { settings } = req
    if (settings.enabled && settings.binPath === null) {
      return yield* Effect.fail(
        new InternalError({
          message:
            "CLOUDAGENTS_SANDBOX_PATH is not set; start the box with `nix run .#box` or inside `nix develop` (or set CLOUDAGENTS_SANDBOX=0 for local debugging)",
        }),
      )
    }
    const bwrap = settings.enabled ? findExecutable("bwrap") : null
    if (settings.enabled && bwrap === null) {
      return yield* Effect.fail(
        new InternalError({ message: "bwrap (bubblewrap) not found on PATH; run inside `nix develop` or `nix run .#box`" }),
      )
    }
    const systemdRun = settings.systemd ? findExecutable("systemd-run") : null
    if (settings.systemd && systemdRun === null) {
      return yield* Effect.fail(
        new InternalError({ message: "systemd-run not found on PATH (set CLOUDAGENTS_SYSTEMD=0 to run without limits)" }),
      )
    }
    const pasta = settings.enabled ? findExecutable("pasta") : null
    const nsenter = settings.enabled ? findExecutable("nsenter") : null
    if (settings.enabled && (pasta === null || nsenter === null)) {
      return yield* Effect.fail(
        new InternalError({ message: "pasta (passt) and nsenter (util-linux) must be on PATH; run inside `nix develop` or `nix run .#box`" }),
      )
    }
    if (settings.systemd) yield* applyTaskLimits(settings.systemd, req.taskId)
    yield* Effect.tryPromise({
      try: () => mkdir(req.homeDir, { recursive: true }),
      catch: (e) => new InternalError({ message: `cannot create home ${req.homeDir}: ${String(e)}` }),
    })
    const home = agentHome(settings, req.homeDir)
    const env: Record<string, string> = {
      ...(settings.enabled ? {} : platformEnv()),
      PATH: settings.enabled ? (settings.binPath as string) : (process.env.PATH ?? "/usr/bin:/bin"),
      HOME: home,
      TERM: process.env.TERM ?? "xterm",
      ...(settings.sslCertFile
        ? { SSL_CERT_FILE: settings.sslCertFile, NIX_SSL_CERT_FILE: settings.sslCertFile }
        : {}),
      ...(req.display ? { DISPLAY: req.display } : {}),
      ...req.env,
    }

    const inner: { file: string; args: string[] } = settings.enabled
      ? yield* Effect.map(
          ensureTaskNet({
            taskId: req.taskId,
            boxPort: settings.boxPort,
            pastaPath: pasta as string,
            sleepPath: join(settings.binPath as string, "sleep"),
            systemd: settings.systemd ? { settings: settings.systemd, systemdRun: systemdRun as string } : null,
          }),
          (holder) => {
            const [file, ...args] = joinTaskNet(nsenter as string, holder)
            const bwrapArgs = buildBwrapArgv({
              worktreePath: req.worktreePath,
              gitCommonDir: req.gitCommonDir,
              homeDir: req.homeDir,
              display: displayNumber(req.display),
              env,
              command: req.command,
              roBinds: req.roBinds,
              binds: req.binds,
            }).slice(1)
            return { file: file as string, args: [...args, bwrap as string, ...bwrapArgs] }
          },
        )
      : { file: shell(), args: ["-c", req.command] }

    if (settings.systemd === null) return { ...inner, env, cwd: req.worktreePath, home }

    return {
      file: systemdRun as string,
      args: [...scopeArgs(settings.systemd, req.taskId, req.kind), inner.file, ...inner.args],
      // systemd-run needs the user bus; bwrap's --clearenv keeps it out of the sandbox.
      env: { ...env, ...busEnv() },
      cwd: req.worktreePath,
      home,
    }
  })

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a process in its own process group; timeout or interruption kills the whole group. */
export const runProcess = (
  file: string,
  args: ReadonlyArray<string>,
  opts: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs?: number },
): Effect.Effect<ProcessResult, InternalError> =>
  Effect.async<ProcessResult, InternalError>((resume) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (effect: Effect.Effect<ProcessResult, InternalError>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resume(effect)
    }
    const child = ownGroup(
      spawn(file, [...args], {
        cwd: opts.cwd,
        env: { ...opts.env },
        detached: NEW_PROCESS_GROUP,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL")
        finish(Effect.fail(new InternalError({ message: `timed out after ${opts.timeoutMs}ms` })))
      }, opts.timeoutMs)
    }
    child.on("error", (err) => {
      finish(Effect.fail(new InternalError({ message: `${file} failed to start: ${err.message}` })))
    })
    child.on("close", (code) => {
      finish(Effect.succeed({ exitCode: code ?? -1, stdout, stderr }))
    })
    return Effect.sync(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      killProcessGroup(child.pid, "SIGKILL")
    })
  })
