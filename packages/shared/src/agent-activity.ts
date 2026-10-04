import type { SessionState, SessionStateInput } from "./session-state.ts";
import { sessionState } from "./session-state.ts";

/**
 * The coarse activity the session header, the conversation's aurora, and the orchestrator's world
 * show. Persisted in world snapshots, so its values stay stable; it is `sessionState` folded down.
 */
export type AgentActivity =
  "idle" | "working" | "waiting" | "connecting" | "error";

const activityOf: Record<SessionState, AgentActivity> = {
  approval: "waiting",
  hung: "error",
  offline: "error",
  connecting: "connecting",
  working: "working",
  background: "working",
  finished: "idle",
};

/** `sessionState` mapped onto `AgentActivity`. */
export function activityOfState(state: SessionState): AgentActivity {
  return activityOf[state];
}

/**
 * `sessionState` mapped onto `AgentActivity`. `failed` (the last thing in the transcript is an
 * error) turns a working or finished session into an error, as it always has for the header.
 */
export function agentActivity({ failed = false, ...input }: SessionStateInput & { failed?: boolean }): AgentActivity {
  const state = sessionState(input);
  if (failed && (state === "working" || state === "background" || state === "finished")) return "error";
  return activityOf[state];
}

export const activityLabels: Record<AgentActivity, string> = {
  idle: "Ready",
  working: "Working",
  waiting: "Needs your approval",
  connecting: "Connecting",
  error: "Needs attention",
};
