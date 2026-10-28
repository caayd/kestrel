/**
 * @cloudagents/protocol — the single source of truth for wire types.
 *
 * Used by the server (Effect) and every client (web, later Electron).
 * Pure Effect Schema: no Node/DOM-specific imports here.
 */
import { Schema } from "effect"
import { BranchName, RepoRef } from "./refs"

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/**
 * idle          no run in flight
 * running       an agent run is executing in the worktree
 * needs_input   agent asked the user something (via MCP `task_report`)
 * done          agent reported completion
 * failed        last run exited non-zero
 */
export const TaskStatus = Schema.Literal("idle", "running", "needs_input", "done", "failed")
export type TaskStatus = typeof TaskStatus.Type

/** The GitHub pull request opened for a checkout's branch (see the `github_pr_create` MCP tool). */
export const PullRequestLink = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
})
export type PullRequestLink = typeof PullRequestLink.Type

/**
 * A repository the agent checked out into its thread's workspace (MCP `repo_checkout`, or `CreateTaskBody.checkout`).
 * Each checkout is a clone of its own, on a branch created for the thread; a thread has at most one checkout per repo.
 */
export const Checkout = Schema.Struct({
  /** Stable within the thread; names the checkout in `DiffResponse` and the GitHub MCP tools. */
  id: Schema.String,
  /** GitHub "owner/name" for github.com repositories, otherwise the https clone URL. */
  repo: Schema.String,
  /** Directory of the checkout, relative to the thread workspace (the agent's working directory), e.g. `kestrel`. */
  dir: Schema.String,
  /** Branch created for this thread, e.g. `cloudagents/fix-login-a1b2`. */
  branch: Schema.String,
  /** Branch the checkout forked from and pull requests target. */
  baseBranch: Schema.String,
  createdAt: Schema.String,
  /** Set once a pull request has been opened for `branch`; absent before that. */
  pullRequest: Schema.optional(PullRequestLink),
})
export type Checkout = typeof Checkout.Type

/**
 * A thread = one chat + one workspace directory + (optional) one desktop. It starts with no repository;
 * the agent checks repositories out into the workspace as the work needs them.
 */
export const Task = Schema.Struct({
  id: Schema.String,
  /** GitHub login of the user who started the thread. Only they can see or change it. */
  owner: Schema.String,
  title: Schema.String,
  status: TaskStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** Oldest first. Empty until the agent checks a repository out. */
  checkouts: Schema.Array(Checkout),
  /** Set while the thread is archived: its runtime is torn down and it accepts no new messages; absent otherwise. */
  archivedAt: Schema.optional(Schema.String),
})
export type Task = typeof Task.Type

/**
 * A file on a message: one the agent attached (e.g. a desktop screenshot) or one the user uploaded with
 * `Paths.taskUploads` and sent with `SendMessageBody.attachments`. Bytes are served by `Paths.taskAttachment`.
 */
export const Attachment = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  /** File name the user uploaded it under; absent for agent attachments. */
  name: Schema.optional(Schema.String),
})
export type Attachment = typeof Attachment.Type

/** Largest attachment the box stores, agent or user; a larger upload is refused with 400. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export const Message = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  role: Schema.Literal("user", "agent", "system"),
  text: Schema.String,
  runId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** Choices offered with a question (`task_ask`); the user answers by sending one of them. */
  options: Schema.optional(Schema.Array(Schema.String)),
  /** Files attached by the agent (e.g. a desktop screenshot). Optional so messages persisted before attachments decode. */
  attachments: Schema.optional(Schema.Array(Attachment)),
})
export type Message = typeof Message.Type

export const RunStatus = Schema.Literal("running", "succeeded", "failed", "cancelled")
export type RunStatus = typeof RunStatus.Type

/** One agent-harness invocation in a thread's workspace. */
export const Run = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  prompt: Schema.String,
  status: RunStatus,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
})
export type Run = typeof Run.Type

/**
 * One display item of an agent run, normalized from the harness's own stream (Claude
 * `stream-json`, Codex `exec --json`) so the app renders every harness the same way.
 * Ids are unique within a run; a later item with the same id replaces the earlier one
 * (a tool goes `running` -> `ok`/`error`).
 */
