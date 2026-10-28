import type { AgentItem } from "@cloudagents/protocol"

/**
 * Turns one harness's stdout lines into the normalized `AgentItem`s the app renders.
 * One parser per run: it remembers tool calls (so a result can complete them) and the
 * final assistant text. Both harnesses are detected per line by shape, so a fixture or a
 * recording can be fed without saying which CLI produced it.
 */
export interface Transcript {
  /** Items added or replaced by one parsed stdout line. Unknown lines yield none. */
  readonly push: (line: unknown) => ReadonlyArray<AgentItem>
  /** Final assistant text of the run, once the harness has reported it. */
  readonly finalText: () => string | null
}

/** Claude `stream-json` line types. */
const CLAUDE_LINE_TYPES: Readonly<Record<string, true>> = {
  system: true,
  assistant: true,
  user: true,
  result: true,
  stream_event: true,
}
/** Codex `exec --json` line types. */
const CODEX_LINE_TYPE = /^(thread|turn|item)\.[a-z_]+$|^error$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null)

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/** Token counts reported as separate buckets: null only when none of them is present. */
const sumTokens = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((n): n is number => n !== null)
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0)
}

/** A tool result's content as plain text; images have no text of their own. */
const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content
  const parts: string[] = []
  for (const part of asArray(content)) {
    if (typeof part === "string") {
      parts.push(part)
      continue
    }
    if (!isRecord(part)) continue
    const kind = asString(part.type)
    if (kind === "text") parts.push(asString(part.text) ?? "")
    else if (kind === "image") parts.push("[image]")
    else parts.push(`[${kind ?? "unknown"}]`)
  }
  return parts.join("\n")
}

/** Codex tool payloads are JSON values; strings stay as they are, the rest is shown as JSON. */
const outputText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? null
}

/** One Claude `tool_use` block, remembered until its `tool_result` arrives. */
interface ToolCall {
  readonly name: string
  readonly parentToolId: string | null
  readonly input: unknown
}

