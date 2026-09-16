import type { Project, SessionSummary } from "./types.ts";

export type SessionGroup<P extends Project = Project> = {
  /** The owning project, or null for sessions whose project has since been removed. */
  project: P | null;
  /** Newest first. */
  sessions: SessionSummary[];
};

/**
 * Group sessions under their projects for the sidebar. Every project gets a group in the given
 * order, even with no sessions; sessions whose `projectId` matches no project land in a trailing
 * `project: null` group that is present only when non-empty.
 */
export function groupSessionsByProject<P extends Project>(projects: P[], sessions: SessionSummary[]): SessionGroup<P>[] {
  const byProject = new Map<string, SessionSummary[]>();
  for (const project of projects) byProject.set(project.id, []);
  const orphans: SessionSummary[] = [];
  const newestFirst = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  for (const session of newestFirst) {
    const bucket = byProject.get(session.projectId);
    if (bucket) bucket.push(session);
    else orphans.push(session);
  }
  const groups: SessionGroup<P>[] = projects.map((project) => ({ project, sessions: byProject.get(project.id) ?? [] }));
  if (orphans.length > 0) groups.push({ project: null, sessions: orphans });
  return groups;
}
