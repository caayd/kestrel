import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi"
import { spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const WINDOWS = process.platform === "win32"

/**
 * `detached` for every spawn the box may later kill with {@link killProcessGroup}; pass the child through
 * {@link ownGroup} too. On POSIX the child leads a new process group. On Windows a detached child would get its
 * own console, and the group is a job object instead.
 */
export const NEW_PROCESS_GROUP = !WINDOWS

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: 144 bytes, BasicLimitInformation.LimitFlags at 16.
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const LIMIT_INFO_SIZE = 144
const LIMIT_FLAGS_OFFSET = 16
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001

const kernel32 = WINDOWS
  ? dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols
  : null

/** A Win32 HANDLE as bun:ffi returns it for `FFIType.ptr`. */
type Handle = Pointer | bigint

/** Job object of each live group leader, by pid (Windows only). */
const jobs = new Map<number, Handle>()

const setKillOnClose = (k: NonNullable<typeof kernel32>, job: Handle, on: boolean): boolean => {
  const info = new Uint8Array(LIMIT_INFO_SIZE)
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, on ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0, true)
  return k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(info), LIMIT_INFO_SIZE) !== 0
}

/**
 * Makes `child` (spawned with `detached: NEW_PROCESS_GROUP`) a group {@link killProcessGroup} can end. A no-op on
 * POSIX. On Windows the child goes into its own job object, which everything it starts inherits: MSYS `sh` breaks
 * the parent chain on fork/exec, so a process tree is not enough. Processes the child started before this call
 * are outside the job. While the child runs, the job dies with the box; once it exits, what it left running stays
 * up, as a process group would on POSIX.
 */
export const ownGroup = <C extends ChildProcess>(child: C): C => {
  const pid = child.pid
  const k = kernel32
  if (k === null || pid === undefined) return child
  const job = k.CreateJobObjectW(null, null)
  if (job === null) return child
  const proc = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
  const assigned = proc !== null && setKillOnClose(k, job, true) && k.AssignProcessToJobObject(job, proc) !== 0
  if (proc !== null) k.CloseHandle(proc)
  if (!assigned) {
    k.CloseHandle(job)
    return child
  }
  jobs.set(pid, job)
  child.once("exit", () => {
    jobs.delete(pid)
    setKillOnClose(k, job, false)
    k.CloseHandle(job)
  })
  return child
}

/** Kills a process spawned as a group (see {@link ownGroup}) and everything it started. */
export const killProcessGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (pid === undefined) return
  if (WINDOWS) {
    // No signals on Windows: the job, or the process tree when the job could not be set up, ends at once.
    const job = jobs.get(pid)
    if (job !== undefined && kernel32 !== null) kernel32.TerminateJobObject(job, 1)
    else spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // group already gone
  }
}

/** Git for Windows ships `sh` in `<root>/usr/bin`; its exec path is `<root>/mingw64/libexec/git-core`. */
const gitForWindowsSh = (): string | null => {
  const r = spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true })
  if (r.status !== 0) return null
  const sh = join(resolve(r.stdout.trim(), "../../.."), "usr", "bin", "sh.exe")
  return existsSync(sh) ? sh : null
}

let shPath: string | null = null

/**
 * POSIX `sh`: agent commands and `workspace_exec` are shell commands. On Windows it is the `sh` on PATH, else
 * the one that comes with Git for Windows; without either, spawning fails with ENOENT.
 */
export const shell = (): string => {
  if (!WINDOWS) return "sh"
  shPath ??= Bun.which("sh") ?? gitForWindowsSh() ?? "sh"
  return shPath
}

/**
 * Host variables an unsandboxed process needs on Windows: without `SystemRoot` even loopback sockets fail, and
 * programs look up temp dirs and executables through the others. Empty elsewhere.
 */
export const platformEnv = (): Record<string, string> => {
  if (!WINDOWS) return {}
  const env: Record<string, string> = {}
  for (const name of ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATHEXT", "ComSpec"]) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}
