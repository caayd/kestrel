import { DurableObject } from "cloudflare:workers"
import { Option, Schema } from "effect"
import {
  CREDENTIALS_HEADER,
  Paths,
  RELAY_CONNECT_PATH,
  RELAY_PROTOCOL_VERSION,
  AutomationTrigger,
  decodeBinary,
  decodeFrame,
  encodeBinary,
  encodeFrame,
  fromBase64,
  toBase64,
  type Automation,
  type AutomationRun,
  type BoxStatus,
  type CreateAutomationBody,
  type CreateTaskBody,
  type RelayCredentials,
  type RelayFrame,
  type UpdateAutomationBody,
} from "@cloudagents/protocol"
import { errorResponse, headersToRecord, isHopByHop } from "./http"
import { matchGithubTrigger, type PullRequestEvent, type PullRequestInfo } from "./github"
import { localDate, nextFireTime } from "./cron"
import { claimHookRow, type HookRow } from "./hooks"
import { ensureAutomationsTable } from "./automations-table"
import { composePrompt } from "./prompt"
import type { Env } from "./env"

/**
 * Singleton Durable Object (`idFromName("main")`) holding all control-plane state and the
 * outbound relay to the agent box.
 *
 * - SQLite tables: users, sessions, connections, oauth_states, automations, automation_runs, github_hooks,
 *   webhook_deliveries.
 * - The box holds one hibernatable WebSocket (tag "box"); its metadata lives in the socket attachment.
 * - Browser HTTP requests are tunnelled as `http` frames and resolved by `http-res` (30s timeout → 504).
 * - Browser WebSockets are accepted with the standard API (they pin the object in memory) and
 *   piped to the box as `ws-open` / `ws-text` / binary / `ws-close`.
 *
 * Methods are RPC-callable from the Worker; `fetch` handles `/box/connect` and tunnelled `/api/*`.
 */

const BOX_TAG = "box"
const HTTP_TIMEOUT_MS = 30_000
/** Close code sent to browsers when the box goes away (custom range; 1001 is not settable). */
const BOX_GONE_CLOSE_CODE = 4001

/** Recent runs kept per automation. */
const RUNS_KEPT = 50
/** How long webhook delivery ids are remembered for deduplication. */
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000

/** Response of `POST /api/repos/:id/tasks`. */
const CreatedTask = Schema.Struct({ id: Schema.String })
/** Error body of box responses (`{ _tag, message }`). */
const BoxErrorBody = Schema.Struct({ message: Schema.String })

/** Result of a box request; `body` is the raw response text. */
export type BoxResult = { ok: boolean; status: number; body: string }

/** Outcome of starting a task for a run. `error` is null when the task started. */
type RunOutcome = { taskId: string | null; error: string | null }

type AutomationRow = {
  id: string
  login: string
  name: string
  repo: string | null
  prompt: string
  enabled: number
  triggerJson: string
  nextRunAt: number | null
  createdAt: string
  updatedAt: string
}

const AUTOMATION_COLUMNS =
  "id, login, name, repo, prompt, enabled, trigger_json AS triggerJson, next_run_at AS nextRunAt, created_at AS createdAt, updated_at AS updatedAt"

const decodeTrigger = (json: string): AutomationTrigger => Schema.decodeUnknownSync(AutomationTrigger)(JSON.parse(json))

/** Next fire (epoch ms) after `now` for an enabled schedule; null for everything else. */
const nextRunMs = (trigger: AutomationTrigger, enabled: boolean, now: number): number | null =>
  enabled && trigger._tag === "schedule" ? nextFireTime(trigger.cron, trigger.timezone, now) : null

const automationView = (row: AutomationRow): Automation => ({
  id: row.id,
  name: row.name,
  repo: row.repo,
  prompt: row.prompt,
  enabled: row.enabled === 1,
  trigger: decodeTrigger(row.triggerJson),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  nextRunAt: row.nextRunAt === null ? null : new Date(row.nextRunAt).toISOString(),
})

