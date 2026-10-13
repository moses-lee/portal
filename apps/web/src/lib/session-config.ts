// The settings diff and the last-used records are shared with the server; they live in @portal/shared.
import { hasSettings, overlaySettings } from "@portal/shared/agent-settings";
import { byRecentActivity } from "./session-groups.ts";
import type { SessionListState, SessionMeta } from "./types.ts";

export * from "@portal/shared/agent-settings";

/**
 * The settings of the most recently active session with `agentId`, or null when no such session
 * exposes any. Only a bootstrap: the start page shows this for an agent the user has no last-used
 * settings for yet (from before Portal remembered them), so its controls are there from the start.
 */
export function latestStateForAgent(
  sessions: (Pick<SessionMeta, "agentId" | "lastActiveAt" | "createdAt"> & { state: SessionListState })[],
  agentId: string,
): SessionListState | null {
  return [...sessions]
    .sort(byRecentActivity)
    .find((session) => session.agentId === agentId && hasSettings(session.state))?.state ?? null;
}

/**
 * Saved picks on the choices a connected agent offers now. Saved option lists can predate an
 * adapter upgrade; an offline session cannot refresh them. Before any connection, keep the
 * saved settings (or the latest session's settings when there have been no picks yet).
 */
export function startSettingsForAgent(
  sessions: (Pick<SessionMeta, "agentId" | "lastActiveAt" | "createdAt" | "link"> & { state: SessionListState })[],
  agentId: string,
  stored?: SessionListState | null,
): SessionListState | null {
  const live = latestStateForAgent(sessions.filter((session) => session.link.status === "live"), agentId);
  if (live) return stored ? overlaySettings(stored, live) : live;
  return stored ?? latestStateForAgent(sessions, agentId);
}
