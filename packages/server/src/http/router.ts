import { Effect, Schema } from "effect"
import { HttpApp, HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { BOX_USER_HEADER, BadRequest, CliLoginCodeBody, CliProvider, Conflict, CreateTaskBody, Health, InternalError, NotFound, SendMessageBody } from "@cloudagents/protocol"
import { VERSION } from "../config"
import type { CliAuthShape } from "../cliauth"
import type { CoreShape } from "../core/service"
import { BOX_DEV_HEADER } from "../relay/client"

type ApiError = NotFound | BadRequest | Conflict | InternalError

const statusOf = (e: ApiError): number => {
  switch (e._tag) {
    case "NotFound":
      return 404
    case "BadRequest":
      return 400
    case "Conflict":
      return 409
    case "InternalError":
      return 500
  }
}

const errorResponse = (e: ApiError) =>
  HttpServerResponse.unsafeJson({ _tag: e._tag, message: e.message }, { status: statusOf(e) })

/** Turns a service result into a JSON response; failures become the tagged error body with its status. */
const respond = <A, R>(effect: Effect.Effect<A, ApiError, R>): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.map((body) => HttpServerResponse.unsafeJson(body)),
    Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
  )

/** Like `respond` for operations that return no body; success is 204. */
const noContent = <R>(effect: Effect.Effect<void, ApiError, R>): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.map(() => HttpServerResponse.empty({ status: 204 })),
    Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
  )

/**
 * Decodes the JSON request body with `schema`. An empty body decodes as `{}`, so bodies are
 * optional where the schema allows it.
 */
const jsonBody = <A, I>(schema: Schema.Schema<A, I, never>): Effect.Effect<A, BadRequest, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const text = yield* req.text.pipe(
      Effect.mapError(() => new BadRequest({ message: "cannot read request body" })),
    )
    return yield* Schema.decodeUnknown(Schema.parseJson(schema))(text.trim() === "" ? "{}" : text).pipe(
      Effect.mapError((e) => new BadRequest({ message: `invalid request body: ${e.message}` })),
    )
  })

/**
 * The raw bytes of an uploaded file: the body, its `Content-Type` (required; parameters such as `charset` are
 * dropped), and the optional `name` query parameter. Read whole; the core refuses anything over `MAX_ATTACHMENT_BYTES`.
 */
const uploadInput = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const mimeType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()
  if (mimeType === "") {
    return yield* Effect.fail(new BadRequest({ message: "content-type is required" }))
  }
  const bytes = yield* req.arrayBuffer.pipe(Effect.mapError(() => new BadRequest({ message: "cannot read request body" })))
  const name = new URL(req.url, "http://localhost").searchParams.get("name") ?? undefined
  return { mimeType, name, bytes: new Uint8Array(bytes) }
})

const pathId = Effect.map(HttpRouter.params, (p) => p.id ?? "")

/** The user the relay signed in for this request (relay-set header, stripped on the box's own port); null otherwise. */
const requestUser = Effect.map(HttpServerRequest.HttpServerRequest, (req) => {
  const user = req.headers[BOX_USER_HEADER]
  return user === undefined || user === "" ? null : user
})

/** `/auth/dev-login` sessions may use dev-only flows (a `/replay` chat message); the relay marks them. */
const requestIsDev = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (req) => req.headers[BOX_DEV_HEADER] === "1",
)

/** Runs `f` for the signed-in user; a request without one is refused. */
const signedIn = <A, R>(f: (user: string) => Effect.Effect<A, ApiError, R>) =>
  Effect.flatMap(requestUser, (user) =>
    user === null ? Effect.fail(new BadRequest({ message: "no signed-in user" })) : f(user),
  )

/** The provider named in the path; anything else is refused. */
const cliProvider = Effect.flatMap(HttpRouter.params, (p) =>
  Schema.decodeUnknown(CliProvider)(p.provider ?? "").pipe(Effect.mapError(() => new BadRequest({ message: "unknown provider" }))),
)