const decodeJson = <A, I>(schema: Schema.Schema<A, I>, text: string): A | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return Option.getOrNull(Schema.decodeUnknownOption(schema)(value))
}

const boxError = (res: BoxResult): string =>
  decodeJson(BoxErrorBody, res.body)?.message ?? `agent box responded ${res.status}`

/** Headers the box must never see from the browser. Hop-by-hop headers are dropped by `headersToRecord`. */
const DROP_FOR_BOX: Record<string, true> = {
  cookie: true,
  authorization: true,
  "sec-websocket-key": true,
  "sec-websocket-version": true,
  "sec-websocket-extensions": true,
  "sec-websocket-protocol": true,
  "sec-websocket-accept": true,
}

/** Status codes whose responses must not carry a body. */
const NULL_BODY_STATUS: Record<number, true> = { 101: true, 103: true, 204: true, 205: true, 304: true }

export type OAuthKind = "login" | "connect"

export type UserRecord = { login: string; name: string | null; avatarUrl: string }

/** `dev`: the session came from `/auth/dev-login`. */
export type SessionRecord = { login: string; dev: boolean }

export type OAuthStateRecord = { kind: OAuthKind; provider: string; returnTo: string }

type PendingHttp = { resolve: (res: Response) => void; timer: number }

type BoxAttachment = { connectedAt: string; boxVersion: string | null }

type HttpFrame = Extract<RelayFrame, { t: "http" }>

/** Valid close code for WebSocket.close(): 1000 or 3000–4999; anything else becomes 1000. */
const closeCode = (code: number | undefined): number =>
  code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000

const closeQuietly = (ws: WebSocket, code: number, reason: string): void => {
  try {
    ws.close(code, reason)
  } catch {
    // already closed
  }
}

