import { Context, Duration, Either, Effect, Runtime, Schema } from "effect"
import {
  BOX_USER_HEADER,
  CREDENTIALS_HEADER,
  RELAY_CONNECT_PATH,
  RELAY_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  fromBase64,
  toBase64,
  type RelayCredentials,
  type RelayFrame,
} from "@cloudagents/protocol"
import { WebSocket } from "ws"
import { VERSION } from "../config"
import { CredentialStore } from "../credentials"
import { CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, serveStream, streamRoute, type WsServices } from "../http/streams"
import { RelayStream } from "./stream"

export interface RelayOptions {
  /** Control plane base URL (http(s) or ws(s)); the box dials `RELAY_CONNECT_PATH` under it. */
  readonly controlUrl: string
  readonly boxToken: string
  /** Serves a tunnelled HTTP request with the box's local `/api/*` handler. */
  readonly handle: (req: Request) => Promise<Response>
}

type Store = Context.Tag.Service<typeof CredentialStore>

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const PING_INTERVAL_MS = 20_000
/** Silence longer than this means the relay connection is dead even if TCP has not noticed. */
const SILENCE_TIMEOUT_MS = 60_000
/** Placeholder origin for building Request URLs from tunnelled paths. */
const BOX_ORIGIN = "http://box.local"
/** Headers that describe the tunnel hop rather than the browser request, so they are not forwarded. */
const HOP_HEADERS: Record<string, true> = {
  host: true,
  "content-length": true,
  connection: true,
  "transfer-encoding": true,
  upgrade: true,
  [CREDENTIALS_HEADER]: true,
}

/**
 * Set to "1" on a relayed request from a `/auth/dev-login` session (dev-only flows such as fixture replay).
 * Like BOX_USER_HEADER, only the relay sets it: the browser's copy is dropped here and main.ts strips it locally.
 */
export const BOX_DEV_HEADER = "x-kestrel-box-dev"

const Credentials = Schema.parseJson(
  Schema.Struct({
    user: Schema.String,
    github: Schema.optional(Schema.String),
    anthropic: Schema.optional(Schema.String),
    openai: Schema.optional(Schema.String),
    dev: Schema.optional(Schema.Boolean),
  }),
)

