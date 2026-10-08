"use client";

import { useEffect, useMemo, useState } from "react";
import { Folder, FolderGit2 } from "lucide-react";
import Picker from "./Picker";
import { WorktreeIcon, worktreeParent } from "./WorktreeBadge";
import { rankProjectRows, rowHeading, type ProjectRow } from "@/lib/project-picker";
import type { PinMap } from "@/lib/pins";
import type { FolderSearch, ProjectSummary } from "@/lib/types";

export type ProjectPickerProps = {
  /** In display order: pinned projects first, then the most recently worked in. */
  projects: readonly ProjectSummary[];
  pins: PinMap;
  /** The selected project's id, or "" for none. */
  value: string;
  onChange: (projectId: string) => void;
  /** Add the folder as a project and select it; rejects with the message to show. */
  onAddFolder: (path: string) => Promise<void>;
  disabled?: boolean;
};

/** Answer of `GET /api/fs/search`, tied to the query it was for. */
type SearchResult = { query: string; result: FolderSearch | null; error: string | null };

const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";
const tagClass = "shrink-0 rounded bg-zinc-800 px-1 py-px text-[10px] text-zinc-400";

function rowKey(row: ProjectRow) {
  return row.kind === "project" ? `project:${row.project.id}` : `folder:${row.hit.path}`;
}

function ProjectGlyph({ project }: { project: ProjectSummary }) {
  if (project.worktree) return <WorktreeIcon />;
  if (project.git) return <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
  return <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
}

function TriggerLabel({ project }: { project: ProjectSummary | null }) {
  if (!project) return <span className="text-zinc-500">Choose a project</span>;
  return (
    <>
      <ProjectGlyph project={project} />
      <span className="min-w-0 truncate text-zinc-200">{project.name}</span>
      {project.worktree && <span className="min-w-0 truncate font-mono text-zinc-500">{project.worktree.branch}</span>}
      {project.exists === false && <span className={tagClass}>missing</span>}
    </>
  );
}

function RowLabel({ row, projects }: { row: ProjectRow; projects: readonly ProjectSummary[] }) {
  if (row.kind === "folder") {
    const { hit } = row;
    return (
      <>
        {hit.isGitRepo
          ? <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          : <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 shrink-0">{hit.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">{hit.displayPath}</span>
        <span className={tagClass}>add</span>
      </>
    );
  }
  const { project } = row;
  const parent = project.worktree ? worktreeParent(project, projects) : null;
  return (
    <>
      <ProjectGlyph project={project} />
      <span className="min-w-0 shrink-0 truncate">{project.name}</span>
      {project.worktree
        ? (
          <span className="min-w-0 flex-1 truncate text-zinc-500">
            {parent?.name ?? "removed project"} · <span className="font-mono">{project.worktree.branch}</span>
          </span>
        )
        : <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">{project.displayPath}</span>}
      {project.exists === false && <span className={tagClass}>missing</span>}
    </>
  );
}

/**
 * The start page's "project" control: the listed projects (pinned, then recent), searched by
 * name or path, and below the matches the folders on the host the search found, which become
 * projects when picked. Typing a path (`/…` or `~/…`) completes it; anything else searches the git
 * repositories under the home folder.
 */
export default function ProjectPicker({ projects, pins, value, onChange, onAddFolder, disabled = false }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [adding, setAdding] = useState<{ path: string; error: string | null } | null>(null);
  const trimmed = query.trim();
  const searchForQuery = search?.query === trimmed ? search : null;
  const searching = open && trimmed !== "" && searchForQuery === null;

  // Debounced folder search; the answer only counts while the same text is typed. A blank query on
  // open warms the server's repository index so the first real search answers quickly.
  useEffect(() => {
    if (!open || searchForQuery !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let result: SearchResult;
      try {
        const r = await fetch(`/api/fs/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        const j = (await r.json().catch(() => ({}))) as Partial<FolderSearch> & { error?: string };
        if (!r.ok || !j.hits) throw new Error(j.error ?? "Could not search folders.");
        result = { query: trimmed, result: j as FolderSearch, error: null };
      } catch (e) {
        if (controller.signal.aborted) return;
        const message = e instanceof Error && e.message && e.message !== "Failed to fetch" ? e.message : NETWORK_ERROR;
        result = { query: trimmed, result: null, error: message };
      }
      if (!controller.signal.aborted) setSearch(result);
    }, trimmed === "" ? 0 : 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, searchForQuery]);

  const hits = useMemo(() => searchForQuery?.result?.hits ?? [], [searchForQuery]);
  const rows = useMemo(() => rankProjectRows(projects, pins, trimmed, hits), [projects, pins, trimmed, hits]);
  const selected = projects.find((project) => project.id === value) ?? null;

  const choose = async (row: ProjectRow): Promise<boolean | void> => {
    if (row.kind === "project") {
      onChange(row.project.id);
      return;
    }
    setAdding({ path: row.hit.path, error: null });
    try {
      await onAddFolder(row.hit.path);
    } catch (e) {
      setAdding({ path: row.hit.path, error: e instanceof Error ? e.message : "Could not add the project." });
      return false;
    }
    setAdding(null);
  };

  const noProjects = projects.length === 0 && trimmed === "";
  const noMatches = !searching && !noProjects && rows.length === 0;

  return (
    <Picker
      label="project"
      trigger={<TriggerLabel project={selected} />}
      open={open}
      onOpenChange={(next) => {
        if (!next) setAdding(null);
        setOpen(next);
      }}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setAdding(null);
      }}
      searchLabel="Search projects and folders"
      placeholder="Project, folder name, or ~/path…"
      rows={rows}
      rowKey={rowKey}
      renderRow={(row) => <RowLabel row={row} projects={projects} />}
      heading={(row, previous) => rowHeading(row, previous, trimmed)}
      onChoose={choose}
      disabled={disabled}
      status={
        <>
          {noProjects && <p className="py-1 text-zinc-500">No projects yet. Type a folder name or path to add one.</p>}
          {searching && <p className="py-1 text-zinc-500">Searching folders…</p>}
          {searchForQuery?.error && <p className="py-1 text-zinc-500">{searchForQuery.error}</p>}
          {adding && !adding.error && <p className="py-1 text-zinc-500">Adding {adding.path}…</p>}
          {adding?.error && <p role="alert" className="py-1 text-red-300">{adding.error}</p>}
          {noMatches && <p className="py-1 text-zinc-500">No matches.</p>}
        </>
      }
    />
  );
}
