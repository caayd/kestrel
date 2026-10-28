import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { AgentItem } from "@cloudagents/protocol"
import { queries } from "@/api/queries"
import { cn } from "@/lib/utils"
import { Alert } from "@/components/ui/alert"
import { Markdown } from "./Markdown"

interface Props {
  runId: string
}

interface Tree {
  roots: readonly AgentItem[]
  children: ReadonlyMap<string, readonly AgentItem[]>
}

/** Items in arrival order; a tool's subagent items (`parentToolId`) hang under it instead of the top level. */
function buildTree(items: readonly AgentItem[]): Tree {
  const toolIds = new Set(items.filter((item) => item._tag === "tool").map((item) => item.id))
  const roots: AgentItem[] = []
  const children = new Map<string, AgentItem[]>()
  for (const item of items) {
    const parentToolId = item._tag === "turn" || item._tag === "error" ? null : item.parentToolId
    if (parentToolId !== null && toolIds.has(parentToolId)) {
      const list = children.get(parentToolId) ?? []
      list.push(item)
      children.set(parentToolId, list)
    } else {
      roots.push(item)
    }
  }
  return { roots, children }
}

function turnSummary(item: Extract<AgentItem, { _tag: "turn" }>): string {
  const parts: string[] = []
  if (item.durationMs !== null) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`)
  if (item.inputTokens !== null || item.outputTokens !== null) {
    parts.push(`${item.inputTokens ?? "?"} in · ${item.outputTokens ?? "?"} out`)
  }
  if (item.costUsd !== null) parts.push(`$${item.costUsd.toFixed(4)}`)
  if (item.isError) parts.push("failed")
  return parts.join(" · ")
}

const PRE_CLASS = "m-0 max-h-72 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap shadow-well"

function ItemView({ item, tree }: { item: AgentItem; tree: Tree }) {
  switch (item._tag) {
    case "text":
      return <Markdown text={item.text} />
    case "thinking":
      return (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer text-xs select-none">Thinking</summary>
          <div className="mt-1 text-sm break-words whitespace-pre-wrap italic">{item.text}</div>
        </details>
      )
    case "tool":
      return (
        <details className="rounded-xl border border-border bg-card/40 px-3.5 py-2 shadow-soft">
          <summary
            className={cn(
              "cursor-pointer font-mono text-xs select-none",
              item.status === "error" && "text-destructive",
            )}
          >
            {item.name} · {item.status}
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <pre className={PRE_CLASS}>{JSON.stringify(item.input, null, 2)}</pre>
            {item.output !== null && <pre className={PRE_CLASS}>{item.output}</pre>}
            {(tree.children.get(item.id) ?? []).map((child) => (
              <ItemView key={child.id} item={child} tree={tree} />
            ))}
          </div>
        </details>
      )
    case "turn": {
      const summary = turnSummary(item)
      if (summary === "") return null
      return (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px] text-muted-foreground",
            item.isError && "text-destructive",
          )}
        >
          {summary}
        </div>
      )
    }
    case "error":
      return <Alert>{item.text}</Alert>
  }
}

/** One run's normalized items, in order: the agent's reply as markdown, with thinking and tools collapsed. */
export function RunTranscript({ runId }: Props) {
  const { data } = useQuery(queries.runItems(runId))
  const tree = useMemo(() => buildTree(data ?? []), [data])

  if (data === undefined || data.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {tree.roots.map((item) => (
        <ItemView key={item.id} item={item} tree={tree} />
      ))}
    </div>
  )
}
