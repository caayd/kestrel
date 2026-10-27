import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { Context, Data, Deferred, Effect, Layer } from "effect"
import type { DesktopInput, DesktopState, DesktopStatus } from "@cloudagents/protocol"
import { NEW_PROCESS_GROUP, killProcessGroup, ownGroup } from "../process"
import { avcCodecString, Mp4Splitter, type Mp4Piece } from "./fmp4"

export class DesktopError extends Data.TaggedError("DesktopError")<{ readonly message: string }> {}

export interface DesktopSink {
  onStatus(s: DesktopStatus): void
  onMedia(chunk: Uint8Array): void
}

/** A process prepared by the caller (sandboxed); the desktop only spawns and tracks it. */
export interface ProcessSpec {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

export interface DesktopStartOptions {
  /** Builds the terminal opened on a fresh desktop, given its X display (e.g. ":101"). */
  readonly terminal: (display: string) => Effect.Effect<ProcessSpec, DesktopError>
}

export class DesktopManager extends Context.Tag("cloudagents/DesktopManager")<
  DesktopManager,
  {
    readonly start: (taskId: string, opts: DesktopStartOptions) => Effect.Effect<DesktopStatus, DesktopError>
    readonly stop: (taskId: string) => Effect.Effect<void>
    readonly status: (taskId: string) => Effect.Effect<DesktopStatus>
    readonly screenshot: (taskId: string) => Effect.Effect<Uint8Array, DesktopError>
    readonly input: (taskId: string, event: DesktopInput) => Effect.Effect<void, DesktopError>
    /** Spawns an app on the live desktop; it is killed with the desktop. */
    readonly launch: (taskId: string, process: ProcessSpec) => Effect.Effect<void, DesktopError>
    readonly subscribe: (taskId: string, sink: DesktopSink) => Effect.Effect<Effect.Effect<void>, DesktopError>
    readonly watchStatus: (listener: (s: DesktopStatus) => void) => Effect.Effect<Effect.Effect<void>>
    readonly stopAll: () => Effect.Effect<void>
  }
>() {}

const WIDTH = 1280
const HEIGHT = 800
const FPS = 25
const FIRST_DISPLAY = 101
const LAST_DISPLAY = 199
const X_SOCKET_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 20_000
const TERM_GRACE_MS = 2_000
const COMMAND_TIMEOUT_MS = 15_000

interface Session {
  readonly taskId: string
  readonly num: number
  readonly display: string
  readonly terminal: DesktopStartOptions["terminal"]
  /** Completes when the init segment has been parsed (running) or fails. */
  readonly ready: Deferred.Deferred<void, DesktopError>
  /** Live child processes; each is a process-group leader (detached). */
  readonly procs: Set<ChildProcess>
  readonly sinks: Set<DesktopSink>
  readonly splitter: Mp4Splitter
  state: DesktopState
  error: string | null
  mime: string | null
  init: Uint8Array | null
  stderrTail: string
}

const toErr = (e: unknown): DesktopError =>
  e instanceof DesktopError ? e : new DesktopError({ message: e instanceof Error ? e.message : String(e) })

const pixel = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(v * max)))

/** One click per 50 units of wheel delta, between 1 and 10 clicks. */
const wheelClicks = (delta: number) => Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 50)))

const xdotoolArgs = (e: DesktopInput): string[] => {
  switch (e._tag) {
    case "mouse.move":
      return ["mousemove", String(pixel(e.x, WIDTH)), String(pixel(e.y, HEIGHT))]
    case "mouse.button":
      return [
        "mousemove",
        String(pixel(e.x, WIDTH)),
        String(pixel(e.y, HEIGHT)),
        e.down ? "mousedown" : "mouseup",
        String(e.button),
      ]
    case "mouse.wheel": {
      // X buttons: 4 = up, 5 = down, 6 = left, 7 = right.
      const args: string[] = []
      if (e.dy !== 0) args.push("click", "--repeat", String(wheelClicks(e.dy)), e.dy > 0 ? "5" : "4")
      if (e.dx !== 0) args.push("click", "--repeat", String(wheelClicks(e.dx)), e.dx > 0 ? "7" : "6")
      return args
    }
    case "key": {
      // "ctrl+c" presses ctrl then c, releases in reverse order.
      const parts = e.key.length > 1 ? e.key.split("+").filter((p) => p.length > 0) : [e.key]
      const ordered = e.down ? parts : [...parts].reverse()
      return ordered.flatMap((p) => [e.down ? "keydown" : "keyup", p])
    }
    case "text":
      return e.text.length === 0 ? [] : ["type", "--", e.text]
  }
}

