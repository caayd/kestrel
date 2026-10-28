# Agent replay fixtures

Each file is the exact JSONL stdout of one agent run: one line is one line the CLI prints. The dev-only
`/replay <harness>/<name>` chat command pipes the file through `scripts/replay-agent.ts`, so the box sees it
as a normal harness subprocess and the real pipeline (harness → events → WebSocket → app) runs unchanged.
No UI mocks.

Names are `^[a-z0-9-]+$`; harness directories are `claude/` and `codex/`.

## Fixtures

| File | Source | What it exercises |
|---|---|---|
| `claude/markdown` | hand-made | init, thinking block, one long markdown answer (headings, lists, table, TS/Python/Bash/JSON code, inline SVG, raw `<details>`/`<table>` HTML, mermaid, links, long lines), result usage/cost/duration |
| `claude/tools` | hand-made | thinking, Bash/Read/Grep/Edit/Write calls, parallel Read+Grep (two lines, same `message.id`, one user line with both results), `is_error: true` tool result, MCP `mcp__cloudagents__desktop_screenshot` returning an image block, Task subagent with `parent_tool_use_id` on its assistant/user lines, multiple text messages between tools, result |
| `claude/long` | hand-made | 66 lines / 20 tool cycles: scrolling, incremental item updates and streaming performance |
| `claude/error` | hand-made | failing tool result, then a `result` with `subtype: "error_during_execution"`, `is_error: true` and no `result` text |
| `codex/recorded-shell` | real recording | `agent_message`, a `command_execution` that exits 1, final markdown with a table, a TS block and inline SVG, `turn.completed` usage |
| `codex/recorded-edit` | real recording | `file_change` add + update, a failed `command_execution`, final markdown with a mermaid block and `<details>` |
| `codex/kitchen-sink` | hand-made | reasoning (started/updated/completed), multiple `agent_message`s, `todo_list` started/updated/completed, `command_execution` success and exit 2, `file_change`, `mcp_tool_call` to `cloudagents` (`workspace_exec`, `desktop_screenshot` success with an image block, `desktop_screenshot` failure with `error.message`), `web_search`, and a final markdown answer with the full rendering matrix |
| `codex/failed-turn` | hand-made | error item, top-level `error`, `turn.failed` with `error.message` |

The two `codex/recorded-*` files come from real `codex exec --json` runs (codex-cli 0.163.0), sanitized only
for paths, the PowerShell shell wrapper (and the output that wrapper produced) and the thread id:
structure, item ids and event order are exactly as recorded.

The four `claude/` files are **hand-made** — no Claude CLI was available — built from the documented
`stream-json --verbose` shapes (each assistant line carries one content block; content blocks of the same API
message share `message.id`; `session_id`/`uuid` are consistent within a file). Replace or augment them with
real recordings when a machine with Claude Code is available.

## Recording new fixtures

Record on Linux, where the box runs, and use the same CLI flags as the harness
(`packages/server/src/config.ts`):

```sh
# Claude: one content block per assistant line; do not pass --include-partial-messages
# (stream_event lines are ignored and just add noise).
claude -p 'your prompt' \
  --mcp-config "$CLOUDAGENTS_MCP_CONFIG" \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  > packages/server/fixtures/agent/claude/<name>.jsonl

# Codex
codex exec --json --skip-git-repo-check 'your prompt' \
  > packages/server/fixtures/agent/codex/<name>.jsonl
```

Give the prompt a task that covers the display you want to build. Before committing a recording, sanitize it:
replace absolute paths with `/home/agent/work/...`, strip personal data and API keys, and use a fresh UUID for
`thread_id`/`session_id`. Keep every line valid single-line JSON with the real field names, nesting and types.

## Using a fixture

1. Run the dev stack and sign in at `/auth/dev-login` (fixture replay is dev-only; the relay marks dev-login
   sessions so the box accepts it).
2. Open a task chat and send `/replay claude/markdown` (or `codex/kitchen-sink`, etc.).
3. The run appears like any other run; `RunPanel` keeps showing the raw log while the chat shows the items.
