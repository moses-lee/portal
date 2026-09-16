import type { Project } from "./types.ts";

export type OrderedProject<P extends Project> = P & { depth: 0 | 1 };

/**
 * Projects in display order: every top-level project in its original position, each immediately
 * followed by its worktree projects (oldest first) at depth 1. A worktree whose parent is gone, or
 * whose parent is itself a worktree, stays where it was at depth 0.
 */
export function orderProjects<P extends Project>(projects: P[]): OrderedProject<P>[] {
  const ids = new Set(projects.map((project) => project.id));
  const isRoot = (project: P) => !project.worktree || !ids.has(project.worktree.parentId);
  const roots = new Set(projects.filter(isRoot).map((project) => project.id));
  const children = new Map<string, P[]>();
  for (const project of projects) {
    const parentId = project.worktree?.parentId;
    if (parentId === undefined || !roots.has(parentId) || project.id === parentId) continue;
    const bucket = children.get(parentId);
    if (bucket) bucket.push(project);
    else children.set(parentId, [project]);
  }
  const attached = new Set([...children.values()].flat().map((project) => project.id));

  const out: OrderedProject<P>[] = [];
  for (const project of projects) {
    if (attached.has(project.id)) continue;
    out.push({ ...project, depth: 0 });
    const worktrees = children.get(project.id);
    if (!worktrees) continue;
    for (const worktree of [...worktrees].sort((a, b) => a.createdAt - b.createdAt)) out.push({ ...worktree, depth: 1 });
  }
  return out;
}
