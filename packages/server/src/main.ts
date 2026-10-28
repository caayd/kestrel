import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Effect, Fiber, Layer } from "effect"
import { BOX_USER_HEADER, CREDENTIALS_HEADER, InternalError } from "@cloudagents/protocol"
import { ConfigLive, Config } from "./config"
import { CliAuth, CliAuthLive } from "./cliauth"
import { CoreLive, CoreService } from "./core/service"
import { EventHubLive } from "./core/events"
import { AgentHarnessLive } from "./core/harness"
import { StateLive } from "./core/state"
import { WorkspaceLive } from "./core/workspace"
import { CredentialBroker, CredentialBrokerLive } from "./broker"
import { BROKER_PREFIX, handleBroker } from "./broker/handler"
import { makeControlClient } from "./control/client"
import { CredentialStoreLive } from "./credentials"
import { GitHubLive } from "./github/api"
import { DesktopManager, DesktopManagerLive, type DesktopRegion } from "./desktop"
import { createMcpHandler } from "./mcp"
import { makeWebHandler } from "./http/router"
import { BOX_DEV_HEADER, runRelay } from "./relay/client"

const BaseLive = Layer.provideMerge(
  CredentialBrokerLive,
  Layer.mergeAll(
    ConfigLive,
    WorkspaceLive,
    EventHubLive,
    DesktopManagerLive,
    CredentialStoreLive,
    Layer.provide(GitHubLive, ConfigLive),
  ),
)
const CliAuthWithBase = Layer.provideMerge(CliAuthLive, BaseLive)
const StateWithBase = Layer.provideMerge(StateLive, CliAuthWithBase)
const HarnessWithBase = Layer.provideMerge(AgentHarnessLive, StateWithBase)
const AppLive = Layer.provideMerge(CoreLive, HarnessWithBase)

const MCP_PREFIX = "/mcp/"

/** Reads a node request body into a web Request so the Effect HttpApp can handle it. */
const toWebRequest = async (req: IncomingMessage): Promise<Request> => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    // Identity only comes through the relay; a local caller (e.g. a sandboxed agent) cannot claim a user or dev access.
    if (name === BOX_USER_HEADER || name === BOX_DEV_HEADER || name === CREDENTIALS_HEADER) continue
    if (Array.isArray(value)) for (const v of value) headers.append(name, v)
    else headers.set(name, value)
  }
  const method = req.method ?? "GET"
  const chunks: Buffer[] = []
  if (method !== "GET" && method !== "HEAD") {
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
  return new Request(url, { method, headers, body })
}

/** Writes a web Response back onto the node response, streaming its body. */
const writeWebResponse = async (res: ServerResponse, web: Response): Promise<void> => {
  res.statusCode = web.status
  web.headers.forEach((value, name) => {
    res.setHeader(name, value)
  })
  if (web.body === null) {
    res.end()
    return
  }
  const reader = web.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

const failResponse = (res: ServerResponse, error: unknown) => {
  console.error("request failed:", error)
  if (!res.headersSent) {
    res.statusCode = 500
    res.setHeader("content-type", "application/json")
  }
  res.end(JSON.stringify({ _tag: "InternalError", message: "internal server error" }))
}

const listen = (server: Server, host: string, port: number) =>
  Effect.async<void, InternalError>((resume) => {
    const onError = (e: Error) => resume(Effect.fail(new InternalError({ message: `listen failed: ${e.message}` })))
    server.once("error", onError)
    server.listen(port, host, () => {
      server.off("error", onError)
      resume(Effect.void)
    })
  })

const untilSignal = Effect.async<void>((resume) => {
  const onSignal = () => resume(Effect.void)
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
})

const closeServer = (server: Server) =>
  Effect.async<void>((resume) => {
    server.close(() => resume(Effect.void))
    server.closeAllConnections()
  })

const program = Effect.gen(function* () {
  const config = yield* Config
  const core = yield* CoreService
  const desktop = yield* DesktopManager
  const broker = yield* CredentialBroker
  const cliAuth = yield* CliAuth
  const webHandler = yield* makeWebHandler(core, cliAuth)

  const mcpHandler = createMcpHandler({
    auth: { grantFor: broker.grantForToken, runFor: core.runFor, onRevoke: broker.onRevoke },
    desktop: {
      open: (taskId) => core.desktopOpen(taskId),
      status: (taskId) => desktop.status(taskId),
      screenshot: (taskId: string, crop?: DesktopRegion, scale?: number) => desktop.screenshot(taskId, crop, scale),
      grab: (taskId) => desktop.grab(taskId),
      cursor: (taskId) => desktop.cursor(taskId),
      input: (taskId, event) => desktop.input(taskId, event),
      launch: (taskId, command) => core.desktopLaunch(taskId, command),
      processes: (taskId) => desktop.processes(taskId),
      kill: (taskId, id) => desktop.kill(taskId, id),
    },
    workspace: {
      checkout: core.checkout,
      exec: (taskId, command, timeoutMs) => core.execInTask(taskId, command, timeoutMs),
    },
    report: core.report,
    github: {
      push: core.gitPush,
      openPullRequest: core.openPullRequest,
      pullRequestStatus: core.pullRequestStatus,
      reviewPullRequest: core.reviewPullRequest,
    },
    ask: core.ask,
    automations: { control: config.relay === null ? null : makeControlClient(config.relay), taskOwner: core.taskOwner },
    inbox: core.inbox,
  })

  const server = createServer((req, res) => {
    // The broker only answers sandboxed runs holding a live token; it is routed first on purpose.
    const handled = req.url?.startsWith(BROKER_PREFIX)
      ? handleBroker(broker, req, res)
      : req.url?.startsWith(MCP_PREFIX)
        ? mcpHandler(req, res)
        : toWebRequest(req).then((web) => webHandler(web)).then((response) => writeWebResponse(res, response))
    handled.catch((error: unknown) => failResponse(res, error))
  })

  // Task streams only come through the relay, which knows the signed-in user; the local listener has no upgrades.

  yield* listen(server, config.host, config.port)
  yield* Effect.logInfo(`cloudagents server listening on http://${config.host}:${config.port}`)

  let relayFiber: Fiber.RuntimeFiber<void> | null = null
  if (config.relay) {
    relayFiber = yield* Effect.forkDaemon(
      runRelay({ controlUrl: config.relay.controlUrl, boxToken: config.relay.boxToken, handle: webHandler }),
    )
    yield* Effect.logInfo(`box connecting to control plane at ${config.relay.controlUrl}`)
  }

  yield* untilSignal
  yield* Effect.logInfo("shutting down")
  if (relayFiber !== null) yield* Fiber.interrupt(relayFiber)
  yield* cliAuth.shutdown()
  yield* core.shutdown()
  yield* closeServer(server)
}).pipe(Effect.provide(AppLive))

Effect.runPromise(program).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("cloudagents server failed:", error)
    process.exit(1)
  },
)
