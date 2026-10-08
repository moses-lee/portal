"use client";

import { FolderTree } from "lucide-react";
import type { Project } from "@/lib/types";

/** The project a worktree project was created from, when it is still listed. */
export function worktreeParent<P extends Project>(project: Project, projects: readonly P[]): P | null {
  const parentId = project.worktree?.parentId;
  if (parentId === undefined) return null;
  return projects.find((candidate) => candidate.id === parentId) ?? null;
}

/** The tree glyph that marks a worktree project wherever projects are listed. */
export function WorktreeIcon({ className = "size-3.5" }: { className?: string }) {
  return <FolderTree aria-hidden="true" className={`shrink-0 text-muted-foreground ${className}`} />;
}
