import { ControlPaths } from "@cloudagents/protocol"
import { findProvider, type OAuthProvider } from "./providers"
import { UpstreamError, errorResponse, readCookie, safeReturnPath } from "./http"
import { hub, type Env } from "./env"
import type { SessionRecord } from "./hub"

export const SESSION_COOKIE = "session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const STATE_TTL_MS = 10 * 60 * 1000

/** Sign-in is restricted to the comma-separated `ALLOWED_GITHUB_LOGINS` (case-insensitive). */
export const isAllowedLogin = (env: Env, login: string): boolean =>
  env.ALLOWED_GITHUB_LOGINS.split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(login.toLowerCase())

/** The signed-in user's session, or null when there is no live session for an allowed account. */
export const currentSession = async (request: Request, env: Env): Promise<SessionRecord | null> => {
  const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
  if (!id) return null
  const session = await hub(env).session(id)
  if (!session || !isAllowedLogin(env, session.login)) return null
  return session
}

const randomToken = (bytes: number): string => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("")
}

const sessionCookie = (value: string, maxAge: number): string =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

const htmlPage = (status: number, message: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><title>kestrel</title><p>${message}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })

const redirect = (location: string, headers: HeadersInit = {}): Response => {
  const h = new Headers(headers)
  h.set("location", location)
  return new Response(null, { status: 302, headers: h })
}

/** OAuth client credentials, or null when the provider is not configured on this Worker. */
const oauthCredentials = (
  env: Env,
  provider: OAuthProvider,
): { clientId: string; clientSecret: string } | null => {
  const clientId = env[provider.clientIdEnv]
  const clientSecret = env[provider.clientSecretEnv]
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Starts an OAuth flow: stores single-use state, then redirects to the provider's consent page. */
const beginOAuth = async (
  env: Env,
  url: URL,
  kind: "login" | "connect",
  provider: OAuthProvider,
  returnTo: string,
): Promise<Response> => {
  const creds = oauthCredentials(env, provider)
  if (!creds) return errorResponse(503, "NotConfigured", `${provider.label} OAuth is not configured`)
  const state = randomToken(24)
  await hub(env).createOAuthState(state, kind, provider.id, returnTo, Date.now() + STATE_TTL_MS)
  const authorize = new URL(provider.authorizeUrl)
  authorize.searchParams.set("client_id", creds.clientId)
  authorize.searchParams.set("redirect_uri", `${url.origin}${provider.callbackPath}`)
  authorize.searchParams.set("scope", provider.scopes)
  authorize.searchParams.set("state", state)
  return redirect(authorize.toString())
}

const exchangeCode = async (
  provider: OAuthProvider,
  creds: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<string> => {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "kestrel-control-plane",
    },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown }
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new UpstreamError(`${provider.label} token exchange failed: ${String(body.error ?? res.status)}`)
  }
  return body.access_token
}

/** OAuth callback for both sign-in (`kind: login`) and connections (`kind: connect`). */
const finishOAuth = async (request: Request, env: Env, url: URL, providerId: string): Promise<Response> => {
  const provider = findProvider(providerId)
  if (!provider || provider.kind !== "oauth") return errorResponse(404, "NotFound", `unknown provider ${providerId}`)
  const creds = oauthCredentials(env, provider)
  if (!creds) return errorResponse(503, "NotConfigured", `${provider.label} OAuth is not configured`)

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state || url.searchParams.get("error")) {
    return htmlPage(400, "Authorization was cancelled or incomplete. Please try again.")
  }
  const row = await hub(env).consumeOAuthState(state)
  if (!row || row.provider !== provider.id) {
    return htmlPage(400, "This sign-in link has expired or was already used. Please try again.")
  }

  const token = await exchangeCode(provider, creds, code, `${url.origin}${provider.callbackPath}`)
  const account = await provider.fetchAccount(token)

  if (row.kind === "login") {
    if (!isAllowedLogin(env, account.login)) {
      return htmlPage(403, "Forbidden: this account is not allowed to use kestrel.")
    }
    const stub = hub(env)
    await stub.upsertUser({ login: account.login, name: account.name, avatarUrl: account.avatarUrl })
    await stub.putConnection(account.login, provider.id, token, account.login)
    const sessionId = randomToken(32)
    await stub.createSession(sessionId, account.login, Date.now() + SESSION_TTL_MS, false)
    return redirect(row.returnTo, { "set-cookie": sessionCookie(sessionId, SESSION_TTL_MS / 1000) })
  }

  const login = (await currentSession(request, env))?.login
  if (!login) return htmlPage(401, "Sign in to kestrel before connecting accounts.")
  if (account.login.toLowerCase() !== login.toLowerCase()) {
    return htmlPage(403, "Connect the GitHub account you are signed in with.")
  }
  await hub(env).putConnection(login, provider.id, token, account.login)
  return redirect(row.returnTo)
}

/** Routes every `/auth/*` request. */
export const handleAuth = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const path = url.pathname

  if (path === ControlPaths.login && request.method === "GET") {
    const provider = findProvider("github")
    if (!provider || provider.kind !== "oauth") return errorResponse(404, "NotFound", "github is not a provider")
    const returnTo = safeReturnPath(url.searchParams.get("return"), "/")
    return beginOAuth(env, url, "login", provider, returnTo)
  }

  if (path === ControlPaths.loginCallback && request.method === "GET") {
    return finishOAuth(request, env, url, "github")
  }

  if (path === "/auth/mobile-callback" && request.method === "GET") {
    const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
    const login = id ? (await hub(env).session(id))?.login : null
    if (!id || !login) return errorResponse(401, "Unauthorized", "sign in required")
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kestrel</title><style>body{background:#0e1014;color:#e4e7ee;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head><body><p>Signing in to Kestrel mobile...</p><script>window.location.href="kestrel://auth-callback?session=" + encodeURIComponent("${id}");</script></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    )
  }

  if (path === ControlPaths.logout && request.method === "POST") {
    const id = readCookie(request.headers.get("cookie"), SESSION_COOKIE)
    if (id) await hub(env).deleteSession(id)
    return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie("", 0) } })
  }

  const connect = /^\/auth\/connect\/([a-z0-9-]+)(\/callback)?$/.exec(path)
  if (connect && connect[1] !== undefined && request.method === "GET") {
    const providerId = connect[1]
    if (connect[2] !== undefined) return finishOAuth(request, env, url, providerId)

    const provider = findProvider(providerId)
    if (!provider || provider.kind !== "oauth") return errorResponse(404, "NotFound", `unknown provider ${providerId}`)
    if (!(await currentSession(request, env))) return errorResponse(401, "Unauthorized", "sign in required")
    const returnTo = safeReturnPath(url.searchParams.get("return"), "/connections")
    return beginOAuth(env, url, "connect", provider, returnTo)
  }

  // Dev-only sign-in: exists only when DEV_SESSION_LOGIN is set. Never set it in production.
  if (path === "/auth/dev-login" && env.DEV_SESSION_LOGIN && request.method === "GET") {
    const login = env.DEV_SESSION_LOGIN
    const stub = hub(env)
    await stub.upsertUser({ login, name: login, avatarUrl: "" })
    const sessionId = randomToken(32)
    await stub.createSession(sessionId, login, Date.now() + SESSION_TTL_MS, true)
    return redirect("/", { "set-cookie": sessionCookie(sessionId, SESSION_TTL_MS / 1000) })
  }

  return errorResponse(404, "NotFound", `no route for ${path}`)
}

