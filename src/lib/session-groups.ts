import { EMPTY_PINS, partitionPinned, type PinMap } from "./pins.ts";
import type { Project, SessionSummary } from "./types.ts";

export type SessionGroup<P extends Project = Project> = {
  /** The owning project, or null for sessions whose project has since been removed. */
  project: P | null;
  /** Pinned sessions first; each part most recently active first. */
  sessions: SessionSummary[];
};

/** Most recently active first, newest created breaking ties. */
export function byRecentActivity(a: SessionSummary, b: SessionSummary): number {
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
