import { Effect, Either, Schema } from "effect"
import {
  Automation,
  BoxStatus,
  CliAuthStatus,
  CliLoginCodeBody,
  CliLoginStart,
  CliProvider,
  Connection,
  ControlPaths,
  CreateTaskBody,
  DesktopStatus,
  DiffResponse,
  Me,
  Message,
  Paths,
  PutApiKeyBody,
  Run,
  RunItems,
  SendMessageBody,
  SendMessageResponse,
  Task,
  UpdateAutomationBody,
} from "@cloudagents/protocol"
import { SERVER_URL } from "@/config"

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "ApiError"
  }
}

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

/** Fires whenever any API call is rejected with 401 (session missing or expired). */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function errorMessage(text: string, fallback: string): string {
  try {
    const body: unknown = JSON.parse(text)
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      return body.message
    }
  } catch {
    // Body is not JSON; fall through to raw text.
  }
  return text || fallback
}

const request = <A, I>(
  schema: Schema.Schema<A, I>,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Effect.Effect<A, ApiError> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(SERVER_URL + path, {
          method,
          credentials: "include",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      catch: (e) => new ApiError(0, `Cannot reach server at ${SERVER_URL}: ${String(e)}`),
    })
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => new ApiError(res.status, String(e)),
    })
    if (res.status === 401) {
      unauthorizedListeners.forEach((listener) => listener())
    }
    if (!res.ok) {
      return yield* Effect.fail(new ApiError(res.status, errorMessage(text, res.statusText)))
    }
    // 204 and other empty bodies carry no JSON; they decode as `undefined`.
    const json = yield* Effect.try({
      try: () => (text === "" ? undefined : (JSON.parse(text) as unknown)),
      catch: () => new ApiError(res.status, "Server returned invalid JSON"),
    })
    return yield* Schema.decodeUnknown(schema)(json).pipe(
      Effect.mapError((e) => new ApiError(res.status, `Unexpected response shape: ${e.message}`)),
    )
  })

const run = <A>(effect: Effect.Effect<A, ApiError>): Promise<A> =>
  Effect.runPromise(Effect.either(effect)).then((result) => {
    if (Either.isLeft(result)) throw result.left
    return result.right
  })

/** Absolute URL of an attachment; the browser loads it with the session cookie, so it is safe to use in an `<img>`. */
export const taskAttachmentUrl = (taskId: string, attachmentId: string): string =>
  SERVER_URL + Paths.taskAttachment(taskId, attachmentId)

export const api = {
  // Control plane (served by the Worker).
  me: () => run(request(Me, "GET", ControlPaths.me)),
  logout: () => run(Effect.asVoid(request(Schema.Unknown, "POST", ControlPaths.logout))),
  connections: () => run(request(Schema.Array(Connection), "GET", ControlPaths.connections)),
  putApiKey: (provider: string, body: PutApiKeyBody) =>
    run(request(Connection, "PUT", ControlPaths.connection(provider), body)),
  deleteConnection: (provider: string) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.connection(provider)))),
  box: () => run(request(BoxStatus, "GET", ControlPaths.box)),
  cliLoginStart: (provider: CliProvider) => run(request(CliLoginStart, "POST", ControlPaths.cliLogin(provider))),
  cliLoginCode: (provider: CliProvider, body: CliLoginCodeBody) =>
    run(request(CliAuthStatus, "POST", ControlPaths.cliLoginCode(provider), body)),
  cliLogout: (provider: CliProvider) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.cliLogout(provider)))),
  listAutomations: () => run(request(Schema.Array(Automation), "GET", ControlPaths.automations)),
  updateAutomation: (id: string, body: UpdateAutomationBody) =>
    run(request(Automation, "PATCH", ControlPaths.automation(id), body)),
  deleteAutomation: (id: string) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", ControlPaths.automation(id)))),

  // Agent box (relayed by the Worker).
  listTasks: () => run(request(Schema.Array(Task), "GET", Paths.tasks)),
  createTask: (body: CreateTaskBody) => run(request(Task, "POST", Paths.tasks, body)),
  getTask: (taskId: string) => run(request(Task, "GET", Paths.task(taskId))),
  archiveTask: (taskId: string) => run(request(Task, "POST", Paths.taskArchive(taskId))),
  unarchiveTask: (taskId: string) => run(request(Task, "DELETE", Paths.taskArchive(taskId))),
  listMessages: (taskId: string) => run(request(Schema.Array(Message), "GET", Paths.taskMessages(taskId))),
  sendMessage: (taskId: string, body: SendMessageBody) =>
    run(request(SendMessageResponse, "POST", Paths.taskMessages(taskId), body)),
  listRuns: (taskId: string) => run(request(Schema.Array(Run), "GET", Paths.taskRuns(taskId))),
  runItems: (runId: string) => run(request(RunItems, "GET", Paths.runItems(runId))),
  cancelRun: (runId: string) => run(request(Run, "POST", Paths.runCancel(runId))),
  getDiff: (taskId: string) => run(request(DiffResponse, "GET", Paths.taskDiff(taskId))),
  getDesktop: (taskId: string) => run(request(DesktopStatus, "GET", Paths.taskDesktop(taskId))),
  startDesktop: (taskId: string) => run(request(DesktopStatus, "POST", Paths.taskDesktop(taskId))),
  stopDesktop: (taskId: string) =>
    run(Effect.asVoid(request(Schema.Unknown, "DELETE", Paths.taskDesktop(taskId)))),
}
