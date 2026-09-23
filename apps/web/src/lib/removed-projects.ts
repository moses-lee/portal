/**
 * What the Removed view shows: projects taken out of the list while conversations still pointed
 * at them, plus conversations whose project vanished without a record. Pure; the route feeds in
 * what it learned from disk and git.
 */
import type { Project, RemovedProject, RemovedProjectSummary, SessionMeta } from "./types.ts";

/** `projectId` of sessions created without a project; it cannot travel in a URL, so rows use this id. */
export const UNASSIGNED_ID = "unassigned";

/** The `projectId` a Removed row's id stands for. */
export function projectIdOfRow(id: string): string {
  return id === UNASSIGNED_ID ? "" : id;
}

export type RemovedFacts = {
  /** True when the removed project's folder is still on disk. */
  exists: boolean;
  /** For a worktree whose folder is gone: whether its branch still exists locally or on origin. Null when not checked. */
  branchExists: boolean | null;
  /** For a worktree: whether the parent project's folder is on disk. Null when not checked. */
  parentExists: boolean | null;
};

type Sessions = Pick<SessionMeta, "projectId" | "lastActiveAt" | "createdAt" | "cwd">[];

export type ProjectLookup = {
  project: (id: string) => Project | undefined;
  projectByPath: (realpath: string) => Project | undefined;
  removed: (id: string) => RemovedProject | undefined;
};

/**
 * The listed project a removed worktree belongs to: by the recorded parent id, else by the parent's
 * recorded folder (a parent removed without conversations and added again has a new id).
 */
export function parentOf(record: RemovedProject, lookup: ProjectLookup): Project | undefined {
  if (!record.worktree) return undefined;
  return lookup.project(record.worktree.parentId)
    ?? (record.parentPath ? lookup.projectByPath(record.parentPath) : undefined);
}

function sessionFields(sessions: Sessions) {
  let lastActiveAt: number | null = null;
  for (const session of sessions) {
    const at = session.lastActiveAt ?? session.createdAt;
    if (lastActiveAt === null || at > lastActiveAt) lastActiveAt = at;
  }
  return { sessionCount: sessions.length, lastActiveAt };
}

/** Why a removed project cannot be restored, or null when it can. */
export function restoreBlocker(record: RemovedProject, facts: RemovedFacts, lookup: ProjectLookup): string | null {
  if (facts.exists) return null;
  if (!record.worktree) return "The project folder is missing.";
  const parent = parentOf(record, lookup);
  if (!parent) {
    const parentRecord = lookup.removed(record.worktree.parentId);
    return parentRecord ? `Restore ${parentRecord.name} first.` : "Its original project was removed from Portal.";
  }
  if (facts.parentExists === false) return `The folder of ${parent.name} is missing.`;
  if (facts.branchExists === false) return `Branch ${record.worktree.branch} no longer exists in ${parent.name}.`;
  return null;
}

/** One Removed row for a removed project record. */
export function summarizeRemoved(
  record: RemovedProject,
  facts: RemovedFacts,
  sessions: Sessions,
  lookup: ProjectLookup & { displayPath: (dir: string) => string },
): RemovedProjectSummary {
  const parent = parentOf(record, lookup);
  const reason = restoreBlocker(record, facts, lookup);
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    displayPath: lookup.displayPath(record.path),
    ...(record.worktree ? { worktree: record.worktree } : {}),
    removedAt: record.removedAt,
    exists: facts.exists,
    parentName: parent?.name ?? null,
    ...sessionFields(sessions),
    restorable: reason === null,
    reason,
  };
}

/**
 * Rows for conversations whose `projectId` names neither a listed nor a removed project (removed
 * before Portal kept records, or created without a project). One row per id; nothing to restore.
 */
export function summarizeOrphans(
  sessions: Sessions,
  known: (projectId: string) => boolean,
  displayPath: (dir: string) => string,
): RemovedProjectSummary[] {
  const groups = new Map<string, Sessions>();
  for (const session of sessions) {
    if (known(session.projectId)) continue;
    const bucket = groups.get(session.projectId) ?? [];
    bucket.push(session);
    groups.set(session.projectId, bucket);
  }
  return [...groups.entries()].map(([projectId, rows]) => {
    const newest = [...rows].sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt))[0];
    const dir = newest.cwd;
    return {
      id: projectId || UNASSIGNED_ID,
      name: dir.split("/").filter(Boolean).at(-1) ?? dir,
      path: dir,
      displayPath: displayPath(dir),
      removedAt: null,
      exists: false,
      parentName: null,
      ...sessionFields(rows),
      restorable: false,
      reason: "Portal has no record of this project.",
    };
  });
}