const ffmpegArgs = (display: string): string[] => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "x11grab",
  "-framerate",
  String(FPS),
  "-video_size",
  `${WIDTH}x${HEIGHT}`,
  "-i",
  display,
  "-c:v",
  "libx264",
  "-profile:v",
  "baseline",
  "-tune",
  "zerolatency",
  "-preset",
  "ultrafast",
  "-pix_fmt",
  "yuv420p",
  "-g",
  String(FPS), // keyframe every ~1s
  "-keyint_min",
  String(FPS),
  "-sc_threshold",
  "0",
  "-r",
  String(FPS),
  "-an",
  "-f",
  "mp4",
  "-movflags",
  "empty_moov+default_base_moof+frag_keyframe",
  "pipe:1",
]

const waitExit = (p: ChildProcess, ms: number): Promise<void> => {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  p.once("exit", () => {
    clearTimeout(timer)
    resolve()
  })
  return promise
}

/** SIGTERM every process group, wait a grace period, then SIGKILL whatever is left. */
const terminate = async (procs: Iterable<ChildProcess>) => {
  const list = [...procs]
  for (const p of list) killProcessGroup(p.pid, "SIGTERM")
  await Promise.all(list.map((p) => waitExit(p, TERM_GRACE_MS)))
  for (const p of list) killProcessGroup(p.pid, "SIGKILL")
}

