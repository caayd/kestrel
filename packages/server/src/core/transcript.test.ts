import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentItem } from "@cloudagents/protocol"
import { makeTranscript } from "./transcript"

/** Every item a parser reports must be a valid AgentItem (it crosses the WebSocket boundary). */
const valid = (items: ReadonlyArray<AgentItem>): ReadonlyArray<AgentItem> => {
  for (const item of items) Schema.decodeUnknownSync(AgentItem)(item)
  return items
}

const assistant = (content: ReadonlyArray<unknown>, parentToolUseId: string | null = null) => ({
  type: "assistant",
  message: { id: "msg_1", role: "assistant", content },
  parent_tool_use_id: parentToolUseId,
  uuid: "uuid-1",
})

const toolResult = (toolUseId: string, content: unknown, isError = false, parentToolUseId: string | null = null) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  parent_tool_use_id: parentToolUseId,
  uuid: "uuid-2",
})

describe("claude stream-json", () => {
  test("tool_use starts a tool and tool_result completes the same item", () => {
    const transcript = makeTranscript()
    const started = valid(
      transcript.push({
        type: "assistant",
        message: {
          id: "msg_1",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
        parent_tool_use_id: null,
        uuid: "uuid-1",
      }),
    )
    expect(started).toEqual([
      {
        _tag: "tool",
        id: "toolu_1",
        parentToolId: null,
        name: "Bash",
        input: { command: "ls" },
        status: "running",
        output: null,
      },
    ])

    const completed = valid(
      transcript.push(toolResult("toolu_1", [{ type: "text", text: "a.txt" }, { type: "image", source: {} }])),
    )
    expect(completed).toEqual([
      {
        _tag: "tool",
        id: "toolu_1",
        parentToolId: null,
        name: "Bash",
        input: { command: "ls" },
        status: "ok",
        output: "a.txt\n[image]",
      },
    ])

    const failed = valid(transcript.push(toolResult("toolu_1", "command failed", true)))
    expect(failed[0]).toMatchObject({ _tag: "tool", id: "toolu_1", status: "error", output: "command failed" })
  })

  test("content blocks printed on separate lines get distinct ids", () => {
    const transcript = makeTranscript()
    const first = valid(transcript.push(assistant([{ type: "text", text: "one" }])))
    const second = valid(
      transcript.push(assistant([{ type: "text", text: "two" }, { type: "thinking", thinking: "hmm" }])),
    )
    const ids = [...first, ...second].map((item) => item.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(second.map((item) => item._tag)).toEqual(["text", "thinking"])
  })

  test("result emits a turn item and the final text", () => {
    const transcript = makeTranscript()
    expect(
      valid(
        transcript.push({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1000,
          num_turns: 1,
          result: "all done",
          total_cost_usd: 0.25,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 20,
            output_tokens: 7,
          },
        }),
      ),
    ).toEqual([
      {
        _tag: "turn",
        id: expect.any(String),
        durationMs: 1234,
        inputTokens: 35,
        outputTokens: 7,
        costUsd: 0.25,
        isError: false,
      },
    ])
    expect(transcript.finalText()).toBe("all done")
  })

  test("an error result without text becomes an error item", () => {
    const transcript = makeTranscript()
    const items = valid(
      transcript.push({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        duration_ms: 10,
        duration_api_ms: 5,
        num_turns: 3,
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
    )
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ _tag: "turn", isError: true })
    expect(items[1]).toEqual({ _tag: "error", id: expect.any(String), text: "claude result: error_max_turns" })
    expect(transcript.finalText()).toBeNull()
  })

  test("subagent blocks carry the parent tool id", () => {
    const transcript = makeTranscript()
    valid(
      transcript.push(
        assistant([{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "look" } }]),
      ),
    )
    const subTool = valid(
      transcript.push(assistant([{ type: "tool_use", id: "toolu_sub", name: "Read", input: { file_path: "a" } }], "toolu_task")),
    )
    expect(subTool[0]).toMatchObject({ _tag: "tool", id: "toolu_sub", parentToolId: "toolu_task" })

    const subResult = valid(transcript.push(toolResult("toolu_sub", "contents", false, "toolu_task")))
    expect(subResult[0]).toMatchObject({ id: "toolu_sub", parentToolId: "toolu_task", status: "ok" })
  })

  test("system and stream_event lines produce nothing", () => {
    const transcript = makeTranscript()
    expect(transcript.push({ type: "system", subtype: "init", session_id: "s", tools: [] })).toEqual([])
    expect(transcript.push({ type: "stream_event", event: { type: "content_block_delta" } })).toEqual([])
    expect(transcript.push({ type: "mystery" })).toEqual([])
    expect(transcript.push("not an object")).toEqual([])
    expect(transcript.finalText()).toBeNull()
  })
})