export const makeTranscript = (): Transcript => {
  /**
   * Ids for items the harness does not name. Unique per run: the same id later means
   * "replace that item", so counter ids are never reused.
   */
  let counter = 0
  const nextId = (): string => `c${++counter}`

  let finalTextValue: string | null = null
  const tools = new Map<string, ToolCall>()
  /** Start of the current Codex turn; Codex reports no durations of its own. */
  let turnStartedAt: number | null = null

  const claudeAssistant = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    if (!isRecord(line.message)) return []
    // Claude Code prints every content block of one API message as its own line with the same
    // message id, so ids must come from a counter, not the message id.
    const parentToolId = asString(line.parent_tool_use_id)
    const items: AgentItem[] = []
    for (const block of asArray(line.message.content)) {
      if (!isRecord(block)) continue
      const kind = asString(block.type)
      if (kind === "text") {
        const text = asString(block.text)
        if (text === null || text.trim() === "") continue
        items.push({ _tag: "text", id: nextId(), parentToolId, text })
      } else if (kind === "thinking") {
        const text = asString(block.thinking)
        if (text === null || text.trim() === "") continue
        items.push({ _tag: "thinking", id: nextId(), parentToolId, text })
      } else if (kind === "tool_use") {
        const id = asString(block.id)
        const name = asString(block.name)
        if (id === null || name === null) continue
        const input = block.input ?? null
        tools.set(id, { name, parentToolId, input })
        items.push({ _tag: "tool", id, parentToolId, name, input, status: "running", output: null })
      }
    }
    return items
  }

  const claudeUser = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    if (!isRecord(line.message)) return []
    const items: AgentItem[] = []
    for (const block of asArray(line.message.content)) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      const id = asString(block.tool_use_id)
      if (id === null) continue
      const call = tools.get(id)
      items.push({
        _tag: "tool",
        id,
        // A result inside a subagent carries the Task call it belongs to.
        parentToolId: call?.parentToolId ?? asString(line.parent_tool_use_id),
        name: call?.name ?? "tool",
        input: call?.input ?? null,
        status: block.is_error === true ? "error" : "ok",
        output: toolResultText(block.content),
      })
    }
    return items
  }

  const claudeResult = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    const subtype = asString(line.subtype) ?? "result"
    const isError = line.is_error === true
    const usage = isRecord(line.usage) ? line.usage : null
    const items: AgentItem[] = [
      {
        _tag: "turn",
        id: nextId(),
        durationMs: asNumber(line.duration_ms),
        // Claude splits prompt cost into fresh, cache-write and cache-read tokens; the model
        // read all three, so the reported input is their sum.
        inputTokens:
          usage === null
            ? null
            : sumTokens([
                asNumber(usage.input_tokens),
                asNumber(usage.cache_creation_input_tokens),
                asNumber(usage.cache_read_input_tokens),
              ]),
        outputTokens: usage === null ? null : asNumber(usage.output_tokens),
        costUsd: asNumber(line.total_cost_usd),
        isError,
      },
    ]
    const text = asString(line.result)
    if (text !== null && text.trim() !== "") {
      finalTextValue = text
    } else if (isError) {
      // Failed runs sometimes carry no text at all; surface why they stopped.
      items.push({ _tag: "error", id: nextId(), text: `claude result: ${subtype}` })
    }
    return items
  }

  const claude = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    switch (asString(line.type)) {
      case "assistant":
        return claudeAssistant(line)
      case "user":
        return claudeUser(line)
      case "result":
        return claudeResult(line)
      default:
        // system (init) and stream_event (partial messages) add display items.
        return []
    }
  }

  const codexItem = (eventType: string, raw: unknown): AgentItem | null => {
    if (!isRecord(raw)) return null
    const id = asString(raw.id)
    const kind = asString(raw.type)
    if (id === null || kind === null) return null
    const started = eventType === "item.started"
    const status = asString(raw.status)
    const inProgress = started || status === "in_progress"

    switch (kind) {
      case "agent_message": {
        const text = asString(raw.text)
        if (text === null) return null
        if (text.trim() !== "") finalTextValue = text
        return { _tag: "text", id, parentToolId: null, text }
      }
      case "reasoning": {
        const text = asString(raw.text)
        if (text === null || text.trim() === "") return null
        return { _tag: "thinking", id, parentToolId: null, text }
      }
      case "command_execution": {
        const exitCode = asNumber(raw.exit_code)
        const failed = status === "failed" || (exitCode !== null && exitCode !== 0)
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "command_execution",
          input: { command: asString(raw.command) ?? "" },
          status: inProgress ? "running" : failed ? "error" : "ok",
          output: outputText(raw.aggregated_output),
        }
      }
      case "file_change":
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "file_change",
          input: { changes: asArray(raw.changes) },
          status: inProgress ? "running" : status === "failed" ? "error" : "ok",
          output: null,
        }
      case "mcp_tool_call": {
        const server = asString(raw.server)
        const tool = asString(raw.tool)
        if (server === null || tool === null) return null
        const failed = (raw.error !== null && raw.error !== undefined) || status === "failed"
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: `${server}.${tool}`,
          input: raw.arguments ?? null,
          status: inProgress ? "running" : failed ? "error" : "ok",
          output: outputText(failed ? raw.error : raw.result),
        }
      }
      case "web_search":
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "web_search",
          input: { query: asString(raw.query) ?? "" },
          status: inProgress ? "running" : "ok",
          output: null,
        }
      case "todo_list":
        return {
          _tag: "tool",
          id,
          parentToolId: null,
          name: "todo_list",
          input: { items: asArray(raw.items) },
          status: inProgress ? "running" : "ok",
          output: null,
        }
      case "error":
        return { _tag: "error", id, text: asString(raw.message) ?? "codex error" }
      default:
        return null
    }
  }

  const codex = (line: Record<string, unknown>): ReadonlyArray<AgentItem> => {
    switch (asString(line.type)) {
      case "turn.started":
        turnStartedAt = Date.now()
        return []
      case "turn.completed": {
        const usage = isRecord(line.usage) ? line.usage : null
        const durationMs = turnStartedAt === null ? null : Date.now() - turnStartedAt
        turnStartedAt = null
        return [
          {
            _tag: "turn",
            id: nextId(),
            durationMs,
            // Codex's input_tokens already includes cached_input_tokens; adding them again
            // would double-count the prompt.
            inputTokens: usage === null ? null : asNumber(usage.input_tokens),
            outputTokens: usage === null ? null : asNumber(usage.output_tokens),
            costUsd: null,
            isError: false,
          },
        ]
      }
      case "turn.failed": {
        const error = isRecord(line.error) ? line.error : null
        const durationMs = turnStartedAt === null ? null : Date.now() - turnStartedAt
        turnStartedAt = null
        return [
          { _tag: "error", id: nextId(), text: asString(error?.message) ?? "codex turn failed" },
          { _tag: "turn", id: nextId(), durationMs, inputTokens: null, outputTokens: null, costUsd: null, isError: true },
        ]
      }
      case "error":
        return [{ _tag: "error", id: nextId(), text: asString(line.message) ?? "codex error" }]
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = codexItem(asString(line.type) ?? "item.completed", line.item)
        return item === null ? [] : [item]
      }
      default:
        return []
    }
  }

  return {
    push: (line) => {
      if (!isRecord(line)) return []
      const type = asString(line.type)
      if (type === null) return []
      if (CLAUDE_LINE_TYPES[type] === true) return claude(line)
      if (CODEX_LINE_TYPE.test(type)) return codex(line)
      return []
    },
    finalText: () => finalTextValue,
  }
}
