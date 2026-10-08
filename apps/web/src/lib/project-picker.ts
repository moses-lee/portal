/**
 * The rows of the start page's project picker: the listed projects (pinned ones first, then the
 * rest in the given order), filtered by the query, and below them the folders a search found that
 * are not projects yet. Pure, so the ranking is testable without the component.
 */
import type { PinMap } from "./pins";
import type { FolderHit, ProjectSummary } from "./types";

export type ProjectRow<P extends ProjectSummary = ProjectSummary> =
  | { kind: "project"; project: P; section: "pinned" | "recent" }
  | { kind: "folder"; hit: FolderHit };

/** Whether `query` (lowercased, trimmed) matches the project's name, path, or worktree branch. */
export function matchesProject(project: ProjectSummary, query: string): boolean {
  if (!query) return true;
  const haystack = `${project.name}\n${project.displayPath}\n${project.path}\n${project.worktree?.branch ?? ""}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * Projects first (in the given order, which already puts pinned ones first), those matching
 * `query` only, then the folder hits that are not already a project's folder.
 */
export function rankProjectRows<P extends ProjectSummary>(
  projects: readonly P[],
  pins: PinMap,
  query: string,
  hits: readonly FolderHit[],
): ProjectRow<P>[] {
  const q = query.trim().toLowerCase();
  const rows: ProjectRow<P>[] = [];
  for (const project of projects) {
    if (!matchesProject(project, q)) continue;
    rows.push({ kind: "project", project, section: project.id in pins ? "pinned" : "recent" });
  }
  const taken = new Set(projects.map((project) => project.path));
  for (const hit of hits) {
    if (taken.has(hit.path)) continue;
    taken.add(hit.path);
    rows.push({ kind: "folder", hit });
  }
  return rows;
}

/** The heading a row opens, given the one before it: sections for a blank query, otherwise projects versus folders. */
export function rowHeading(row: ProjectRow, previous: ProjectRow | undefined, query: string): string | null {
  const section = (r: ProjectRow) => (r.kind === "folder" ? "folder" : query.trim() ? "project" : r.section);
  if (previous && section(previous) === section(row)) return null;
  switch (section(row)) {
    case "pinned": return "Pinned";
    case "recent": return "Recent";
    case "project": return "Projects";
    case "folder": return "Folders";
  }
}
