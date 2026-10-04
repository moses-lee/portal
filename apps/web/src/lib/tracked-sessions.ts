/**
 * The tracked-sessions panel's logic: what state each tracked session is in, and the groups the
 * panel lists them under. Pure, so the node test runner can load it.
 */
import type { TrackedSession } from "@portal/contracts/orchestrator";
import { sessionState, sessionStateLabels, type SessionState } from "./session-state.ts";
import type { SessionSummary } from "./types.ts";

/** `"true"`/`"false"`: whether the desktop panel is expanded (the list) or collapsed to its slim toggle. */
export const TRACKED_OPEN_KEY = "portal.tracked.open";
/** The expanded (session mode) width in px; read by session mode. */
export const TRACKED_WIDTH_KEY = "portal.tracked.width";

/** A tracked session's state, as its badge shows it: the shared `sessionState`, the same one the sidebar dot shows. */
export type TrackedState = SessionState;
/** The panel's groups, in list order; offline and hung share the last one, background sits with working. */
export type TrackedGroupId = "approval" | "finished" | "working" | "connecting" | "stalled";

export const trackedStateLabels: Record<TrackedState, string> = sessionStateLabels;

export const trackedGroupOrder: readonly TrackedGroupId[] = ["approval", "finished", "working", "connecting", "stalled"];

export const trackedGroupLabels: Record<TrackedGroupId, string> = {
  approval: "Needs approval",
  finished: "Finished",
  working: "Working",
  connecting: "Connecting",
  stalled: "Offline or hung",
};

/** The list fields the state reads. */
export type TrackedStateInput = Pick<SessionSummary, "busy" | "awaitingPermission" | "link" | "liveness">;

/** The state of one session: `sessionState` (see there for the precedence). */
export function trackedState(session: TrackedStateInput): TrackedState {
  return sessionState(session);
}

export function trackedGroupOf(state: TrackedState): TrackedGroupId {
  if (state === "offline" || state === "hung") return "stalled";
  // Background work gets its own group with the new group order; until then it lists with working.
  if (state === "background") return "working";
  return state;
}

export type TrackedRow<S extends TrackedStateInput & Pick<SessionSummary, "id" | "lastActiveAt"> = SessionSummary> = {
  session: S;
  tracked: TrackedSession;
  state: TrackedState;
};

export type TrackedGroup<S extends TrackedStateInput & Pick<SessionSummary, "id" | "lastActiveAt"> = SessionSummary> = {
  id: TrackedGroupId;
  label: string;
  rows: TrackedRow<S>[];
};

/**
 * The tracked sessions in their groups, in `trackedGroupOrder`, most recently prompted first within
 * a group. Empty groups are left out, and so are tracked ids missing from `sessions` (not loaded yet,
 * or deleted before the stream said so).
 */
export function groupTracked<S extends TrackedStateInput & Pick<SessionSummary, "id" | "lastActiveAt">>(
  tracked: readonly TrackedSession[],
  sessions: readonly S[],
): TrackedGroup<S>[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rows = new Map<TrackedGroupId, TrackedRow<S>[]>();
  for (const entry of tracked) {
    const session = byId.get(entry.sessionId);
    if (!session) continue;
    const state = trackedState(session);
    const group = trackedGroupOf(state);
    const list = rows.get(group) ?? [];
    list.push({ session, tracked: entry, state });
    rows.set(group, list);
  }
  return trackedGroupOrder.flatMap((id) => {
    const list = rows.get(id);
    if (!list) return [];
    list.sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt);
    return [{ id, label: trackedGroupLabels[id], rows: list }];
  });
}

/** How many tracked sessions wait on the user (needs approval or finished): the collapsed toggle's badge. */
export function trackedAttentionCount(groups: readonly { id: TrackedGroupId; rows: readonly unknown[] }[]): number {
  return groups.reduce((count, group) => count + (group.id === "approval" || group.id === "finished" ? group.rows.length : 0), 0);
}

/** The first eight characters of a session id: enough to tell sessions apart in a title fallback. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/** The list mode's fixed width, px. */
export const TRACKED_LIST_WIDTH = 320;
/** The narrowest session mode, px. */
export const TRACKED_SESSION_MIN_WIDTH = 360;
/** What the main Portal pane keeps beside an expanded panel, px. */
export const MAIN_PANE_MIN_WIDTH = 480;

/**
 * Session mode's width: the stored (or dragged) width, else half the space beside the sidebar, clamped so the main
 * pane keeps `MAIN_PANE_MIN_WIDTH`. `shared` is the room the panel and the main pane split between
 * them (the shell less the sidebar). Never below the list width, even when that squeezes the pane.
 */
export function trackedSessionWidth({ wanted, shared }: { wanted: number | null; shared: number }): number {
  const max = shared - MAIN_PANE_MIN_WIDTH;
  const width = Math.min(max, Math.max(TRACKED_SESSION_MIN_WIDTH, wanted ?? Math.round(shared / 2)));
  return Math.max(TRACKED_LIST_WIDTH, Math.round(width));
}

/** A stored `portal.tracked.width`: a positive number, else null (never set, or garbage). */
export function parseTrackedWidth(stored: string): number | null {
  const value = Number(stored);
  return stored && Number.isFinite(value) && value > 0 ? value : null;
}