export const makeRouter = (core: CoreShape, cliAuth: CliAuthShape) =>
  HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/health",
      Effect.succeed(HttpServerResponse.unsafeJson(Schema.decodeSync(Health)({ ok: true, version: VERSION }))),
    ),
    // Agent CLI sign-ins of the signed-in user on the box (Connections page); never tokens.
    HttpRouter.get("/api/cli-auth", respond(signedIn((user) => cliAuth.status(user)))),
    HttpRouter.post(
      "/api/cli-auth/:provider/login",
      respond(Effect.flatMap(cliProvider, (provider) => signedIn((user) => cliAuth.startLogin(user, provider)))),
    ),
    HttpRouter.post(
      "/api/cli-auth/:provider/code",
      respond(
        Effect.flatMap(cliProvider, (provider) =>
          signedIn((user) =>
            Effect.flatMap(jsonBody(CliLoginCodeBody), (body) => cliAuth.submitCode(user, provider, body.code)),
          ),
        ),
      ),
    ),
    HttpRouter.del(
      "/api/cli-auth/:provider",
      noContent(Effect.flatMap(cliProvider, (provider) => signedIn((user) => cliAuth.logout(user, provider)))),
    ),
  ).pipe(
    // Threads of the signed-in user, archived ones included; core answers NotFound for anyone else's.
    HttpRouter.get("/api/tasks", respond(signedIn((user) => core.listTasks(user)))),
    HttpRouter.post(
      "/api/tasks",
      respond(signedIn((user) => Effect.flatMap(jsonBody(CreateTaskBody), (body) => core.createTask(user, body)))),
    ),

    HttpRouter.get(
      "/api/tasks/:id",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.getTask(user, id)))),
    ),
    HttpRouter.del(
      "/api/tasks/:id",
      Effect.flatMap(pathId, (id) => noContent(signedIn((user) => core.deleteTask(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/archive",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.archiveTask(user, id)))),
    ),
    HttpRouter.del(
      "/api/tasks/:id/archive",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.unarchiveTask(user, id)))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/messages",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.listMessages(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/messages",
      Effect.flatMap(pathId, (id) =>
        respond(
          Effect.flatMap(requestIsDev, (dev) =>
            signedIn((user) =>
              Effect.flatMap(jsonBody(SendMessageBody), (body) =>
                core.sendMessage(user, id, body.text, { model: body.model, effort: body.effort }, body.attachments ?? [], dev),
              ),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.post(
      "/api/tasks/:id/uploads",
      Effect.flatMap(pathId, (id) =>
        respond(signedIn((user) => Effect.flatMap(uploadInput, (input) => core.upload(user, id, input)))),
      ),
    ),
    HttpRouter.get(
      "/api/tasks/:id/runs",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.listRuns(user, id)))),
    ),
    HttpRouter.post(
      "/api/runs/:id/cancel",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.cancelRun(user, id)))),
    ),
    HttpRouter.get(
      "/api/runs/:id/items",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.runItems(user, id)))),
    ),
    HttpRouter.get(
      "/api/tasks/:id/diff",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.diff(user, id)))),
    ),
    // Bytes of a file attached to one of the owner's task messages; the MIME type is the content type. Users upload
    // any type, so the response may not run as a page on the app's origin (e.g. an uploaded text/html).
    HttpRouter.get(
      "/api/tasks/:id/attachments/:attachmentId",
      Effect.flatMap(HttpRouter.params, (p) =>
        signedIn((user) => core.attachment(user, p.id ?? "", p.attachmentId ?? "")).pipe(
          Effect.map((a) =>
            HttpServerResponse.uint8Array(a.bytes, {
              contentType: a.mimeType,
              headers: { "content-security-policy": "sandbox", "x-content-type-options": "nosniff" },
            }),
          ),
          Effect.catchAll((e) => Effect.succeed(errorResponse(e))),
        ),
      ),
    ),

    HttpRouter.get(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.desktopStatus(user, id)))),
    ),
    HttpRouter.post(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) => respond(signedIn((user) => core.desktopStart(user, id)))),
    ),
    HttpRouter.del(
      "/api/tasks/:id/desktop",
      Effect.flatMap(pathId, (id) =>
        respond(signedIn((user) => core.desktopStop(user, id).pipe(Effect.zipRight(core.desktopStatus(user, id))))),
      ),
    ),
  )

/**
 * Builds a fetch-style handler for the REST API. Unknown routes return 404.
 * CORS is open to every origin (web and Electron clients).
 */
export const makeWebHandler = (core: CoreShape, cliAuth: CliAuthShape) =>
  Effect.gen(function* () {
    const app = yield* HttpRouter.toHttpApp(makeRouter(core, cliAuth))
    const notFound = HttpServerResponse.unsafeJson({ _tag: "NotFound", message: "no such route" }, { status: 404 })
    const withCors = HttpMiddleware.cors({
      allowedOrigins: () => true,
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type"],
    })
    const handled = app.pipe(Effect.catchTag("RouteNotFound", () => Effect.succeed(notFound)))
    return HttpApp.toWebHandler(withCors(handled))
  })
