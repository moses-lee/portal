"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { BranchBadge } from "./ContextBar";
import GithubPanel, { GITHUB_PANEL_HEADER_PX } from "./GithubPanel";
import { ProjectRequestError, type RemoveProjectOptions } from "./useProjects";
import type { PinMap } from "@/lib/pins";
import { groupSessionsByProject } from "@/lib/session-groups";
import { WorktreeBadge } from "./WorktreeBadge";
import type { ProjectSummary, SessionSummary } from "@/lib/types";

export type SidebarProps = {
  /** In display order: pinned first, then creation order. */
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  projectPins: PinMap;
  sessionPins: PinMap;
  onTogglePinProject: (id: string) => void;
  onTogglePinSession: (id: string) => void;
  /** Active session id. */
  active: string | null;
  onSelect: (sessionId: string) => void;
  /** The pointer has rested on a session row: warm its transcript ahead of a click. */
  onPrefetch: (sessionId: string) => void;
  /** May reject; the message is shown under the session. */
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  /** Open the start page with this project selected (the `+` on a project row). */
  onNewSession: (projectId: string) => void;
  onAddProject: () => void;
  /** May reject; the message is shown under the project. */
  onRenameProject: (id: string, name: string) => void | Promise<void>;
  /** May reject; the message is shown in the confirm box, with "Remove anyway" when `dirty` (see `ProjectRequestError`). */
  onRemoveProject: (id: string, opts?: RemoveProjectOptions) => void | Promise<void>;
  /** Mobile drawer state; on `md` and up the sidebar is always visible. */
  open: boolean;
  onClose: () => void;
  /** The project the GitHub panel shows: the active session's, else the start page's; null for none. */
  githubProjectId: string | null;
  /** The active session's project was removed from Portal, so the panel shows nothing for it. */
  githubProjectRemoved: boolean;
  /** The active session, whose branch switches and turn ends refresh the GitHub panel. */
  activeSession?: SessionSummary;
};

const GITHUB_COLLAPSED_KEY = "portal.githubPanel.collapsed";
const GITHUB_SIZE_KEY = "portal.githubPanel.size";
const GITHUB_DEFAULT_SIZE = 33;
/** Tailwind's `md` breakpoint, where the sidebar stops being a drawer. */
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const noopSubscribe = () => () => {};

/** The GitHub panel's remembered layout; null on the server, where there is no storage to read. */
type GithubLayout = { collapsed: boolean; size: number };

/** Collapsed by default on small screens, where the sidebar is a drawer. */
function readGithubLayout(): GithubLayout | null {
  if (typeof window === "undefined") return null;
  const defaultCollapsed = !window.matchMedia(DESKTOP_QUERY).matches;
  try {
    const collapsed = localStorage.getItem(GITHUB_COLLAPSED_KEY);
    const size = Number(localStorage.getItem(GITHUB_SIZE_KEY));
    return {
      collapsed: collapsed === null ? defaultCollapsed : collapsed === "1",
      size: Number.isFinite(size) && size > 0 && size < 100 ? size : GITHUB_DEFAULT_SIZE,
    };
  } catch {
    return { collapsed: defaultCollapsed, size: GITHUB_DEFAULT_SIZE };
  }
}

function storeGithubLayout(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience; the layout still holds for this page load.
  }
}

type Editing = { id: string; mode: "rename" | "remove" };

const iconButtonClass = "shrink-0 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:bg-zinc-800 focus-visible:text-zinc-200 focus-visible:outline-none";

/** A thumbtack; filled when `pinned`. */
function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="11" height="11" className="inline-block" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M9.5 1.5 14.5 6.5 12.5 7.5 10.5 9.5 10 13 3 6 6.5 5.5 8.5 3.5Z" />
      <path d="M6.5 9.5 2 14" />
    </svg>
  );
}

/**
 * What a session is doing right now: a pulsing dot while the agent works, a steady brighter one
 * while it waits for someone to answer a permission prompt. Nothing when idle.
 */
