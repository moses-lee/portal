/**
 * Background tasks over JetBrains' AIR `asyncTasks` extension to ACP. Both bundled adapters
 * (claude-agent-acp and codex-acp) implement it: a client that advertises the capability at
 * `initialize` hears about work the agent keeps running past its turn (a backgrounded shell) as
 * three extra `session/update` kinds, and can stop such a task with `_session/async_task/stop`.
 *
 * The SDK cannot deliver those kinds as they are. Every `session/update` is parsed against the
 * closed union `zSessionNotification` before any handler runs: by the client app's own session
 * update router (installed in `acp.client()`'s constructor, ahead of every registered handler) and
 * by the handler's spec. An unknown kind fails that parse, is logged by the SDK as "Error handling
 * notification", and dropped, whether the handler is registered with the SDK's spec or with a
 * custom params parser (`onNotification(method, parser, handler)`), since the router parses first.
 * So `routeAirUpdates` renames AIR notifications on the incoming message stream, before the SDK
 * sees them, to a Portal-local method (`AIR_UPDATE_METHOD`, never on the wire) that the runtime
 * registers with `parseAirNotification`. Every standard kind still goes through the SDK's schema
 * untouched, and both kinds keep their arrival order since they share the SDK's one dispatch queue.
 */
import * as acp from "@agentclientprotocol/sdk";
import type { BackgroundTaskEnd } from "./types.ts";

/** What Portal advertises under `clientCapabilities._meta`: AIR version 1 with background tasks. */
export const AIR_CLIENT_META = { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } };

/** The agent request that stops one background task: `{ sessionId, asyncTaskId }` → `{ stopped }`. */
export const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";

/** The Portal-local method AIR updates are renamed to on the way in; never sent or received on the wire. */
export const AIR_UPDATE_METHOD = "_portal/air_session_update";

const AIR_KINDS = new Set(["async_task_spawned", "async_task_progress", "async_task_state_update"]);

/** The states after which a task runs no more (the adapters' `isTerminal`). */
const TERMINAL_STATES = new Set<string>(["completed", "failed", "stopped"]);

export type AirTaskUpdate =
  | { kind: "spawned"; taskId: string; title: string; taskType: string | null; canStop: boolean; toolCallId: string | null }
  | { kind: "progress"; taskId: string }
  /** `end` is set for a terminal state; null for `running` and `paused`. */
  | { kind: "state"; taskId: string; end: BackgroundTaskEnd | null; summary: string | null };

export type AirNotification = { sessionId: string; update: AirTaskUpdate };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function isAirNotification(message: acp.AnyMessage): boolean {
  if (!("method" in message) || "id" in message || message.method !== acp.CLIENT_METHODS.session_update) return false;
  return AIR_KINDS.has(record(record(message.params)?.update)?.sessionUpdate as string);
}

/** The agent's message stream with AIR `session/update` notifications renamed to `AIR_UPDATE_METHOD`; everything else passes as is. */
export function routeAirUpdates(stream: acp.Stream): acp.Stream {
  const readable = stream.readable.pipeThrough(new TransformStream<acp.AnyMessage, acp.AnyMessage>({
    transform(message, controller) {
      controller.enqueue(isAirNotification(message) ? { ...message, method: AIR_UPDATE_METHOD } as acp.AnyMessage : message);
    },
  }));
  return { writable: stream.writable, readable };
}

/** Validate a renamed AIR notification; throws the SDK's invalid-params error (which it logs and drops) when malformed. */
export function parseAirNotification(params: unknown): AirNotification {
  const outer = record(params);
  const update = record(outer?.update);
  const sessionId = text(outer?.sessionId);
  const taskId = text(update?.asyncTaskId);
  if (!update || !sessionId || !taskId) throw acp.RequestError.invalidParams(undefined, "AIR task updates need a sessionId and an asyncTaskId");
  switch (update.sessionUpdate) {
    case "async_task_spawned":
      return {
        sessionId,
        update: {
          kind: "spawned", taskId,
          title: text(update.name) ?? text(update.description) ?? "Background task",
          taskType: text(update.taskType),
          canStop: update.canStop === true,
          toolCallId: text(update.toolCallId),
        },
      };
    case "async_task_progress":
      return { sessionId, update: { kind: "progress", taskId } };
    case "async_task_state_update": {
      const state = text(update.state);
      if (!state) throw acp.RequestError.invalidParams(undefined, "AIR task state updates need a state");
      return {
        sessionId,
        update: { kind: "state", taskId, end: TERMINAL_STATES.has(state) ? state as BackgroundTaskEnd : null, summary: text(update.summary) },
      };
    }
    default:
      throw acp.RequestError.invalidParams(undefined, `Unknown AIR task update: ${String(update.sessionUpdate)}`);
  }
}