export const AgentItem = Schema.Union(
  /** Assistant prose; markdown, may contain inline HTML/SVG. */
  Schema.Struct({ _tag: Schema.Literal("text"), id: Schema.String, parentToolId: Schema.NullOr(Schema.String), text: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("thinking"), id: Schema.String, parentToolId: Schema.NullOr(Schema.String), text: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("tool"),
    id: Schema.String,
    /** Set when a subagent (e.g. Claude's Task tool) made this call; the id of that Task call. */
    parentToolId: Schema.NullOr(Schema.String),
    /** Harness tool name, e.g. "Bash", "mcp__cloudagents__desktop_screenshot", "command_execution". */
    name: Schema.String,
    input: Schema.Unknown,
    status: Schema.Literal("running", "ok", "error"),
    output: Schema.NullOr(Schema.String),
  }),
  /** End of one agent turn. Fields the harness does not report are null. */
  Schema.Struct({
    _tag: Schema.Literal("turn"),
    id: Schema.String,
    durationMs: Schema.NullOr(Schema.Number),
    inputTokens: Schema.NullOr(Schema.Number),
    outputTokens: Schema.NullOr(Schema.Number),
    costUsd: Schema.NullOr(Schema.Number),
    isError: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("error"), id: Schema.String, text: Schema.String }),
)
export type AgentItem = typeof AgentItem.Type

export const RunItems = Schema.Array(AgentItem)
export type RunItems = typeof RunItems.Type

/**
 * stopped   no X display / capture running
 * starting  Xvfb + openbox + ffmpeg being spawned
 * running   stream is live; `mime` is set and binary frames are flowing
 * failed    see `error`
 */
export const DesktopState = Schema.Literal("stopped", "starting", "running", "failed")
export type DesktopState = typeof DesktopState.Type

export const DesktopStatus = Schema.Struct({
  taskId: Schema.String,
  state: DesktopState,
  /** X display string, e.g. ":101". Null when stopped. Injected as DISPLAY into agent runs. */
  display: Schema.NullOr(Schema.String),
  width: Schema.Number,
  height: Schema.Number,
  fps: Schema.Number,
  /**
   * MIME + codec string for MediaSource, e.g. `video/mp4; codecs="avc1.42E01F"`.
   * Null until the stream is running. Clients MUST use this verbatim.
   */
  mime: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
export type DesktopStatus = typeof DesktopStatus.Type

/**
 * Client -> server input over the desktop WebSocket (JSON text frames).
 * Coordinates are normalized to [0, 1] relative to the stream frame so the
 * client never needs to know the X resolution.
 */
export const DesktopInput = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("mouse.move"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal("mouse.button"),
    x: Schema.Number,
    y: Schema.Number,
    /** 1 = left, 2 = middle, 3 = right */
    button: Schema.Literal(1, 2, 3),
    down: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("mouse.wheel"), dx: Schema.Number, dy: Schema.Number }),
  Schema.Struct({
    _tag: Schema.Literal("key"),
    /** X keysym name as understood by xdotool, e.g. "Return", "a", "ctrl+c" */
    key: Schema.String,
    down: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("text"), text: Schema.String }),
)
export type DesktopInput = typeof DesktopInput.Type

/**
 * Client -> server flow-control ack over the desktop WebSocket (JSON text frames, sent alongside `DesktopInput`).
 * `frames` is the cumulative count of binary frames (init segment and fragments) the client has received on this
 * connection. The client sends one every ~100 ms or every 6 frames, whichever comes first. The server throttles a
 * connection only after its first ack, so clients that never ack keep the unthrottled stream.
 */
export const DesktopAck = Schema.Struct({ _tag: Schema.Literal("stream.ack"), frames: Schema.Number })
export type DesktopAck = typeof DesktopAck.Type

/** Server -> client events over the task event WebSocket (JSON text frames). */
export const ServerEvent = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("task.updated"), task: Task }),
  Schema.Struct({ _tag: Schema.Literal("message.created"), message: Message }),
  Schema.Struct({ _tag: Schema.Literal("run.updated"), run: Run }),
  Schema.Struct({
    _tag: Schema.Literal("agent.output"),
    taskId: Schema.String,
    runId: Schema.String,
    /** "event" = harness-structured line (e.g. stream-json); "stdout"/"stderr" = raw. */
    stream: Schema.Literal("stdout", "stderr", "event"),
    text: Schema.String,
  }),
  /** A run's display item was added or replaced (same `item.id`). */
  Schema.Struct({ _tag: Schema.Literal("agent.item"), taskId: Schema.String, runId: Schema.String, item: AgentItem }),
  Schema.Struct({ _tag: Schema.Literal("desktop.updated"), desktop: DesktopStatus }),
)
export type ServerEvent = typeof ServerEvent.Type

// ---------------------------------------------------------------------------
// REST request / response bodies
// ---------------------------------------------------------------------------

/**
 * A repository to check out. `repo` is a GitHub "owner/name" (cloned from github.com with the owner's token)
 * or an https clone URL. The box keeps one mirror per repository per user and always fetches it first,
 * so a checkout starts from the remote tip.
 */
