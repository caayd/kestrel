/**
 * Relay protocol between the control plane (Cloudflare Worker + Durable Object) and an agent box.
 *
 * The box dials OUT to `RELAY_CONNECT_PATH` on the control plane with
 * `Authorization: Bearer <box token>`. Over that single WebSocket the control plane tunnels the
 * browser's `/api/*` HTTP requests and WebSockets to the box, which serves them with its
 * existing local handlers.
 *
 * Text frames carry one JSON `RelayFrame`. Binary frames carry WebSocket binary payloads for a
 * tunnelled stream: the first 4 bytes are the stream id (uint32, big-endian), the rest is the payload.
 *
 * Stream ids are allocated by the control plane and are unique per box connection; HTTP request
 * ids and WebSocket stream ids share the same id space.
 */

export const RELAY_CONNECT_PATH = "/box/connect"
export const RELAY_PROTOCOL_VERSION = 1

/**
 * Request header the control plane sets on every tunnelled HTTP request and WebSocket open.
 * Value: JSON `RelayCredentials`. The control plane strips any client-supplied copy.
 */
export const CREDENTIALS_HEADER = "x-cloudagents-credentials"

/** Secrets of the signed-in user's connections, forwarded to the box (never to the sandbox). */
export interface RelayCredentials {
  readonly user: string // GitHub login of the signed-in user
  readonly github?: string // GitHub OAuth access token
  readonly anthropic?: string // Anthropic API key
  readonly openai?: string // OpenAI API key
  /** True only for sessions from `/auth/dev-login`; unlocks dev-only box features (fixture replay). */
  readonly dev?: boolean
}

export type RelayFrame =
  // box -> control plane, first frame after connect
  | { readonly t: "hello"; readonly version: number; readonly boxVersion: string }
  // control plane -> box: one HTTP request. `body` is base64, absent when empty.
  | {
      readonly t: "http"
      readonly id: number
      readonly method: string
      readonly path: string // path + query, e.g. "/api/repos?x=1"
      readonly headers: Readonly<Record<string, string>>
      readonly body?: string
    }
  // box -> control plane: the response to `http` with the same id. `body` is base64.
  | {
      readonly t: "http-res"
      readonly id: number
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      readonly body?: string
    }
  // control plane -> box: a browser opened a WebSocket to `path`.
  | { readonly t: "ws-open"; readonly id: number; readonly path: string; readonly headers: Readonly<Record<string, string>> }
  // either direction: a text message on stream `id` (binary messages use binary frames).
  | { readonly t: "ws-text"; readonly id: number; readonly data: string }
  // either direction: stream `id` closed (box: local socket rejected/closed; control plane: browser left).
  | { readonly t: "ws-close"; readonly id: number; readonly code?: number; readonly reason?: string }
  // either direction, keepalive
  | { readonly t: "ping" }
  | { readonly t: "pong" }

export const encodeFrame = (frame: RelayFrame): string => JSON.stringify(frame)

/** Parses a text frame; returns null for malformed input. */
export const decodeFrame = (text: string): RelayFrame | null => {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === "object" && v !== null && "t" in v && typeof v.t === "string") return v as RelayFrame
  } catch {
    // fall through
  }
  return null
}

/** Prefixes a binary payload with its stream id. */
export const encodeBinary = (id: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + payload.byteLength)
  new DataView(out.buffer).setUint32(0, id)
  out.set(payload, 4)
  return out
}

/** Splits a binary frame into stream id and payload; null if shorter than the header. */
export const decodeBinary = (frame: Uint8Array): { id: number; payload: Uint8Array } | null => {
  if (frame.byteLength < 4) return null
  const id = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0)
  return { id, payload: frame.subarray(4) }
}

export const toBase64 = (bytes: Uint8Array): string => {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const fromBase64 = (b64: string): Uint8Array => {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
