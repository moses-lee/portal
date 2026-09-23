/**
 * The file the Next.js app kept projects in, `<PORTAL_HOME or ~/.portal>/projects.json`, read once
 * by the importer that moves it into Postgres. Shape: `{ version: 1, projects: Project[],
 * removed?: RemovedProject[] }`, projects in insertion order.
 */
import path from "node:path";
import type { Project, RemovedProject, WorktreeMeta } from "../lib/types.ts";

export function legacyProjectsFile(portalHome: string): string {
  return path.join(portalHome, "projects.json");
}

function isWorktreeMeta(value: unknown): value is WorktreeMeta {
  const w = value as Record<string, unknown> | null;
  return !!w && typeof w === "object" && typeof w.parentId === "string" && typeof w.branch === "string";
}

function isProject(value: unknown): value is Project {
  const p = value as Record<string, unknown> | null;
  return !!p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string"
    && typeof p.path === "string" && typeof p.createdAt === "number"
    && (p.worktree === undefined || isWorktreeMeta(p.worktree));
}

function isRemovedProject(value: unknown): value is RemovedProject {
  const r = value as Partial<RemovedProject>;
  return isProject(value) && typeof r.removedAt === "number" && (r.parentPath === undefined || typeof r.parentPath === "string");
}

/** Only the fields Portal knows, so unknown keys the file tolerated are not carried into the database. */
function pick<T extends Project>(value: T, extra: (value: T) => Partial<T>): T {
  return {
    id: value.id,
    name: value.name,
    path: value.path,
    createdAt: value.createdAt,
    ...(value.worktree ? { worktree: { parentId: value.worktree.parentId, branch: value.worktree.branch } } : {}),
    ...extra(value),
  } as T;
}

/**
 * The file's records, or null when it is not a version-1 projects file (the old store then started
 * empty and backed the file up on the next change). One malformed listed project rejects the whole
 * file, as the old store did; removed records are checked one by one and bad ones are counted in
 * `droppedRemoved` rather than taking the list down with them.
 */
export function parseLegacyProjectsFile(text: string): { projects: Project[]; removed: RemovedProject[]; droppedRemoved: number } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const data = parsed as { version?: unknown; projects?: unknown; removed?: unknown } | null;
  if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.projects)) return null;
  if (!data.projects.every(isProject)) return null;
  const removed: RemovedProject[] = [];
  let droppedRemoved = 0;
  for (const entry of Array.isArray(data.removed) ? data.removed : []) {
    if (isRemovedProject(entry)) {
      removed.push(pick(entry, (r) => ({ removedAt: r.removedAt, ...(r.parentPath !== undefined ? { parentPath: r.parentPath } : {}) })));
    } else {
      droppedRemoved++;
    }
  }
  return { projects: (data.projects as Project[]).map((p) => pick(p, () => ({}))), removed, droppedRemoved };
}

/**
 * Worktree projects used to be named "<parent> · <branch>"; the sidebar now marks them with a badge
 * naming the parent, so that prefix is redundant. Rename the ones that still carry the exact old
 * name to their branch (a name the user changed is left alone). Returns null when nothing changed.
 */
export function dropLegacyWorktreeNames(projects: Project[]): Project[] | null {
  const byId = new Map(projects.map((project) => [project.id, project]));
  let changed = false;
  const next = projects.map((project) => {
    if (!project.worktree) return project;
    const parent = byId.get(project.worktree.parentId);
    if (!parent || project.name !== `${parent.name} · ${project.worktree.branch}`) return project;
    changed = true;
    return { ...project, name: project.worktree.branch };
  });
  return changed ? next : null;
}