describe("codex exec --json", () => {
  test("command_execution is upserted from started to completed", () => {
    const transcript = makeTranscript()
    expect(transcript.push({ type: "turn.started" })).toEqual([])
    const started = valid(
      transcript.push({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      }),
    )
    expect(started).toEqual([
      {
        _tag: "tool",
        id: "item_1",
        parentToolId: null,
        name: "command_execution",
        input: { command: "ls" },
        status: "running",
        output: "",
      },
    ])

    const completed = valid(
      transcript.push({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "a.txt\nb.txt\n",
          exit_code: 0,
          status: "completed",
        },
      }),
    )
    expect(completed[0]).toMatchObject({ id: "item_1", status: "ok", output: "a.txt\nb.txt\n" })

    const failed = valid(
      transcript.push({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "denied",
          exit_code: 1,
          status: "failed",
        },
      }),
    )
    expect(failed[0]).toMatchObject({ id: "item_1", status: "error", output: "denied" })
  })

  test("turn duration is measured and tokens come from the turn usage", () => {
    const transcript = makeTranscript()
    const realNow = Date.now
    try {
      let now = 1_000
      Date.now = () => now
      transcript.push({ type: "turn.started" })
      now = 1_345
      const items = valid(
        transcript.push({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            cache_write_input_tokens: 0,
            output_tokens: 9,
            reasoning_output_tokens: 2,
          },
        }),
      )
      expect(items).toEqual([
        {
          _tag: "turn",
          id: expect.any(String),
          durationMs: 345,
          inputTokens: 100,
          outputTokens: 9,
          costUsd: null,
          isError: false,
        },
      ])
    } finally {
      Date.now = realNow
    }
  })

  test("finalText is the last agent message", () => {
    const transcript = makeTranscript()
    const first = valid(
      transcript.push({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first" } }),
    )
    expect(first).toEqual([{ _tag: "text", id: "item_0", parentToolId: null, text: "first" }])
    valid(transcript.push({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "second" } }))
    expect(transcript.finalText()).toBe("second")
  })

  test("reasoning, file changes, mcp calls and web searches become display items", () => {
    const transcript = makeTranscript()
    expect(
      valid(transcript.push({ type: "item.completed", item: { id: "item_r", type: "reasoning", text: "thinking" } })),
    ).toEqual([{ _tag: "thinking", id: "item_r", parentToolId: null, text: "thinking" }])

    const fileChange = valid(
      transcript.push({
        type: "item.completed",
        item: { id: "item_f", type: "file_change", changes: [{ path: "a.ts", kind: "add" }], status: "completed" },
      }),
    )
    expect(fileChange[0]).toMatchObject({
      _tag: "tool",
      id: "item_f",
      name: "file_change",
      input: { changes: [{ path: "a.ts", kind: "add" }] },
      status: "ok",
    })

    const mcp = valid(
      transcript.push({
        type: "item.completed",
        item: {
          id: "item_m",
          type: "mcp_tool_call",
          server: "cloudagents",
          tool: "task_report",
          arguments: { status: "done" },
          result: { ok: true },
          error: null,
          status: "completed",
        },
      }),
    )
    expect(mcp[0]).toMatchObject({
      _tag: "tool",
      id: "item_m",
      name: "cloudagents.task_report",
      input: { status: "done" },
      status: "ok",
      output: '{"ok":true}',
    })

    const search = valid(
      transcript.push({ type: "item.completed", item: { id: "item_w", type: "web_search", query: "kestrel" } }),
    )
    expect(search[0]).toMatchObject({ _tag: "tool", name: "web_search", input: { query: "kestrel" }, status: "ok" })
  })

  test("turn.failed emits an error item plus a failed turn", () => {
    const transcript = makeTranscript()
    const realNow = Date.now
    try {
      let now = 5_000
      Date.now = () => now
      transcript.push({ type: "turn.started" })
      now = 5_050
      const items = valid(transcript.push({ type: "turn.failed", error: { message: "model exploded" } }))
      expect(items).toHaveLength(2)
      expect(items[0]).toEqual({ _tag: "error", id: expect.any(String), text: "model exploded" })
      expect(items[1]).toMatchObject({ _tag: "turn", durationMs: 50, inputTokens: null, outputTokens: null, isError: true })
    } finally {
      Date.now = realNow
    }
  })

  test("a top-level error becomes an error item", () => {
    const transcript = makeTranscript()
    expect(valid(transcript.push({ type: "error", message: "stream disconnected" }))).toEqual([
      { _tag: "error", id: expect.any(String), text: "stream disconnected" },
    ])
  })
})
