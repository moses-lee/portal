"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BranchBadge } from "./ContextBar";
import { ProjectRequestError, type RemoveProjectOptions } from "./useProjects";
import { orderProjects } from "@/lib/project-tree";
import { groupSessionsByProject } from "@/lib/session-groups";
import type { ProjectSummary, SessionSummary } from "@/lib/types";

export type SidebarProps = {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  /** Active session id. */
  active: string | null;
  onSelect: (sessionId: string) => void;
  /** Start a new session in this project (the `+` on a project row). */
  onNewSession: (projectId: string) => void;
  onAddProject: () => void;
  /** May reject; the message is shown under the project. */
  onRenameProject: (id: string, name: string) => void | Promise<void>;
  /** May reject; the message is shown in the confirm box, with "Remove anyway" when `dirty` (see `ProjectRequestError`). */
  onRemoveProject: (id: string, opts?: RemoveProjectOptions) => void | Promise<void>;
  /** Mobile drawer state; on `md` and up the sidebar is always visible. */
  open: boolean;
  onClose: () => void;
};

type Editing = { id: string; mode: "rename" | "remove" };

const iconButtonClass = "shrink-0 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:bg-zinc-800 focus-visible:text-zinc-200 focus-visible:outline-none";

function SessionRow({ session, active, showCwd, onSelect }: {
  session: SessionSummary;
  active: boolean;
  /** Show the directory on the row itself (used when there is no project header above it). */
  showCwd: boolean;
  onSelect: (sessionId: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(session.id)}
      aria-current={active ? "true" : undefined}
      title={session.cwd}
      className={`block w-full rounded px-2 py-1.5 text-left text-xs ${active ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
    >
      <div className="flex items-center gap-2">
        {showCwd ? (
          <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{session.displayCwd}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-zinc-300">{session.agentName}</span>
        )}
        {session.cwdMissing && <span title="The session's folder no longer exists" className="shrink-0 text-[10px] text-amber-400">missing</span>}
        <BranchBadge git={session.git} />
      </div>
      <div className="text-[10px] text-zinc-600">
        {showCwd && <><span className="text-zinc-400">{session.agentName}</span> · </>}
        {new Date(session.createdAt).toLocaleTimeString()} · {session.id.slice(0, 8)}
      </div>
    </button>
  );
}

/** Inline rename field: Enter commits, Escape cancels, blur commits. */
function RenameField({ initial, onCommit, onCancel }: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = draft.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  return (
    <input
      aria-label="Project name"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onFocus={(e) => e.target.select()}
      className="my-1 w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-xs outline-none"
    />
  );
}

function ProjectMenu({ name, onRename, onRemove, onClose }: {
  name: string;
  onRename: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : items.length - 1;
      items[(Math.max(index, 0) + step) % items.length]?.focus();
    }
  };
  return (
    <div ref={menuRef} role="menu" aria-label={`Project ${name}`} onKeyDown={onKeyDown} className="my-1 flex gap-1 rounded border border-zinc-800 bg-zinc-900 p-1 text-xs">
      <button role="menuitem" type="button" onClick={onRename} className="flex-1 rounded px-2 py-1 text-left hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none">Rename</button>
      <button role="menuitem" type="button" onClick={onRemove} className="flex-1 rounded px-2 py-1 text-left text-red-300 hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none">Remove</button>
    </div>
  );
}

/**
 * Inline "Remove <project>?" box. Worktree projects also offer to delete the worktree folder and,
 * when git refuses because of uncommitted changes, to remove anyway. Stays open until removal succeeds.
 */
function RemoveConfirm({ project, onRemove, onCancel }: {
  project: ProjectSummary;
  onRemove: (opts: RemoveProjectOptions) => Promise<void>;
  onCancel: () => void;
}) {
  const [deleteWorktree, setDeleteWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; dirty: boolean } | null>(null);
  const isWorktree = !!project.worktree;
  const checkboxId = `sidebar-delete-worktree-${project.id}`;

  const submit = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onRemove(isWorktree ? { deleteWorktree, force } : {});
    } catch (e) {
      setError({
        message: e instanceof Error && e.message ? e.message : "Could not remove the project. Try again.",
        dirty: e instanceof ProjectRequestError && e.dirty,
      });
      setBusy(false);
    }
  };

  return (
    <div role="group" aria-label={`Remove ${project.name}?`} className="my-1 rounded border border-red-900/60 bg-red-950/30 px-2 py-2 text-xs">
      {isWorktree ? (
        <>
          <p className="mb-2 text-zinc-300">Remove <span className="font-medium">{project.name}</span> from Portal?</p>
          <label htmlFor={checkboxId} className="mb-1 flex items-center gap-1.5 text-zinc-300">
            <input
              id={checkboxId}
              type="checkbox"
              checked={deleteWorktree}
              disabled={busy}
              onChange={(e) => setDeleteWorktree(e.target.checked)}
              className="accent-indigo-500"
            />
            Also delete the worktree folder
          </label>
          {deleteWorktree && <p className="mb-2 text-zinc-500">The branch is deleted too if it is fully merged.</p>}
        </>
      ) : (
        <p className="mb-2 text-zinc-300">Remove <span className="font-medium">{project.name}</span> from Portal? Its sessions stay and the folder is untouched.</p>
      )}
      {error && (
        <p role="alert" className="mb-2 break-words rounded bg-red-950/50 px-2 py-1.5 text-red-300">{error.message}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={() => void submit(false)}
          className="rounded bg-red-700 px-2 py-1 font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          {busy ? "Removing…" : "Remove"}
        </button>
        {error?.dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit(true)}
            title="Discard the worktree's uncommitted changes"
            className="rounded border border-red-700 px-2 py-1 font-medium text-red-200 hover:bg-red-900/40 disabled:opacity-50"
          >
            Remove anyway
          </button>
        )}
        <button type="button" disabled={busy} onClick={onCancel} className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Projects as collapsible groups with their sessions; the mobile drawer is controlled by `open`. */
export default function Sidebar({
  projects, sessions, active, onSelect, onNewSession, onAddProject, onRenameProject, onRemoveProject, open, onClose,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const groups = groupSessionsByProject(orderProjects(projects), sessions);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async (id: string, action: () => void | Promise<void>, fallback: string) => {
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError({ id, message: e instanceof Error && e.message ? e.message : fallback });
    }
  };

  const closeMenu = useCallback(() => setMenuFor(null), []);

  return (
    <>
      <aside
        className={`${open ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-72 flex-col border-r border-zinc-800 bg-zinc-950 p-3 md:static md:flex`}
      >
        <div className="mb-3 text-sm font-semibold tracking-wide text-zinc-400">portal</div>
        <button
          type="button"
          onClick={onAddProject}
          className="mb-4 rounded border border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-800"
        >
          + Add project
        </button>
        <nav aria-label="Projects and sessions" className="flex-1 space-y-2 overflow-y-auto">
          {projects.length === 0 && groups.length === 0 && (
            <p className="px-2 text-xs text-zinc-500">No projects yet. Add a folder to start a session.</p>
          )}
          {groups.map(({ project, sessions: rows }) => {
            if (!project) {
              return (
                <section key="removed" aria-labelledby="sidebar-removed-projects">
                  <h3 id="sidebar-removed-projects" className="px-2 py-1 text-[11px] uppercase tracking-wide text-zinc-500">Removed projects</h3>
                  <div className="space-y-1">
                    {rows.map((s) => <SessionRow key={s.id} session={s} active={s.id === active} showCwd onSelect={onSelect} />)}
                  </div>
                </section>
              );
            }
            const isCollapsed = collapsed.has(project.id);
            const edit = editing?.id === project.id ? editing : null;
            const listId = `sidebar-project-${project.id}`;
            return (
              <section key={project.id} aria-label={project.name} className={project.depth === 1 ? "ml-3 border-l border-zinc-800 pl-2" : undefined}>
                <div className="flex items-center gap-1">
                  {edit?.mode === "rename" ? (
                    <RenameField
                      initial={project.name}
                      onCommit={(name) => {
                        setEditing(null);
                        void run(project.id, () => onRenameProject(project.id, name), "Could not rename the project. Try again.");
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggle(project.id)}
                      aria-expanded={!isCollapsed}
                      aria-controls={listId}
                      title={project.displayPath}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-zinc-900"
                    >
                      <span aria-hidden="true" className="w-3 shrink-0 text-zinc-600">{isCollapsed ? "▸" : "▾"}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">{project.name}</span>
                      {project.exists === false && (
                        <span title={`Folder not found: ${project.displayPath}`} className="shrink-0 text-[10px] text-amber-400">missing</span>
                      )}
                      {isCollapsed && rows.length > 0 && <span className="shrink-0 text-[10px] text-zinc-600">{rows.length}</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`New session in ${project.name}`}
                    title="New session here"
                    onClick={() => onNewSession(project.id)}
                    className={iconButtonClass}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={`More actions for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === project.id}
                    // Keep the menu's outside-click listener from closing it before this click toggles it.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setMenuFor((current) => (current === project.id ? null : project.id))}
                    className={iconButtonClass}
                  >
                    ⋯
                  </button>
                </div>
                {menuFor === project.id && (
                  <ProjectMenu
                    name={project.name}
                    onClose={closeMenu}
                    onRename={() => {
                      setMenuFor(null);
                      setEditing({ id: project.id, mode: "rename" });
                    }}
                    onRemove={() => {
                      setMenuFor(null);
                      setEditing({ id: project.id, mode: "remove" });
                    }}
                  />
                )}
                {edit?.mode === "remove" && (
                  <RemoveConfirm
                    project={project}
                    onRemove={async (opts) => {
                      setActionError(null);
                      await onRemoveProject(project.id, opts);
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                )}
                {actionError?.id === project.id && (
                  <p role="alert" className="my-1 rounded bg-red-950/50 px-2 py-1.5 text-xs text-red-300">{actionError.message}</p>
                )}
                <div id={listId} hidden={isCollapsed} className="mt-0.5 space-y-1 pl-2">
                  {rows.map((s) => <SessionRow key={s.id} session={s} active={s.id === active} showCwd={false} onSelect={onSelect} />)}
                  {rows.length === 0 && <p className="px-2 py-1 text-[11px] text-zinc-600">No sessions yet.</p>}
                </div>
              </section>
            );
          })}
        </nav>
      </aside>
      {open && <button aria-label="Close sessions sidebar" className="absolute inset-0 z-10 bg-black/60 md:hidden" onClick={onClose} />}
    </>
  );
}
