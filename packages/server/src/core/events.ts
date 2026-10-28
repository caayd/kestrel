import { Context, Layer } from "effect"
import type { ServerEvent } from "@cloudagents/protocol"

export type EventListener = (event: ServerEvent) => void

export interface EventHubShape {
  readonly publish: (event: ServerEvent) => void
  /** Subscribes to events for one task. Returns the unsubscribe function. */
  readonly subscribe: (taskId: string, listener: EventListener) => () => void
}

export class EventHub extends Context.Tag("cloudagents/EventHub")<EventHub, EventHubShape>() {}

export const taskIdOf = (event: ServerEvent): string => {
  switch (event._tag) {
    case "task.updated":
      return event.task.id
    case "message.created":
      return event.message.taskId
    case "run.updated":
      return event.run.taskId
    case "agent.output":
      return event.taskId
    case "agent.item":
      return event.taskId
    case "desktop.updated":
      return event.desktop.taskId
  }
}

export const EventHubLive = Layer.sync(EventHub, () => {
  const listeners = new Map<string, Set<EventListener>>()
  const shape: EventHubShape = {
    publish: (event) => {
      const set = listeners.get(taskIdOf(event))
      if (!set) return
      for (const listener of [...set]) listener(event)
    },
    subscribe: (taskId, listener) => {
      let set = listeners.get(taskId)
      if (!set) {
        set = new Set()
        listeners.set(taskId, set)
      }
      set.add(listener)
      const current = set
      return () => {
        current.delete(listener)
        if (current.size === 0 && listeners.get(taskId) === current) listeners.delete(taskId)
      }
    },
  }
  return shape
})
