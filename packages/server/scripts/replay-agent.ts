/**
 * Prints a recorded agent stdout fixture one line at a time, as the CLI would have printed it.
 *
 * Used by the dev-only `/replay` chat command: AgentHarness.replay spawns this through the
 * normal stdout -> items -> finish pipeline, so a fixture exercises the whole real path
 * (transcript parser, WebSocket events, chat UI) without a model or a CLI login.
 *
 * Usage: bun packages/server/scripts/replay-agent.ts <absolute fixture path>
 * KESTREL_REPLAY_DELAY_MS overrides the pause between lines (default 300 ms).
 */
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

const file = process.argv[2]
if (file === undefined || file === "") {
  console.error("replay-agent: usage: replay-agent.ts <fixture path>")
  process.exit(2)
}

const delayMs = Number(process.env.KESTREL_REPLAY_DELAY_MS ?? "300")
if (!Number.isFinite(delayMs) || delayMs < 0) {
  console.error(`replay-agent: KESTREL_REPLAY_DELAY_MS must be a non-negative number, got "${process.env.KESTREL_REPLAY_DELAY_MS}"`)
  process.exit(2)
}

const lines = (await readFile(file, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim() !== "")

for (const [index, line] of lines.entries()) {
  // The first line is immediate; every later one arrives after the same pause, so the app sees
  // items appear over time instead of all at once.
  if (index > 0) await delay(delayMs)
  process.stdout.write(`${line}\n`)
}
