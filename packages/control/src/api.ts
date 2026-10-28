import { Schema } from "effect"
import {
  CREDENTIALS_HEADER,
  CliAuthStatus,
  ControlPaths,
  PutApiKeyBody,
  type BoxStatus,
  type Connection,
  type GithubRepo,
  type Me,
  type RelayCredentials,
} from "@cloudagents/protocol"
import {
  PROVIDERS,
  findProvider,
  isAvailable,
  type ApiKeyProvider,
  type CliProvider,
  type OAuthProvider,
  type Provider,
} from "./providers"
import { UpstreamError, errorResponse, json, maskKey } from "./http"
import { hub, type Env } from "./env"
import { currentSession } from "./auth"
import type { SessionRecord } from "./hub"
import { handleAutomations } from "./automations"

type ConnectionRow = { provider: string; account: string | null }

const storedView = (provider: OAuthProvider | ApiKeyProvider, row: ConnectionRow | undefined, env: Env): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: row !== undefined,
  account: row?.account ?? null,
  available: isAvailable(provider, env),
})

const cliView = (provider: CliProvider, status: CliAuthStatus | undefined): Connection => ({
  provider: provider.id,
  label: provider.label,
  kind: provider.kind,
  connected: status?.loggedIn ?? false,
  account: status?.loggedIn ? status.account : null,
  available: status !== undefined,
})

/** Devbox CLI logins as the box reports them; empty when the box is offline or answers badly. */
const fetchCliAuth = async (login: string, env: Env): Promise<readonly CliAuthStatus[]> => {
  const creds = await hub(env).credentials(login)
  const headers = new Headers({ [CREDENTIALS_HEADER]: JSON.stringify(creds) })
  const res = await hub(env).fetch(new Request(`https://hub${ControlPaths.cliAuth}`, { headers }))
  if (!res.ok) return []
  const body: unknown = await res.json().catch(() => null)
  return Schema.is(Schema.Array(CliAuthStatus))(body) ? body : []
}

const listConnections = async (login: string, env: Env): Promise<Connection[]> => {
  const [rows, cli] = await Promise.all([hub(env).connections(login), fetchCliAuth(login, env)])
  return PROVIDERS.map((p) =>
    p.kind === "cli"
      ? cliView(p, cli.find((s) => s.provider === p.id))
      : storedView(p, rows.find((r) => r.provider === p.id), env),
  )
}

const putApiKey = async (request: Request, env: Env, login: string, provider: Provider): Promise<Response> => {
  if (provider.kind !== "apikey") {
    return errorResponse(400, "BadRequest", `${provider.label} connects through OAuth at /auth/connect/${provider.id}`)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, "BadRequest", "body must be JSON")
  }
  if (!Schema.is(PutApiKeyBody)(body)) {
    return errorResponse(400, "BadRequest", "apiKey must be a string of at least 8 characters")
  }
  const account = maskKey(body.apiKey)
  await hub(env).putConnection(login, provider.id, body.apiKey, account)
  return json(storedView(provider, { provider: provider.id, account }, env))
}

const listRepos = async (env: Env, login: string): Promise<Response> => {
  const creds = await hub(env).credentials(login)
  if (!creds.github) return errorResponse(404, "NotFound", "GitHub is not connected")
  const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
    headers: {
      authorization: `Bearer ${creds.github}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kestrel-control-plane",
    },
  })
  if (!res.ok) throw new UpstreamError(`GitHub repos responded ${res.status}`)
  const raw = (await res.json()) as {
    full_name: string
    clone_url: string
    private: boolean
    default_branch: string
    updated_at: string
  }[]
  const repos: GithubRepo[] = raw.map((r) => ({
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    private: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }))
  return json(repos)
}

/** Forwards a browser request to the box with the caller's credentials (and dev-login marker) attached. */
const relayToBox = async (request: Request, env: Env, session: SessionRecord, url: URL): Promise<Response> => {
  const creds = await hub(env).credentials(session.login)
  const relayed: RelayCredentials = session.dev ? { ...creds, dev: true } : creds
  const headers = new Headers(request.headers)
  headers.set(CREDENTIALS_HEADER, JSON.stringify(relayed))
  const hasBody = request.method !== "GET" && request.method !== "HEAD"
  const forwarded = new Request(`https://hub${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
  })
  return hub(env).fetch(forwarded)
}

/** Routes every `/api/*` request: control routes in the Worker, everything else relayed to the box. */
export const handleApi = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await currentSession(request, env)
  if (!session) return errorResponse(401, "Unauthorized", "sign in required")
  const login = session.login

  const path = url.pathname
  const method = request.method

  if (path === ControlPaths.me && method === "GET") {
    const user = await hub(env).getUser(login)
    if (!user) return errorResponse(401, "Unauthorized", "unknown user")
    const me: Me = { login: user.login, name: user.name, avatarUrl: user.avatarUrl }
    return json(me)
  }

  if (path === ControlPaths.connections && method === "GET") {
    return json(await listConnections(login, env))
  }

  const connection = /^\/api\/connections\/([a-z0-9-]+)$/.exec(path)
  if (connection && connection[1] !== undefined) {
    const provider = findProvider(connection[1])
    if (!provider) return errorResponse(404, "NotFound", `unknown provider ${connection[1]}`)
    if (provider.kind === "cli") {
      return errorResponse(400, "BadRequest", `${provider.label} connects from the Connections page`)
    }
    if (method === "PUT") return putApiKey(request, env, login, provider)
    if (method === "DELETE") {
      await hub(env).deleteConnection(login, provider.id)
      return new Response(null, { status: 204 })
    }
    return errorResponse(405, "MethodNotAllowed", `${method} not allowed`)
  }

  if (path === ControlPaths.githubRepos && method === "GET") {
    return listRepos(env, login)
  }

  if (path === ControlPaths.box && method === "GET") {
    const status: BoxStatus = await hub(env).boxStatus()
    return json(status)
  }

  if (path === ControlPaths.automations || path.startsWith(`${ControlPaths.automations}/`)) {
    return handleAutomations(request, env, login, url, ControlPaths.automations)
  }

  return relayToBox(request, env, session, url)
}
