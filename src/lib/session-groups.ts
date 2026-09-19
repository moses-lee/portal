import { EMPTY_PINS, partitionPinned, type PinMap } from "./pins.ts";
import type { Project, SessionMeta, SessionSummary } from "./types.ts";

export type SessionGroup<P extends Project = Project> = {
  /** The owning project, or null for sessions whose project has since been removed. */
  project: P | null;
  /** Pinned sessions first; each part most recently active first. */
  sessions: SessionSummary[];
};

/** Most recently active first, newest created breaking ties. */
export function byRecentActivity(a: Pick<SessionMeta, "lastActiveAt" | "createdAt">, b: Pick<SessionMeta, "lastActiveAt" | "createdAt">): number {
  return (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt) || b.createdAt - a.createdAt;
}

/**
 * Group sessions under their projects for the sidebar. Every project gets a group in the given
 * order, even with no sessions; sessions whose `projectId` matches no project land in a trailing
 * `project: null` group that is present only when non-empty. Within a group, sessions pinned in
 * `sessionPins` come first; both parts are most recently active first.
 */
export function groupSessionsByProject<P extends Project>(projects: P[], sessions: SessionSummary[], sessionPins: PinMap = EMPTY_PINS): SessionGroup<P>[] {
  const byProject = new Map<string, SessionSummary[]>();
  for (const project of projects) byProject.set(project.id, []);
  const orphans: SessionSummary[] = [];
  for (const session of [...sessions].sort(byRecentActivity)) {
    const bucket = byProject.get(session.projectId);
    if (bucket) bucket.push(session);
    else orphans.push(session);
  }
  const groups: SessionGroup<P>[] = projects.map((project) => ({ project, sessions: partitionPinned(byProject.get(project.id) ?? [], sessionPins) }));
  if (orphans.length > 0) groups.push({ project: null, sessions: partitionPinned(orphans, sessionPins) });
  return groups;
}

/**
 * Projects most recently worked in first. A project ranks by its newest session's `lastActiveAt`,
 * falling back to its own `createdAt` so a freshly added project starts near the top and sinks as
 * you work elsewhere. `lastActiveAt` only moves when the user sends a prompt, so the order never
 * shuffles on its own while an agent runs. Ties break on `createdAt`, newest first.
 */
export function orderProjectsByActivity<P extends Project>(projects: readonly P[], sessions: readonly SessionSummary[]): P[] {
  const newest = new Map<string, number>();
  for (const session of sessions) {
    const at = session.lastActiveAt ?? session.createdAt;
    if (at > (newest.get(session.projectId) ?? -Infinity)) newest.set(session.projectId, at);
  }
  const rank = (project: P) => Math.max(newest.get(project.id) ?? -Infinity, project.createdAt);
  return [...projects].sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt);
}

/** How many unpinned sessions a project lists before the sidebar hides the rest behind "Show more". */
export const SESSION_LIMIT = 5;

/**
 * Trim a project's session list for the sidebar. Pinned sessions always show — pinning is a request
 * to keep something in view — and so does `openId`, so the row telling you where you are is never
 * hidden; the unpinned remainder is cut to `limit`. Order is preserved, and every session survives
 * when there is nothing to hide.
 */
export function capSessions(sessions: readonly SessionSummary[], sessionPins: PinMap, openId: string | null, limit = SESSION_LIMIT): SessionSummary[] {
  let unpinned = 0;
  return sessions.filter((session) => {
    if (session.id in sessionPins) return true;
    return ++unpinned <= limit || session.id === openId;
  });
}
