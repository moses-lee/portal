"use client";

import type { Project } from "@/lib/types";

/** The project a worktree project was created from, when it is still listed. */
export function worktreeParent<P extends Project>(project: Project, projects: P[]): P | null {
  const parentId = project.worktree?.parentId;
  if (parentId === undefined) return null;
  return projects.find((candidate) => candidate.id === parentId) ?? null;
}

/** Text form of the badge for places that cannot render markup, such as `<option>` labels. */
export function worktreeLabel(project: Project, projects: Project[]): string | null {
  if (!project.worktree) return null;
  return `⑂ ${worktreeParent(project, projects)?.name ?? "removed project"}`;
}

/** Marks a worktree project with the project it was created from and the branch it checks out. */
export function WorktreeBadge({ project, projects }: { project: Project; projects: Project[] }) {
  if (!project.worktree) return null;
  const parent = worktreeParent(project, projects);
  return (
    <span
      title={parent
        ? `Worktree of ${parent.name} on branch ${project.worktree.branch}`
        : `Worktree on branch ${project.worktree.branch}; its original project was removed from Portal`}
      className="inline-flex max-w-32 shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
    >
      <span aria-hidden="true" className="text-zinc-500">⑂</span>
      <span className="truncate">{parent?.name ?? "removed project"}</span>
    </span>
  );
}
