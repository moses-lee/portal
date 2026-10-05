// The settings diff and the last-used records are shared with the server; they live in @portal/shared.
import { hasSettings } from "@portal/shared/agent-settings";
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