const relayUrl = (controlUrl: string): string => {
  const url = new URL(controlUrl)
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${RELAY_CONNECT_PATH}`
  url.search = ""
  url.hash = ""
  return url.toString()
}

/**
 * Keeps the box connected to the control plane for the life of the process. Reconnects with
 * exponential backoff (1s doubling to 30s); a connection that opened resets the backoff.
 */
export const runRelay = (options: RelayOptions): Effect.Effect<void, never, CredentialStore | WsServices> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<CredentialStore | WsServices>()
    const store = yield* CredentialStore
    const url = relayUrl(options.controlUrl)
    let delay = RECONNECT_MIN_MS
    for (;;) {
      const opened = yield* connectOnce(url, options, store, runtime)
      if (opened) delay = RECONNECT_MIN_MS
      yield* Effect.logWarning(`relay connection closed; retrying in ${delay}ms`)
      yield* Effect.sleep(Duration.millis(delay))
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  })

/** Resolves with whether the connection opened, once it closes. Interruption tears the socket down. */
const connectOnce = (
  url: string,
  options: RelayOptions,
  store: Store,
  runtime: Runtime.Runtime<CredentialStore | WsServices>,
): Effect.Effect<boolean> =>
  Effect.async<boolean>((resume) => {
    const runFork = Runtime.runFork(runtime)
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${options.boxToken}` } })
    const streams = new Map<number, RelayStream>()
    let opened = false
    let lastSeen = Date.now()

    const send = (data: string | Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    }

    const keepalive = setInterval(() => {
      if (Date.now() - lastSeen > SILENCE_TIMEOUT_MS) {
        ws.terminate()
        return
      }
      send(encodeFrame({ t: "ping" }))
    }, PING_INTERVAL_MS)

    const finish = () => {
      clearInterval(keepalive)
      for (const stream of streams.values()) stream.receiveClose()
      streams.clear()
      resume(Effect.succeed(opened))
    }

    const dispatch = (frame: RelayFrame) => {
      switch (frame.t) {
        case "http":
          void serveHttp(frame, options.handle, store, send)
          return
        case "ws-open": {
          const route = streamRoute(new URL(frame.path, BOX_ORIGIN).pathname)
          if (route === null) {
            send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_NOT_FOUND, reason: "not found" }))
            return
          }
          const user = absorbCredentials(frame.headers, store)?.user ?? null
          if (user === null) {
            send(encodeFrame({ t: "ws-close", id: frame.id, code: CLOSE_UNAUTHORIZED, reason: "no signed-in user" }))
            return
          }
          const stream = new RelayStream(frame.id, send)
          streams.set(frame.id, stream)
          stream.onClose(() => streams.delete(frame.id))
          runFork(serveStream(route, user, stream))
          return
        }
        case "ws-text":
          streams.get(frame.id)?.receiveText(frame.data)
          return
        case "ws-close":
          streams.get(frame.id)?.receiveClose()
          return
        case "ping":
          send(encodeFrame({ t: "pong" }))
          return
        case "hello":
        case "http-res":
        case "pong":
          return
      }
    }

    ws.on("open", () => {
      opened = true
      send(encodeFrame({ t: "hello", version: RELAY_PROTOCOL_VERSION, boxVersion: VERSION }))
      Effect.runSync(Effect.logInfo(`relay connected to ${url}`))
    })
    ws.on("message", (data, isBinary) => {
      lastSeen = Date.now()
      // Inbound binary frames have no consumer: the local handlers only accept text input.
      if (isBinary) return
      const frame = decodeFrame(data.toString())
      if (frame === null) {
        Effect.runSync(Effect.logWarning("relay: dropped malformed frame"))
        return
      }
      dispatch(frame)
    })
    ws.on("error", (err) => {
      Effect.runSync(Effect.logWarning(`relay socket error: ${err.message}`))
    })
    ws.on("close", finish)

    return Effect.sync(() => {
      clearInterval(keepalive)
      ws.terminate()
    })
  })

/** Stores the signed-in user's credentials from a tunnelled request; returns them, null when absent or malformed. */
const absorbCredentials = (headers: Readonly<Record<string, string>>, store: Store): RelayCredentials | null => {
  const raw = headers[CREDENTIALS_HEADER]
  if (raw === undefined) return null
  const decoded = Schema.decodeUnknownEither(Credentials)(raw)
  if (Either.isLeft(decoded)) {
    Effect.runSync(Effect.logWarning("relay: credentials header is malformed; ignored"))
    return null
  }
  Effect.runSync(store.set(decoded.right))
  return decoded.right
}

const serveHttp = async (
  frame: Extract<RelayFrame, { t: "http" }>,
  handle: (req: Request) => Promise<Response>,
  store: Store,
  send: (data: string | Uint8Array) => void,
) => {
  const creds = absorbCredentials(frame.headers, store)
  let res: Response
  try {
    const headers = new Headers()
    for (const [name, value] of Object.entries(frame.headers)) {
      if (HOP_HEADERS[name.toLowerCase()] !== true) headers.set(name, value)
    }
    headers.delete(BOX_USER_HEADER)
    headers.delete(BOX_DEV_HEADER)
    if (creds !== null) headers.set(BOX_USER_HEADER, creds.user)
    if (creds?.dev === true) headers.set(BOX_DEV_HEADER, "1")
    const body = frame.body === undefined ? undefined : new Uint8Array(fromBase64(frame.body))
    const req = new Request(new URL(frame.path, BOX_ORIGIN), { method: frame.method, headers, body })
    res = await handle(req)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res = Response.json({ error: "InternalError", message }, { status: 500 })
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const headers: Record<string, string> = {}
  res.headers.forEach((value, name) => {
    headers[name] = value
  })
  send(
    encodeFrame({
      t: "http-res",
      id: frame.id,
      status: res.status,
      headers,
      body: bytes.byteLength > 0 ? toBase64(bytes) : undefined,
    }),
  )
}