const waitForSocket = async (s: Session) => {
  const socket = `/tmp/.X11-unix/X${s.num}`
  const deadline = Date.now() + X_SOCKET_TIMEOUT_MS
  while (!existsSync(socket)) {
    if (s.state !== "starting") throw new Error(s.error ?? "Xvfb stopped before accepting connections")
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${socket}`)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 50)
    await promise
  }
}

const runCommand = (command: string, args: readonly string[], display: string) => {
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number; stdout: Buffer; stderr: string }>()
  const child = spawn(command, args, {
    env: { ...process.env, DISPLAY: display },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const out: Buffer[] = []
  let err = ""
  const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS)
  child.stdout.on("data", (d: Buffer) => out.push(d))
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString()
  })
  child.on("error", (e) => {
    clearTimeout(timer)
    reject(e)
  })
  child.on("close", (code) => {
    clearTimeout(timer)
    resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: err })
  })
  return promise
}

export const DesktopManagerLive: Layer.Layer<DesktopManager> = Layer.effect(
  DesktopManager,
  Effect.gen(function* () {
    const sessions = new Map<string, Session>()
    const watchers = new Set<(s: DesktopStatus) => void>()

    const toStatus = (taskId: string, s: Session | undefined): DesktopStatus => {
      const live = s !== undefined && s.state !== "stopped"
      return {
        taskId,
        state: s?.state ?? "stopped",
        display: live ? s.display : null,
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        mime: live ? s.mime : null,
        error: live ? s.error : null,
      }
    }

    const publish = (s: Session) => {
      const st = toStatus(s.taskId, s)
      for (const sink of s.sinks) sink.onStatus(st)
      for (const w of watchers) w(st)
    }

    const failSession = (s: Session, message: string) => {
      if (s.state !== "starting" && s.state !== "running") return
      const tail = s.stderrTail.trim().slice(-500)
      const full = tail ? `${message}: ${tail}` : message
      s.state = "failed"
      s.error = full
      Deferred.unsafeDone(s.ready, Effect.fail(new DesktopError({ message: full })))
      publish(s)
      void terminate(s.procs)
    }

    const onMediaBytes = (s: Session, data: Buffer) => {
      if (s.state !== "starting" && s.state !== "running") return
      let pieces: Mp4Piece[]
      try {
        pieces = s.splitter.push(data)
      } catch (e) {
        failSession(s, toErr(e).message)
        return
      }
      for (const piece of pieces) {
        if (piece.kind === "media") {
          for (const sink of s.sinks) sink.onMedia(piece.bytes)
          continue
        }
        const codec = avcCodecString(piece.bytes)
        if (codec === null) {
          failSession(s, "could not read H.264 codec from init segment")
          return
        }
        s.init = piece.bytes
        s.mime = `video/mp4; codecs="${codec}"`
        s.state = "running"
        Deferred.unsafeDone(s.ready, Effect.void)
        for (const sink of s.sinks) sink.onMedia(piece.bytes)
        publish(s)
      }
    }

    const spawnTracked = (
      s: Session,
      command: string,
      args: readonly string[],
      opts: {
        critical: boolean
        cwd?: string
        env?: Readonly<Record<string, string>>
        onStdout?: (d: Buffer) => void
      },
    ) => {
      const child = ownGroup(
        spawn(command, args, {
          cwd: opts.cwd,
          detached: NEW_PROCESS_GROUP,
          env: opts.env ? { ...opts.env } : { ...process.env, DISPLAY: s.display },
          stdio: ["ignore", opts.onStdout ? "pipe" : "ignore", "pipe"],
        }),
      )
      s.procs.add(child)
      child.stderr?.on("data", (d: Buffer) => {
        s.stderrTail = (s.stderrTail + d.toString()).slice(-4000)
      })
      child.stdout?.on("data", (d: Buffer) => opts.onStdout?.(d))
      child.on("error", (e) => {
        s.procs.delete(child)
        failSession(s, `${command}: ${e.message}`)
      })
      child.on("exit", (code, signal) => {
        s.procs.delete(child)
        if (opts.critical) failSession(s, `${command} exited (${code ?? signal})`)
      })
      return child
    }

    const pickDisplay = (): number => {
      const used = new Set([...sessions.values()].map((s) => s.num))
      for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
        if (!used.has(n) && !existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n
      }
      throw new Error(`no free X display in :${FIRST_DISPLAY}-:${LAST_DISPLAY}`)
    }

    const boot = (s: Session) =>
      Effect.gen(function* () {
        yield* Effect.try({
          // Only the /tmp/.X11-unix/X<n> file socket: sandboxes share the host network namespace, so the
          // abstract socket (`local`) would let every task's agent reach every display.
          try: () =>
            spawnTracked(
              s,
              "Xvfb",
              [s.display, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp", "-nolisten", "local"],
              { critical: true },
            ),
          catch: toErr,
        })
        yield* Effect.tryPromise({ try: () => waitForSocket(s), catch: toErr })
        yield* Effect.try({
          try: () => {
            spawnTracked(s, "openbox", ["--sm-disable"], { critical: false })
            spawnTracked(s, "ffmpeg", ffmpegArgs(s.display), {
              critical: true,
              onStdout: (d) => onMediaBytes(s, d),
            })
          },
          catch: toErr,
        })
        // The terminal is a convenience: a desktop without one still serves the agent.
        yield* s.terminal(s.display).pipe(
          Effect.flatMap((term) =>
            Effect.try({
              try: () => spawnTracked(s, term.file, term.args, { critical: false, cwd: term.cwd, env: term.env }),
              catch: toErr,
            }),
          ),
          Effect.catchAll((e) => Effect.logWarning(`desktop ${s.display}: no terminal: ${e.message}`)),
        )
        yield* Deferred.await(s.ready).pipe(
          Effect.timeoutFail({
            duration: READY_TIMEOUT_MS,
            onTimeout: () => new DesktopError({ message: "timed out waiting for desktop stream" }),
          }),
        )
        return toStatus(s.taskId, s)
      })

    const awaitReady = (s: Session) =>
      Deferred.await(s.ready).pipe(Effect.zipRight(Effect.sync(() => toStatus(s.taskId, s))))

    const stopTask = (taskId: string) =>
      Effect.gen(function* () {
        const s = sessions.get(taskId)
        if (!s) return
        sessions.delete(taskId)
        s.state = "stopped"
        s.error = null
        Deferred.unsafeDone(s.ready, Effect.fail(new DesktopError({ message: "desktop stopped" })))
        publish(s)
        s.sinks.clear()
        yield* Effect.promise(() => terminate(s.procs))
      })

    const lookup = (taskId: string) =>
      Effect.suspend((): Effect.Effect<Session, DesktopError> => {
        const s = sessions.get(taskId)
        return s
          ? Effect.succeed(s)
          : Effect.fail(new DesktopError({ message: `desktop for task ${taskId} is not running` }))
      })

    const requireLive = (taskId: string) =>
      Effect.flatMap(lookup(taskId), (s) =>
        s.state === "starting" || s.state === "running"
          ? Effect.succeed(s)
          : Effect.fail(new DesktopError({ message: `desktop for task ${taskId} is ${s.state}` })),
      )

    // Kill desktops on process exit even if shutdown hooks never ran.
    process.on("exit", () => {
      for (const s of sessions.values()) for (const p of s.procs) killProcessGroup(p.pid, "SIGKILL")
    })

    return DesktopManager.of({
      start: (taskId, opts) =>
        Effect.gen(function* () {
          if (process.platform !== "linux") {
            return yield* Effect.fail(new DesktopError({ message: "the task desktop needs Linux (Xvfb, x11grab)" }))
          }
          if (sessions.get(taskId)?.state === "failed") yield* stopTask(taskId)
          const ready = yield* Deferred.make<void, DesktopError>()
          const claim = yield* Effect.try({
            try: () => {
              const existing = sessions.get(taskId)
              if (existing) return { s: existing, created: false }
              // Synchronous reservation: no yield point between picking and registering the display.
              const num = pickDisplay()
              const s: Session = {
                taskId,
                num,
                display: `:${num}`,
                terminal: opts.terminal,
                ready,
                procs: new Set(),
                sinks: new Set(),
                splitter: new Mp4Splitter(),
                state: "starting",
                error: null,
                mime: null,
                init: null,
                stderrTail: "",
              }
              sessions.set(taskId, s)
              return { s, created: true }
            },
            catch: toErr,
          })
          if (!claim.created) return yield* awaitReady(claim.s)
          return yield* boot(claim.s).pipe(
            Effect.tapError((e) => Effect.sync(() => failSession(claim.s, e.message))),
          )
        }),

      stop: stopTask,

      status: (taskId) => Effect.sync(() => toStatus(taskId, sessions.get(taskId))),

      screenshot: (taskId) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const r = yield* Effect.tryPromise({
            try: () =>
              runCommand(
                "ffmpeg",
                [
                  "-hide_banner",
                  "-loglevel",
                  "error",
                  "-f",
                  "x11grab",
                  "-video_size",
                  `${WIDTH}x${HEIGHT}`,
                  "-i",
                  s.display,
                  "-frames:v",
                  "1",
                  "-f",
                  "image2pipe",
                  "-c:v",
                  "png",
                  "pipe:1",
                ],
                s.display,
              ),
            catch: toErr,
          })
          if (r.exitCode !== 0 || r.stdout.length === 0) {
            return yield* Effect.fail(new DesktopError({ message: `screenshot failed: ${r.stderr.trim()}` }))
          }
          return r.stdout
        }),

      input: (taskId, event) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          const args = xdotoolArgs(event)
          if (args.length === 0) return
          const r = yield* Effect.tryPromise({ try: () => runCommand("xdotool", args, s.display), catch: toErr })
          if (r.exitCode !== 0) {
            return yield* Effect.fail(new DesktopError({ message: `xdotool failed: ${r.stderr.trim()}` }))
          }
        }),

      launch: (taskId, proc) =>
        Effect.gen(function* () {
          const s = yield* requireLive(taskId)
          yield* Effect.try({
            try: () => {
              spawnTracked(s, proc.file, proc.args, { critical: false, cwd: proc.cwd, env: proc.env })
            },
            catch: toErr,
          })
        }),

      subscribe: (taskId, sink) =>
        Effect.gen(function* () {
          const s = yield* lookup(taskId)
          s.sinks.add(sink)
          sink.onStatus(toStatus(taskId, s))
          if (s.init) sink.onMedia(s.init)
          return Effect.sync(() => {
            s.sinks.delete(sink)
          })
        }),

      watchStatus: (listener) =>
        Effect.sync(() => {
          watchers.add(listener)
          return Effect.sync(() => {
            watchers.delete(listener)
          })
        }),

      stopAll: () =>
        Effect.gen(function* () {
          for (const taskId of [...sessions.keys()]) yield* stopTask(taskId)
        }),
    })
  }),
)