export class Hub extends DurableObject<Env> {
  private readonly pending = new Map<number, PendingHttp>()
  private readonly streams = new Map<number, WebSocket>()
  private nextId = 1

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql
      sql.exec(`CREATE TABLE IF NOT EXISTS users (
        login TEXT PRIMARY KEY,
        name TEXT,
        avatar_url TEXT NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        dev INTEGER NOT NULL DEFAULT 0
      )`)
      // Sessions tables created before the `dev` column get it here; existing rows are not dev sessions.
      const sessionColumns = sql.exec<{ name: string }>("PRAGMA table_info(sessions)").toArray()
      if (!sessionColumns.some((c) => c.name === "dev")) {
        sql.exec("ALTER TABLE sessions ADD COLUMN dev INTEGER NOT NULL DEFAULT 0")
      }
      sql.exec(`CREATE TABLE IF NOT EXISTS connections (
        login TEXT NOT NULL,
        provider TEXT NOT NULL,
        secret TEXT NOT NULL,
        account TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (login, provider)
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
      ctx.storage.transactionSync(() => ensureAutomationsTable(sql))
      sql.exec(`CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        fired_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        error TEXT
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS github_hooks (
        repo TEXT PRIMARY KEY,
        hook_id INTEGER NOT NULL,
        secret TEXT NOT NULL
      )`)
      sql.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      )`)
    })
  }

  // -------------------------------------------------------------------------
  // Users and sessions
  // -------------------------------------------------------------------------

  upsertUser(user: UserRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (login, name, avatar_url) VALUES (?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url`,
      user.login,
      user.name,
      user.avatarUrl,
    )
  }

  getUser(login: string): UserRecord | null {
    const row = this.ctx.storage.sql
      .exec<{ login: string; name: string | null; avatarUrl: string }>(
        "SELECT login, name, avatar_url AS avatarUrl FROM users WHERE login = ?",
        login,
      )
      .toArray()[0]
    return row ?? null
  }

  /** `dev` marks a session from `/auth/dev-login`. */
  createSession(id: string, login: string, expiresAt: number, dev: boolean): void {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now())
    sql.exec("INSERT INTO sessions (id, login, expires_at, dev) VALUES (?, ?, ?, ?)", id, login, expiresAt, dev ? 1 : 0)
  }

  /** The live session with this id, or null when unknown or expired. */
  session(id: string): SessionRecord | null {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now())
    const row = sql.exec<{ login: string; dev: number }>("SELECT login, dev FROM sessions WHERE id = ?", id).toArray()[0]
    return row ? { login: row.login, dev: row.dev === 1 } : null
  }

  deleteSession(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", id)
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** Connected providers for a user (secrets are not returned). */
  connections(login: string): { provider: string; account: string | null }[] {
    return this.ctx.storage.sql
      .exec<{ provider: string; account: string | null }>(
        "SELECT provider, account FROM connections WHERE login = ?",
        login,
      )
      .toArray()
  }

  putConnection(login: string, provider: string, secret: string, account: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (login, provider, secret, account, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(login, provider) DO UPDATE SET
         secret = excluded.secret, account = excluded.account, updated_at = excluded.updated_at`,
      login,
      provider,
      secret,
      account,
      Date.now(),
    )
  }

  deleteConnection(login: string, provider: string): void {
    this.ctx.storage.sql.exec("DELETE FROM connections WHERE login = ? AND provider = ?", login, provider)
  }

  /** Secrets forwarded to the box in the `x-cloudagents-credentials` header. */
  credentials(login: string): RelayCredentials {
    const out: { user: string; github?: string; anthropic?: string; openai?: string } = { user: login }
    const rows = this.ctx.storage.sql
      .exec<{ provider: string; secret: string }>("SELECT provider, secret FROM connections WHERE login = ?", login)
      .toArray()
    for (const row of rows) {
      switch (row.provider) {
        case "github":
          out.github = row.secret
          break
        case "anthropic":
          out.anthropic = row.secret
          break
        case "openai":
          out.openai = row.secret
          break
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // OAuth state (single use, 10 minutes)
  // -------------------------------------------------------------------------

  createOAuthState(state: string, kind: OAuthKind, provider: string, returnTo: string, expiresAt: number): void {
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM oauth_states WHERE expires_at <= ?", Date.now())
    sql.exec(
      "INSERT INTO oauth_states (state, kind, provider, return_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      state,
      kind,
      provider,
      returnTo,
      expiresAt,
    )
  }

  /** Deletes the state row and returns it if it existed and has not expired. */
  consumeOAuthState(state: string): OAuthStateRecord | null {
    const sql = this.ctx.storage.sql
    const row = sql
      .exec<{ kind: OAuthKind; provider: string; returnTo: string; expiresAt: number }>(
        "SELECT kind, provider, return_to AS returnTo, expires_at AS expiresAt FROM oauth_states WHERE state = ?",
        state,
      )
      .toArray()[0]
    sql.exec("DELETE FROM oauth_states WHERE state = ?", state)
    if (!row || row.expiresAt <= Date.now()) return null
    return { kind: row.kind, provider: row.provider, returnTo: row.returnTo }
  }

  // -------------------------------------------------------------------------
  // Box presence
  // -------------------------------------------------------------------------

  boxStatus(): BoxStatus {
    const ws = this.ctx.getWebSockets(BOX_TAG)[0]
    if (!ws) return { online: false, connectedAt: null, boxVersion: null }
    const att = this.attachment(ws)
    return { online: true, connectedAt: att.connectedAt, boxVersion: att.boxVersion }
  }

  // -------------------------------------------------------------------------
  // Box calls: one request to the box with `login`'s credentials
  // -------------------------------------------------------------------------

  boxCall(login: string, method: "GET" | "POST", path: string, payload?: unknown): Promise<BoxResult> {
    const box = this.ctx.getWebSockets(BOX_TAG)[0]
    if (!box) {
      return Promise.resolve({ ok: false, status: 503, body: JSON.stringify({ message: "agent box is not connected" }) })
    }
    const headers: Record<string, string> = { [CREDENTIALS_HEADER]: JSON.stringify(this.credentials(login)) }
    const body = payload === undefined ? undefined : new TextEncoder().encode(JSON.stringify(payload))
    if (body !== undefined) headers["content-type"] = "application/json"
    const frame: HttpFrame = {
      t: "http",
      id: this.allocId(),
      method,
      path,
      headers,
      ...(body ? { body: toBase64(body) } : {}),
    }
    return this.request(box, frame).then(async (res) => ({ ok: res.ok, status: res.status, body: await res.text() }))
  }

  // -------------------------------------------------------------------------
  // Automations: stored per user; schedules fire from the alarm, GitHub triggers from webhook deliveries
  // -------------------------------------------------------------------------

  automations(login: string): Automation[] {
    return this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE login = ? ORDER BY created_at`, login)
      .toArray()
      .map(automationView)
  }

  automation(login: string, id: string): Automation | null {
    const row = this.automationRow(login, id)
    return row === null ? null : automationView(row)
  }

  async createAutomation(login: string, input: Omit<CreateAutomationBody, "repo"> & { repo: string | null }): Promise<Automation> {
    const now = Date.now()
    const enabled = input.enabled ?? true
    const row: AutomationRow = {
      id: crypto.randomUUID(),
      login,
      name: input.name,
      repo: input.repo,
      prompt: input.prompt,
      enabled: enabled ? 1 : 0,
      triggerJson: JSON.stringify(input.trigger),
      nextRunAt: nextRunMs(input.trigger, enabled, now),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO automations (id, login, name, repo, prompt, enabled, trigger_json, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.login,
      row.name,
      row.repo,
      row.prompt,
      row.enabled,
      row.triggerJson,
      row.nextRunAt,
      row.createdAt,
      row.updatedAt,
    )
    await this.rearm()
    return automationView(row)
  }

  async updateAutomation(login: string, id: string, changes: UpdateAutomationBody): Promise<Automation | null> {
    const current = this.automationRow(login, id)
    if (current === null) return null
    const now = Date.now()
    const trigger = changes.trigger ?? decodeTrigger(current.triggerJson)
    const enabled = changes.enabled ?? current.enabled === 1
    const next: AutomationRow = {
      ...current,
      name: changes.name ?? current.name,
      prompt: changes.prompt ?? current.prompt,
      enabled: enabled ? 1 : 0,
      triggerJson: JSON.stringify(trigger),
      nextRunAt: nextRunMs(trigger, enabled, now),
      updatedAt: new Date(now).toISOString(),
    }
    this.ctx.storage.sql.exec(
      "UPDATE automations SET name = ?, prompt = ?, enabled = ?, trigger_json = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND login = ?",
      next.name,
      next.prompt,
      next.enabled,
      next.triggerJson,
      next.nextRunAt,
      next.updatedAt,
      id,
      login,
    )
    await this.rearm()
    return automationView(next)
  }

  async deleteAutomation(login: string, id: string): Promise<boolean> {
    if (this.automationRow(login, id) === null) return false
    const sql = this.ctx.storage.sql
    sql.exec("DELETE FROM automation_runs WHERE automation_id = ?", id)
    sql.exec("DELETE FROM automations WHERE id = ? AND login = ?", id, login)
    await this.rearm()
    return true
  }

  /** Recent runs, newest first; null when the automation is not `login`'s. */
  automationRuns(login: string, id: string): AutomationRun[] | null {
    if (this.automationRow(login, id) === null) return null
    return this.ctx.storage.sql
      .exec<AutomationRun>(
        `SELECT id, automation_id AS automationId, fired_at AS firedAt, reason, status, task_id AS taskId, error
         FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?`,
        id,
        RUNS_KEPT,
      )
      .toArray()
  }

  /** Manual "run now" (or any caller-supplied reason); null when the automation is not `login`'s. */
  async fireAutomation(
    login: string,
    id: string,
    reason: string,
    pr: PullRequestInfo | null,
  ): Promise<AutomationRun | null> {
    const row = this.automationRow(login, id)
    return row === null ? null : this.fire(row, reason, pr)
  }

  /**
   * Records one pull request webhook delivery and starts a task for every enabled GitHub automation on the
   * repository whose trigger matches. Runs happen after the response (`waitUntil`), so GitHub gets a fast 202.
   */
  githubDelivery(deliveryId: string, event: PullRequestEvent): { duplicate: boolean; matched: number } {
    const sql = this.ctx.storage.sql
    const now = Date.now()
    if (sql.exec("SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?", deliveryId).toArray().length > 0) {
      return { duplicate: true, matched: 0 }
    }
    sql.exec("INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)", deliveryId, now)
    sql.exec("DELETE FROM webhook_deliveries WHERE received_at < ?", now - DELIVERY_RETENTION_MS)
    const rows = sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND repo COLLATE NOCASE = ?`, event.repo)
      .toArray()
    let matched = 0
    for (const row of rows) {
      const trigger = decodeTrigger(row.triggerJson)
      if (trigger._tag !== "github") continue
      const reason = matchGithubTrigger(trigger, event)
      if (reason === null) continue
      matched++
      this.ctx.waitUntil(this.fire(row, reason, event.pr))
    }
    return { duplicate: false, matched }
  }

  /** The webhook for a repository (key: lowercase "owner/name"), or null when none was created. */
  githubHook(repo: string): { hookId: number; secret: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ hookId: number; secret: string }>("SELECT hook_id AS hookId, secret FROM github_hooks WHERE repo = ?", repo)
        .toArray()[0] ?? null
    )
  }

  /** Stores a new hook unless the row changed since `expectedHookId` was read (see `claimHookRow`). */
  claimGithubHook(repo: string, expectedHookId: number | null, hookId: number, secret: string): HookRow {
    return claimHookRow(this.ctx.storage.sql, repo, expectedHookId, hookId, secret)
  }

  deleteGithubHook(repo: string): void {
    this.ctx.storage.sql.exec("DELETE FROM github_hooks WHERE repo = ?", repo)
  }

  /** True when an enabled GitHub automation still needs the repository's webhook. */
  githubHookInUse(repo: string): boolean {
    return this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND repo COLLATE NOCASE = ?`, repo)
      .toArray()
      .some((row) => decodeTrigger(row.triggerJson)._tag === "github")
  }

  override async alarm(): Promise<void> {
    const now = Date.now()
    const due = this.ctx.storage.sql
      .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE enabled = 1 AND next_run_at <= ?`, now)
      .toArray()
    for (const row of due) {
      this.ctx.storage.sql.exec(
        "UPDATE automations SET next_run_at = ? WHERE id = ?",
        nextRunMs(decodeTrigger(row.triggerJson), true, now),
        row.id,
      )
      await this.fire(row, "schedule", null)
    }
    await this.rearm()
  }

  private automationRow(login: string, id: string): AutomationRow | null {
    return (
      this.ctx.storage.sql
        .exec<AutomationRow>(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE id = ? AND login = ?`, id, login)
        .toArray()[0] ?? null
    )
  }

  /** Points the alarm at the earliest pending schedule, or clears it when none is pending. */
  private async rearm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ at: number | null }>("SELECT MIN(next_run_at) AS at FROM automations WHERE enabled = 1")
      .toArray()[0]
    const at = row?.at ?? null
    if (at === null) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }

  private async fire(row: AutomationRow, reason: string, pr: PullRequestInfo | null): Promise<AutomationRun> {
    const now = Date.now()
    const trigger = decodeTrigger(row.triggerJson)
    const timeZone = trigger._tag === "schedule" ? trigger.timezone : "UTC"
    const title = pr === null ? `${row.name} · ${localDate(now, timeZone)}` : `${row.name} · PR #${pr.number}`
    const prompt = composePrompt({ name: row.name, prompt: row.prompt, reason, repo: row.repo, pr })
    // A PR run checks the repository out at the PR head; the base branch stays the diff base.
    const checkout =
      row.repo === null
        ? {}
        : { checkout: { repo: row.repo, ...(pr === null ? {} : { baseBranch: pr.baseRef, pullRequest: pr.number }) } }
    const outcome = await this.startTask(row.login, { title, ...checkout }, prompt)
    return this.recordRun(row.id, reason, now, outcome)
  }

  /** Creates the task (with its repository checked out, if any) and sends the prompt to start its run. */
  private async startTask(login: string, body: CreateTaskBody, prompt: string): Promise<RunOutcome> {
    const created = await this.boxCall(login, "POST", Paths.tasks, body)
    if (!created.ok) return { taskId: null, error: boxError(created) }
    const task = decodeJson(CreatedTask, created.body)
    if (task === null) return { taskId: null, error: "agent box returned an unexpected task" }
    const sent = await this.boxCall(login, "POST", Paths.taskMessages(task.id), { text: prompt })
    return sent.ok ? { taskId: task.id, error: null } : { taskId: task.id, error: boxError(sent) }
  }

  private recordRun(automationId: string, reason: string, firedAt: number, outcome: RunOutcome): AutomationRun {
    const run: AutomationRun = {
      id: crypto.randomUUID(),
      automationId,
      firedAt: new Date(firedAt).toISOString(),
      reason,
      status: outcome.error === null ? "started" : "failed",
      taskId: outcome.taskId,
      error: outcome.error,
    }
    const sql = this.ctx.storage.sql
    sql.exec(
      "INSERT INTO automation_runs (id, automation_id, fired_at, reason, status, task_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      run.id,
      run.automationId,
      run.firedAt,
      run.reason,
      run.status,
      run.taskId,
      run.error,
    )
    sql.exec(
      `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (
         SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT ?)`,
      automationId,
      automationId,
      RUNS_KEPT,
    )
    return run
  }

  // -------------------------------------------------------------------------
  // Worker-facing fetch: /box/connect (box upgrade) and /api/* (tunnelled to the box)
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === RELAY_CONNECT_PATH) return this.acceptBox(request)
    if (url.pathname.startsWith("/api/")) return this.relay(request, url)
    return errorResponse(404, "NotFound", `no route for ${url.pathname}`)
  }

  private acceptBox(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "UpgradeRequired", "expected a WebSocket upgrade")
    }
    // Latest connection wins: fail anything in flight on the previous box and drop its socket.
    this.failAll()
    for (const old of this.ctx.getWebSockets(BOX_TAG)) closeQuietly(old, 4000, "replaced")

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const attachment: BoxAttachment = { connectedAt: new Date().toISOString(), boxVersion: null }
    this.ctx.acceptWebSocket(server, [BOX_TAG])
    server.serializeAttachment(attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  private async relay(request: Request, url: URL): Promise<Response> {
    const box = this.ctx.getWebSockets(BOX_TAG)[0]
    if (!box) return errorResponse(503, "BoxOffline", "agent box is not connected")

    const path = url.pathname + url.search
    const headers = headersToRecord(request.headers, DROP_FOR_BOX)

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.openStream(box, path, headers)
    }

    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer())
    const frame: HttpFrame = {
      t: "http",
      id: this.allocId(),
      method: request.method,
      path,
      headers,
      ...(body && body.byteLength > 0 ? { body: toBase64(body) } : {}),
    }
    return this.request(box, frame)
  }

  private request(box: WebSocket, frame: HttpFrame): Promise<Response> {
    const { promise, resolve } = Promise.withResolvers<Response>()
    const timer = setTimeout(() => {
      this.pending.delete(frame.id)
      resolve(errorResponse(504, "GatewayTimeout", "agent box did not respond in time"))
    }, HTTP_TIMEOUT_MS)
    this.pending.set(frame.id, { resolve, timer })
    try {
      box.send(encodeFrame(frame))
    } catch {
      clearTimeout(timer)
      this.pending.delete(frame.id)
      resolve(errorResponse(502, "BadGateway", "agent box is unreachable"))
    }
    return promise
  }

  private openStream(box: WebSocket, path: string, headers: Record<string, string>): Response {
    const id = this.allocId()
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    this.streams.set(id, server)

    server.addEventListener("message", (event) => {
      try {
        if (typeof event.data === "string") {
          box.send(encodeFrame({ t: "ws-text", id, data: event.data }))
        } else {
          box.send(encodeBinary(id, new Uint8Array(event.data)))
        }
      } catch {
        this.streams.delete(id)
        closeQuietly(server, 1000, "agent box unreachable")
      }
    })

    server.addEventListener("close", (event) => {
      if (this.streams.get(id) !== server) return
      this.streams.delete(id)
      try {
        box.send(encodeFrame({ t: "ws-close", id, code: closeCode(event.code), reason: (event.reason ?? "").slice(0, 40) }))
      } catch {
        // box already gone; failAll has or will close the rest
      }
      // Complete the closing handshake: without this the browser stays CLOSING and never drops the connection.
      closeQuietly(server, closeCode(event.code), "")
    })

    try {
      box.send(encodeFrame({ t: "ws-open", id, path, headers }))
    } catch {
      this.streams.delete(id)
      closeQuietly(server, 1000, "agent box unreachable")
      return errorResponse(502, "BadGateway", "agent box is unreachable")
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  // -------------------------------------------------------------------------
  // Box socket (hibernatable)
  // -------------------------------------------------------------------------

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string") {
      const frame = decodeFrame(message)
      if (frame) this.onFrame(ws, frame)
      return
    }
    const bin = decodeBinary(new Uint8Array(message))
    if (bin) this.streams.get(bin.id)?.send(bin.payload)
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    this.boxLost(ws)
    closeQuietly(ws, closeCode(code), "")
  }

  override webSocketError(ws: WebSocket): void {
    this.boxLost(ws)
    closeQuietly(ws, 1000, "")
  }

  private onFrame(ws: WebSocket, frame: RelayFrame): void {
    switch (frame.t) {
      case "hello":
        if (frame.version !== RELAY_PROTOCOL_VERSION) {
          closeQuietly(ws, 4002, "unsupported relay protocol version")
          return
        }
        ws.serializeAttachment({ ...this.attachment(ws), boxVersion: frame.boxVersion })
        return
      case "ping":
        ws.send(encodeFrame({ t: "pong" }))
        return
      case "http-res": {
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(this.toResponse(frame))
        return
      }
      case "ws-text":
        this.streams.get(frame.id)?.send(frame.data)
        return
      case "ws-close": {
        const s = this.streams.get(frame.id)
        this.streams.delete(frame.id)
        if (s) closeQuietly(s, closeCode(frame.code), (frame.reason ?? "").slice(0, 40))
        return
      }
      default:
        // pong, and frames only the control plane sends (http, ws-open)
        return
    }
  }

  private toResponse(frame: Extract<RelayFrame, { t: "http-res" }>): Response {
    const valid = frame.status >= 200 && frame.status <= 599
    const status = valid ? frame.status : 502
    const headers = new Headers()
    for (const [name, value] of Object.entries(frame.headers)) {
      if (!isHopByHop(name)) headers.set(name, value)
    }
    const body = frame.body && NULL_BODY_STATUS[status] !== true ? fromBase64(frame.body) : null
    return new Response(body, { status, headers })
  }

  private boxLost(ws: WebSocket): void {
    // A replaced box closes after its successor attached; only a true disconnect fails in-flight work.
    if (this.ctx.getWebSockets(BOX_TAG).some((s) => s !== ws)) return
    this.failAll()
  }

  private failAll(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve(errorResponse(502, "BadGateway", "agent box disconnected"))
    }
    this.pending.clear()
    for (const s of this.streams.values()) closeQuietly(s, BOX_GONE_CLOSE_CODE, "agent box disconnected")
    this.streams.clear()
  }

  private attachment(ws: WebSocket): BoxAttachment {
    const att = ws.deserializeAttachment() as BoxAttachment | null
    return att ?? { connectedAt: new Date(0).toISOString(), boxVersion: null }
  }

  private allocId(): number {
    const id = this.nextId
    this.nextId = id >= 0xffffffff ? 1 : id + 1
    return id
  }
}
