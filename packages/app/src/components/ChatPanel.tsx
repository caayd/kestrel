import { Fragment, useEffect, useRef, type ReactNode } from "react"
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query"
import type { Message, Run, SendMessageBody, Task, TaskStatus } from "@cloudagents/protocol"
import { api, taskAttachmentUrl } from "@/api/client"
import { keys, queries, upsert } from "@/api/queries"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatClock } from "@/util"
import { ArchivedNotice } from "./ArchivedNotice"
import { Composer } from "./Composer"
import { Markdown } from "./Markdown"
import { RunPanel } from "./RunPanel"
import { RunTranscript } from "./RunTranscript"
import { StatusIcon } from "./StatusIcon"

interface Props {
  taskId: string
  taskStatus: TaskStatus | undefined
  messages: readonly Message[]
  runs: readonly Run[]
  output: Record<string, string[]>
  /** Set while the thread is archived: the composer is replaced by an unarchive notice. */
  archivedTask: Task | undefined
}

const ENTER_CLASS = "animate-in duration-300 fade-in slide-in-from-bottom-1"

/** Under a thread block: a spinner while the turn runs, and the time. Finished turns get no icon. */
function TurnFooter({ status, time }: { status: Run["status"] | undefined; time?: string }) {
  const running = status === "running"
  if (!running && !time) return null
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
      {running && <StatusIcon status="running" />}
      {time && <span>{time}</span>}
      {running && !time && <span>Working…</span>}
    </div>
  )
}

/** `children`: what hangs off a message (attachments, answer buttons), shown under its text. */
function ThreadItem({
  message,
  turn,
  hideText = false,
  children,
}: {
  message: Message
  /** The run transcript already renders this text; only what hangs off the message stays. */
  hideText?: boolean
  turn: Run["status"] | undefined
  children?: ReactNode
}) {
  switch (message.role) {
    case "user":
      return (
        <div className={cn("flex flex-col items-end", ENTER_CLASS)}>
          <div className="max-w-[85%] rounded-2xl bg-white/[0.08] px-4 py-2.5 break-words whitespace-pre-wrap shadow-soft">
            {message.text}
          </div>
          {/* No agent reply yet: the turn's status sits under the prompt, on the agent's side. */}
          {turn && (
            <div className="self-start">
              <TurnFooter status={turn} />
            </div>
          )}
        </div>
      )
    case "agent": {
      // A duplicated message still holds attachments and answer buttons, and its footer is the running
      // indicator; only the clock goes, since the transcript's turn footer covers the finished turn.
      if (hideText && (children === undefined || children === null)) return <TurnFooter status={turn} />
      return (
        <div className={ENTER_CLASS}>
          {!hideText && <Markdown text={message.text} />}
          {children}
          <TurnFooter status={turn} time={hideText ? undefined : formatClock(message.createdAt)} />
        </div>
      )
    }
    case "system":
      return (
        <div className={cn("self-center text-xs text-muted-foreground italic", ENTER_CLASS)}>
          {message.text}
          {children}
          <TurnFooter status={turn} />
        </div>
      )
  }
}

export function ChatPanel({ taskId, taskStatus, messages, runs, output, archivedTask }: Props) {
  const queryClient = useQueryClient()
  const threadRef = useRef<HTMLDivElement>(null)

  const sortedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const runById = new Map(sortedRuns.map((r) => [r.id, r]))
  // Items of every run in the thread: their count says whether an agent message duplicates its transcript,
  // and each arrival bumps `dataUpdatedAt`, which is what re-runs the scroll effect.
  const runItemQueries = useQueries({ queries: sortedRuns.map((run) => queries.runItems(run.id)) })
  const itemCountByRun = new Map(
    sortedRuns.map((run, index) => [run.id, runItemQueries[index]?.data?.length ?? 0]),
  )
  const itemsRevision = runItemQueries.map((query) => query.dataUpdatedAt).join(",")
  // The last message of each run carries that turn's status.
  const lastMessageOfRun = new Map<string, string>()
  for (const m of sortedMessages) if (m.runId) lastMessageOfRun.set(m.runId, m.id)
  // The latest question with options gets answer buttons, but only while the agent is blocked waiting for one.
  const lastAsk = [...sortedMessages].reverse().find((m) => (m.options ?? []).length > 0)
  const pendingAsk = taskStatus === "needs_input" ? lastAsk : undefined

  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sortedMessages.length, itemsRevision])

  const send = useMutation({
    mutationFn: (body: SendMessageBody) => api.sendMessage(taskId, body),
    onSuccess: (res) => {
      queryClient.setQueryData(keys.messages(taskId), (list: Message[] | undefined) => upsert(list, res.message))
      queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, res.run))
    },
  })
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelRun(runId),
    onSuccess: (run) => queryClient.setQueryData(keys.runs(taskId), (list: Run[] | undefined) => upsert(list, run)),
  })
  const latestRun = sortedRuns.at(-1)
  const activeRun = latestRun?.status === "running" ? latestRun : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4" ref={threadRef}>
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5">
          {sortedMessages.length === 0 && (
            <div className="m-auto text-muted-foreground">No messages yet. Describe what to do.</div>
          )}
          {sortedMessages.map((m) => {
            // A user message starts its run: that run's transcript follows the prompt.
            const startedRunId = m.role === "user" ? m.runId : null
            const duplicate = m.role === "agent" && m.runId !== null && (itemCountByRun.get(m.runId) ?? 0) > 0
            const attachments = m.attachments ?? []
            // Attachments and answer buttons stay on the message itself, so it survives hiding its text.
            const extras = attachments.length > 0 || m.id === pendingAsk?.id
            const turn = m.runId && lastMessageOfRun.get(m.runId) === m.id ? runById.get(m.runId)?.status : undefined
            // While the prompt is the run's last message, its status goes under the transcript once one exists.
            const turnBelowTranscript = startedRunId !== null && (itemCountByRun.get(startedRunId) ?? 0) > 0
            return (
              <Fragment key={m.id}>
                <ThreadItem message={m} turn={turnBelowTranscript ? undefined : turn} hideText={duplicate}>
                  {extras ? (
                    <>
                      {attachments.map((a) => (
                        <img
                          key={a.id}
                          src={taskAttachmentUrl(taskId, a.id)}
                          alt="Attachment"
                          className="mt-2 max-h-80 rounded-xl shadow-soft"
                        />
                      ))}
                      {m.id === pendingAsk?.id && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(m.options ?? []).map((option, i) => (
                            <Button
                              key={i}
                              variant="soft"
                              size="sm"
                              disabled={send.isPending}
                              onClick={() => send.mutate({ text: option })}
                            >
                              {option}
                            </Button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : null}
                </ThreadItem>
                {startedRunId !== null && <RunTranscript runId={startedRunId} />}
                {turnBelowTranscript && <TurnFooter status={turn} />}
              </Fragment>
            )
          })}
        </div>
      </div>
      <RunPanel runs={sortedRuns} output={output} />
      <div className="flex justify-center px-5 pt-2 pb-5">
        {archivedTask ? (
          <ArchivedNotice task={archivedTask} />
        ) : (
          <Composer
            onSend={send.mutateAsync}
            pending={send.isPending}
            error={send.error ?? cancel.error}
            onStop={activeRun && (() => cancel.mutate(activeRun.id))}
            stopping={cancel.isPending}
          />
        )}
      </div>
    </div>
  )
}
