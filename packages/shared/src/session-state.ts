/**
 * One session's state, the single derivation every view shares: the sidebar's status dot, the
 * tracked panel's badge, and (mapped onto `AgentActivity`) the session header and the orchestrator's
 * world. Pure, so the node test runner can load it.
 */
import type { LivenessState, SessionLink } from "@portal/contracts/types";

export type SessionState = "approval" | "hung" | "offline" | "connecting" | "working" | "background" | "finished";

/** Every state, in order of precedence. */
export const sessionStates: readonly SessionState[] = ["approval", "hung", "offline", "connecting", "working", "background", "finished"];

export const sessionStateLabels: Record<SessionState, string> = {
  approval: "Needs approval",
  hung: "Hung",
  offline: "Offline",
  connecting: "Connecting",
  working: "Working",
  background: "Background",
  finished: "Finished",
};

/**
 * The fields the state reads. `liveness` accepts `"background"` ahead of the server producing it
 * (a turn ended with background tasks still running); absent liveness reads as no signal.
 */
export type SessionStateInput = {
  busy: boolean;
  awaitingPermission: boolean;
  link?: SessionLink | null;
  liveness?: LivenessState | "background" | null;
};

/**
 * The state of one session, first match wins:
 * - approval: a permission prompt is open (`awaitingPermission`, or liveness `blocked`);
 * - hung: liveness `hung` (a turn with no CPU or output for too long);
 * - offline: liveness `dead` (the agent went away mid-work), or the link is offline with an error;
 * - connecting: the link is connecting (attaching the agent);
 * - working: a turn is running (`busy`, or liveness `busy`);
 * - background: no turn is open but background tasks still run (liveness `background`);
 * - finished: everything else: the agent is done and waiting on us. That includes an offline link
 *   without an error, a session whose agent is simply not attached (after a restart); opening it
 *   attaches the agent again. It is not an attention state.
 */
export function sessionState({ busy, awaitingPermission, link, liveness }: SessionStateInput): SessionState {
  if (awaitingPermission || liveness === "blocked") return "approval";
  if (liveness === "hung") return "hung";
  if (liveness === "dead" || (link?.status === "offline" && link.error)) return "offline";
  if (link?.status === "connecting") return "connecting";
  if (busy || liveness === "busy") return "working";
  if (liveness === "background") return "background";
  return "finished";
}