function ActivityDot({ busy, awaitingPermission }: { busy: boolean; awaitingPermission: boolean }) {
  if (!busy) return null;
  const label = awaitingPermission ? "Waiting for your answer" : "Working";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${awaitingPermission ? "bg-amber-300 ring-2 ring-amber-300/30" : "animate-pulse bg-amber-400"}`}
    />
  );
}

/** A mouse resting on a row this long (ms) counts as intent to open it; a pass-over does not prefetch. */
const PREFETCH_HOVER_MS = 100;

function SessionRow({ session, active, showCwd, pinned, onSelect, onPrefetch, onDelete, onTogglePin }: {
  session: SessionSummary;
  active: boolean;
  /** Show the directory on the row itself (used when there is no project header above it). */
  showCwd: boolean;
  pinned: boolean;
  onSelect: (sessionId: string) => void;
  onPrefetch: (sessionId: string) => void;
  onDelete: (sessionId: string) => void | Promise<void>;
  onTogglePin: (sessionId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = session.title ?? session.agentName;
  const hoverRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHover = () => {
    if (hoverRef.current) clearTimeout(hoverRef.current);
    hoverRef.current = null;
  };
  useEffect(() => cancelHover, []);
  const startHover = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // Touch and pen have no hover; their first contact is the click itself.
    if (e.pointerType !== "mouse" || active) return;
    cancelHover();
    hoverRef.current = setTimeout(() => {
      hoverRef.current = null;
      onPrefetch(session.id);
    }, PREFETCH_HOVER_MS);
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(session.id);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not delete the session. Try again.");
      setBusy(false);
    }
  };
  return (
    <div className={`group rounded ${active ? "bg-zinc-800" : "hover:bg-zinc-900"}`}>
      <div className="flex items-start">
        <button
          onClick={() => onSelect(session.id)}
          onPointerEnter={startHover}
          onPointerLeave={cancelHover}
          aria-current={active ? "true" : undefined}
          title={session.cwd}
          className="block min-w-0 flex-1 px-2 py-1.5 text-left text-xs"
        >
          <div className="flex items-center gap-2">
            <ActivityDot busy={session.busy} awaitingPermission={session.awaitingPermission} />
            <span className={`min-w-0 flex-1 truncate ${showCwd ? "font-mono" : ""} text-zinc-300`}>{showCwd ? session.displayCwd : title}</span>
            {session.cwdMissing && <span title="The session's folder no longer exists" className="shrink-0 text-[10px] text-amber-400">missing</span>}
            {session.link.status === "offline" && session.link.error && (
              <span title={session.link.error} className="shrink-0 text-[10px] text-amber-400">offline</span>
            )}
            <BranchBadge git={session.git} />
          </div>
          <div className="truncate text-[10px] text-zinc-600">
            {showCwd && <><span className="text-zinc-400">{title}</span> · </>}
            {session.agentName} · {new Date(session.lastActiveAt ?? session.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
          </div>
        </button>
        <button
          type="button"
          aria-label={`${pinned ? "Unpin" : "Pin"} session ${title}`}
          aria-pressed={pinned}
          title={pinned ? "Unpin from the top" : "Pin to the top"}
          onClick={() => onTogglePin(session.id)}
          // A pinned row always shows its pin; otherwise it appears with the delete button.
          className={`${iconButtonClass} mt-1 py-1 focus-visible:opacity-100 ${pinned ? "text-zinc-400 opacity-100" : active || confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60"}`}
        >
          <PinIcon pinned={pinned} />
        </button>
        <button
          type="button"
          aria-label={`Delete session ${title}`}
          title="Delete session"
          disabled={busy}
          onClick={() => setConfirming((open) => !open)}
          // Always visible on the open row (touch screens have no hover), revealed on hover elsewhere.
          className={`${iconButtonClass} mt-1 focus-visible:opacity-100 ${active || confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60"}`}
        >
          ×
        </button>
      </div>
      {confirming && (
        <div role="group" aria-label={`Delete ${title}?`} className="mx-2 mb-2 rounded border border-red-900/60 bg-red-950/30 px-2 py-2 text-xs">
          <p className="mb-2 text-zinc-300">Delete this session and its terminals? The transcript is removed from Portal.</p>
          {error && <p role="alert" className="mb-2 break-words rounded bg-red-950/50 px-2 py-1.5 text-red-300">{error}</p>}
          <div className="flex gap-2">
            <button type="button" autoFocus disabled={busy} onClick={() => void remove()} className="rounded bg-red-700 px-2 py-1 font-medium text-white hover:bg-red-600 disabled:opacity-50">
              {busy ? "Deleting…" : "Delete"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
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

function ProjectMenu({ name, pinned, onTogglePin, onRename, onRemove, onClose }: {
  name: string;
  pinned: boolean;
  onTogglePin: () => void;
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
      <button role="menuitem" type="button" onClick={onTogglePin} className="flex-1 rounded px-2 py-1 text-left hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none">{pinned ? "Unpin" : "Pin"}</button>
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
  projects, sessions, projectPins, sessionPins, onTogglePinProject, onTogglePinSession,
  active, onSelect, onPrefetch, onDeleteSession, onNewSession, onAddProject, onRenameProject, onRemoveProject, open, onClose,
  githubProjectId, githubProjectRemoved, activeSession,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  /** True on `md` and up, where the sidebar is always visible; the drawer's `open` governs below that. */
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => true);
  /** False during server rendering and hydration, so the storage-dependent panel only renders once the markup can differ. */
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [githubLayout, setGithubLayout] = useState<GithubLayout | null>(readGithubLayout);
  const githubPanelRef = usePanelRef();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const groups = groupSessionsByProject(projects, sessions, sessionPins);

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

  const setGithubCollapsed = (value: boolean) => {
    setGithubLayout((prev) => (prev ? { ...prev, collapsed: value } : prev));
    storeGithubLayout(GITHUB_COLLAPSED_KEY, value ? "1" : "0");
  };

  const toggleGithub = () => {
    const panel = githubPanelRef.current;
    if (!githubLayout || !panel) return;
    if (githubLayout.collapsed) panel.resize(`${githubLayout.size}%`);
    else panel.collapse();
    setGithubCollapsed(!githubLayout.collapsed);
  };

  const nav = (
    <nav aria-label="Projects and sessions" className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {projects.length === 0 && groups.length === 0 && (
            <p className="px-2 text-xs text-zinc-500">No projects yet. Add a folder to start a session.</p>
          )}
          {groups.map(({ project, sessions: rows }) => {
            if (!project) {
              return (
                <section key="removed" aria-labelledby="sidebar-removed-projects">
                  <h3 id="sidebar-removed-projects" className="px-2 py-1 text-[11px] uppercase tracking-wide text-zinc-500">Removed projects</h3>
                  <div className="space-y-1">
                    {rows.map((s) => <SessionRow key={s.id} session={s} active={s.id === active} onPrefetch={onPrefetch} showCwd pinned={s.id in sessionPins} onSelect={onSelect} onDelete={onDeleteSession} onTogglePin={onTogglePinSession} />)}
                  </div>
                </section>
              );
            }
            const isCollapsed = collapsed.has(project.id);
            const isPinned = project.id in projectPins;
            const edit = editing?.id === project.id ? editing : null;
            const listId = `sidebar-project-${project.id}`;
            // A collapsed project stands in for its rows: show that something inside is working or waiting.
            const working = isCollapsed && rows.some((s) => s.busy);
            const waiting = working && rows.some((s) => s.busy && s.awaitingPermission);
            return (
              <section key={project.id} aria-label={project.name}>
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
                      <ActivityDot busy={working} awaitingPermission={waiting} />
                      <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">{project.name}</span>
                      {isPinned && <span title="Pinned" className="shrink-0 text-zinc-500"><PinIcon pinned /><span className="sr-only">Pinned</span></span>}
                      <WorktreeBadge project={project} projects={projects} />
                      {project.exists === false && (
                        <span title={`Folder not found: ${project.displayPath}`} className="shrink-0 text-[10px] text-amber-400">missing</span>
                      )}
                      {isCollapsed && rows.length > 0 && <span className="shrink-0 text-[10px] text-zinc-600">{rows.length}</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`New session in ${project.name}`}
                    title="Start a session here"
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
                    pinned={isPinned}
                    onTogglePin={() => {
                      setMenuFor(null);
                      onTogglePinProject(project.id);
                    }}
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
                  {rows.map((s) => <SessionRow key={s.id} session={s} active={s.id === active} onPrefetch={onPrefetch} showCwd={false} pinned={s.id in sessionPins} onSelect={onSelect} onDelete={onDeleteSession} onTogglePin={onTogglePinSession} />)}
                  {rows.length === 0 && <p className="px-2 py-1 text-[11px] text-zinc-600">No sessions yet.</p>}
                </div>
              </section>
            );
          })}
    </nav>
  );

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
        <Group
          orientation="vertical"
          className="min-h-0 flex-1"
          onLayoutChanged={(layout, meta) => {
            // The library can collapse or expand the panel on its own (a drag past the minimum, a group
            // resize), so the state always follows it; only user resizes are remembered across page loads.
            const panel = githubPanelRef.current;
            if (!panel || layout.github === undefined) return;
            const collapsed = panel.isCollapsed();
            const size = Math.round(layout.github * 10) / 10;
            setGithubLayout((prev) => (prev ? { collapsed, size: collapsed ? prev.size : size } : prev));
            if (!meta.isUserInteraction) return;
            storeGithubLayout(GITHUB_COLLAPSED_KEY, collapsed ? "1" : "0");
            if (!collapsed) storeGithubLayout(GITHUB_SIZE_KEY, String(size));
          }}
        >
          <Panel id="sessions" minSize="20%" className="flex min-h-0 flex-col">
            {nav}
          </Panel>
          {mounted && githubLayout && (
            <Separator aria-label="Resize GitHub panel" className="h-1.5 shrink-0 bg-zinc-800 transition-colors hover:bg-indigo-500 focus-visible:bg-indigo-500 focus-visible:outline-none" />
          )}
          {mounted && githubLayout && (
            <Panel
              id="github"
              panelRef={githubPanelRef}
              collapsible
              collapsedSize={GITHUB_PANEL_HEADER_PX}
              groupResizeBehavior="preserve-pixel-size"
              defaultSize={githubLayout.collapsed ? GITHUB_PANEL_HEADER_PX : `${githubLayout.size}%`}
              minSize="15%"
              maxSize="80%"
              className="flex min-h-0 flex-col overflow-hidden"
            >
              <GithubPanel
                projectId={githubProjectId}
                projectRemoved={githubProjectRemoved}
                session={activeSession}
                collapsed={githubLayout.collapsed}
                onToggle={toggleGithub}
                visible={desktop || open}
              />
            </Panel>
          )}
        </Group>
      </aside>
      {open && <button aria-label="Close sessions sidebar" className="absolute inset-0 z-10 bg-black/60 md:hidden" onClick={onClose} />}
    </>
  );
}