export const CheckoutRequest = Schema.Struct({
  repo: RepoRef,
  /** Branch to fork from. Defaults to the repository's default branch; with `pullRequest`, the pull request's base. */
  baseBranch: Schema.optional(BranchName),
  /**
   * Start at the head of this GitHub pull request (`refs/pull/<n>/head`) instead of `baseBranch`. `baseBranch`
   * stays the pull request's base (for opening a pull request); the checkout's diff is against the head it started at.
   */
  pullRequest: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
})
export type CheckoutRequest = typeof CheckoutRequest.Type

export const CreateTaskBody = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** Check this repository out before the first message, e.g. for an automation on a pull request. */
  checkout: Schema.optional(CheckoutRequest),
})
export type CreateTaskBody = typeof CreateTaskBody.Type

/** Model alias passed to the agent CLI (`--model`). */
export const AgentModel = Schema.Literal("opus", "sonnet", "haiku")
export type AgentModel = typeof AgentModel.Type

/** Thinking level passed to the agent CLI (`--effort`). */
export const AgentEffort = Schema.Literal("low", "medium", "high", "xhigh", "max")
export type AgentEffort = typeof AgentEffort.Type

export const SendMessageBody = Schema.Struct({
  /** May be empty when `attachments` is not. */
  text: Schema.String,
  /** Omitted = the harness default. */
  model: Schema.optional(AgentModel),
  effort: Schema.optional(AgentEffort),
  /**
   * Ids of attachments uploaded to this task with `Paths.taskUploads` and not yet sent. They move onto the new
   * message in this order; the agent gets each as a file in its sandbox, named in its prompt or `task_inbox`.
   */
  attachments: Schema.optional(Schema.Array(Schema.String)),
})
export type SendMessageBody = typeof SendMessageBody.Type

export const SendMessageResponse = Schema.Struct({ message: Message, run: Run })
export type SendMessageResponse = typeof SendMessageResponse.Type

/** Changes of one checkout: everything on its branch and in its working tree, against its fork point. */
export const CheckoutDiff = Schema.Struct({
  checkoutId: Schema.String,
  repo: Schema.String,
  dir: Schema.String,
  baseBranch: Schema.String,
  diff: Schema.String,
})
export type CheckoutDiff = typeof CheckoutDiff.Type

/** One entry per checkout, in `Task.checkouts` order; empty for a thread without checkouts. */
export const DiffResponse = Schema.Struct({ checkouts: Schema.Array(CheckoutDiff) })
export type DiffResponse = typeof DiffResponse.Type

export const Health = Schema.Struct({ ok: Schema.Literal(true), version: Schema.String })
export type Health = typeof Health.Type

// ---------------------------------------------------------------------------
// Errors (serialized as JSON bodies with the matching HTTP status)
// ---------------------------------------------------------------------------

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// HTTP / WS paths (single place to change them)
// ---------------------------------------------------------------------------

export const Paths = {
  health: "/api/health",
  /** GET -> Task[]: every thread of the signed-in user, archived ones included. POST CreateTaskBody -> Task. */
  tasks: "/api/tasks",
  task: (id: string) => `/api/tasks/${id}`,
  /** POST archives the thread (tears down its desktop and sandbox, keeps history); DELETE unarchives it. Both return the Task. */
  taskArchive: (id: string) => `/api/tasks/${id}/archive`,
  taskMessages: (id: string) => `/api/tasks/${id}/messages`,
  taskRuns: (id: string) => `/api/tasks/${id}/runs`,
  taskDiff: (id: string) => `/api/tasks/${id}/diff`,
  taskDesktop: (id: string) => `/api/tasks/${id}/desktop`,
  taskAttachment: (taskId: string, attachmentId: string) => `/api/tasks/${taskId}/attachments/${attachmentId}`,
  /**
   * POST the raw file bytes as the body (not multipart), its type as `Content-Type`, and its file name as the
   * optional `name` query parameter -> `Attachment`. The upload waits, unsent, until a `SendMessageBody.attachments`
   * names it; it is deleted with its task. At most `MAX_ATTACHMENT_BYTES`.
   */
  taskUploads: (id: string) => `/api/tasks/${id}/uploads`,
  runCancel: (id: string) => `/api/runs/${id}/cancel`,
  /** GET -> RunItems: the run's display items so far (live runs) or final (finished runs). */
  runItems: (id: string) => `/api/runs/${id}/items`,
  /** WebSocket: JSON `ServerEvent` text frames. */
  taskEventsWs: (id: string) => `/api/tasks/${id}/events`,
  /**
   * WebSocket: server sends `DesktopStatus` JSON text frames + fMP4 binary frames; client sends `DesktopInput` JSON
   * and `DesktopAck` JSON.
   */
  taskDesktopWs: (id: string) => `/api/tasks/${id}/desktop/stream`,
  /** MCP (streamable HTTP) endpoint for the agent harness. */
  mcp: (taskId: string) => `/mcp/${taskId}`,
} as const

export * from "./relay"
export * from "./control"
export * from "./refs"
