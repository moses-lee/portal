"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  ChevronRight,
  Folder,
  FolderGit2,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import AgentLogo from "./AgentLogo";
import IconButton from "./IconButton";
import { RenameField, RemoveConfirm } from "./ProjectActions";
import { useMediaQuery } from "./useMediaQuery";
import { usePreference } from "./usePreference";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { groupSessionsByProject } from "@/lib/session-groups";
import { agentActivity, activityLabels } from "@/lib/agent-activity";
import { relativeAge } from "@/lib/relative-age";
import type { PinMap } from "@/lib/pins";
import type { RemoveProjectOptions } from "./useProjects";
import type { ProjectSummary, SessionSummary } from "@/lib/types";

export type SidebarProps = {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  projectPins: PinMap;
  sessionPins: PinMap;
  onTogglePinProject: (id: string) => void;
  onTogglePinSession: (id: string) => void;
  active: string | null;
  onSelect: (id: string) => void;
  onPrefetch: (id: string) => void;
  onDeleteSession: (id: string) => void | Promise<void>;
  onNewSession: (projectId: string) => void;
  onHome: () => void;
  onAddProject: () => void;
  onRenameProject: (id: string, name: string) => void | Promise<void>;
  onRemoveProject: (
    id: string,
    opts?: RemoveProjectOptions,
  ) => void | Promise<void>;
  open: boolean;
  onClose: () => void;
  desktopOpen: boolean;
  onCollapse: () => void;
};

function SessionRow({
  session,
  active,
  pinned,
  now,
  onSelect,
  onPrefetch,
  onDelete,
  onTogglePin,
}: {
  session: SessionSummary;
  active: boolean;
  pinned: boolean;
  now: number;
  onSelect: (id: string) => void;
  onPrefetch: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
  onTogglePin: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hover.current) clearTimeout(hover.current);
    },
    [],
  );
  const title = session.title || "New conversation";
  const activity = agentActivity(session);
  const age = relativeAge(now - session.lastActiveAt);
  const cancelHover = () => {
    if (hover.current) clearTimeout(hover.current);
  };
  const startHover = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    cancelHover();
    hover.current = setTimeout(() => onPrefetch(session.id), 100);
  };
  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(session.id);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not delete the session.",
      );
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="sidebar-row group" data-active={active}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={title}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(session.id)}
            onPointerEnter={startHover}
            onPointerLeave={cancelHover}
            className="flex min-w-0 gap-2.5 rounded-xl px-2.5 py-3 text-left"
          >
            <AgentLogo agentId={session.agentId} className="mt-0.5 !size-4" />
            <span className="min-w-0 flex-1">
              <span className="sidebar-title text-foreground/90">{title}</span>
              <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {pinned && <Pin className="size-2.5" aria-label="Pinned" />}
                {session.busy || session.link.status === "connecting" ? (
                  <span
                    data-activity={activity}
                    className="inline-flex items-center gap-1.5"
                  >
                    <span className="status-dot" />
                    {activityLabels[activity]}
                  </span>
                ) : session.cwdMissing ? (
                  "Folder missing"
                ) : session.link.status === "offline" && session.link.error ? (
                  "Offline"
                ) : (
                  <span>{age === "now" ? "Just now" : `${age} ago`}</span>
                )}
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-72 break-words">
          {title}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${title}`}
            className="mt-2 text-muted-foreground opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onSelect={() => onTogglePin(session.id)}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? "Unpin session" : "Pin session"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirming(true)}
          >
            <Trash2 />
            Delete session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirming && (
        <div
          role="group"
          aria-label={`Delete ${title}?`}
          className="col-span-2 m-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs"
        >
          <p className="leading-relaxed">
            Delete this conversation and its terminals? This removes its
            transcript from Portal.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-destructive">
              {error}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarContent(props: SidebarProps) {
  const {
    projects,
    sessions,
    projectPins,
    sessionPins,
    active,
    onSelect,
    onPrefetch,
    onDeleteSession,
    onTogglePinSession,
    onTogglePinProject,
    onNewSession,
    onHome,
    onAddProject,
    onRenameProject,
    onRemoveProject,
  } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{
    id: string;
    mode: "rename" | "remove";
  } | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, []);
  const groups = useMemo(() => {
    const q = query.toLowerCase().trim();
    return groupSessionsByProject(projects, sessions, sessionPins)
      .map((group) => ({
        ...group,
        sessions:
          !q || group.project?.name.toLowerCase().includes(q)
            ? group.sessions
            : group.sessions.filter((s) =>
                `${s.title} ${s.agentName} ${s.git?.branch ?? ""} ${s.displayCwd}`
                  .toLowerCase()
                  .includes(q),
              ),
      }))
      .filter(
        (group) =>
          !q ||
          group.sessions.length > 0 ||
          group.project?.name.toLowerCase().includes(q),
      );
  }, [projects, sessions, sessionPins, query]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="sidebar-content">
      <div className="mb-6 flex items-center gap-2 px-2">
        <span
          className="flex size-7 items-center justify-center rounded-full border border-white/20 bg-white/5"
          aria-hidden="true"
        >
          <span className="size-3.5 rounded-full border-2 border-indigo-200/75 shadow-[0_0_12px_#a5b4fc30]" />
        </span>
        <span className="flex-1 text-[15px] font-semibold tracking-[-.03em]">
          Portal
        </span>
        <IconButton
          label="Collapse sidebar"
          onClick={props.onCollapse}
          className="hidden text-muted-foreground md:inline-flex"
        >
          <PanelLeftClose className="size-4" />
        </IconButton>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close sidebar"
          onClick={props.onClose}
          className="text-muted-foreground md:hidden"
        >
          <X />
        </Button>
      </div>
      <Button
        variant="secondary"
        onClick={onHome}
        className="mb-4 h-10 justify-start gap-2.5 rounded-xl bg-white/5 px-3 text-[13px]"
      >
        <SquarePen className="size-4" />
        New conversation
      </Button>
      <div className="relative mb-6">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-3.5 text-muted-foreground" />
        <Input
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          className="h-9 rounded-xl border-transparent bg-transparent pl-9 text-xs shadow-none dark:bg-transparent focus-visible:bg-white/5"
        />
      </div>
      <div className="mb-2 flex items-center px-2">
        <span className="flex-1 text-[10px] font-semibold tracking-[.12em] text-muted-foreground/80 uppercase">
          Workspace
        </span>
        <IconButton
          label="Add project"
          size="icon-xs"
          onClick={onAddProject}
          className="text-muted-foreground"
        >
          <Plus />
        </IconButton>
      </div>
      <nav
        aria-label="Projects and sessions"
        className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4"
      >
        {groups.length === 0 && (
          <p className="px-3 py-6 text-xs leading-relaxed text-muted-foreground">
            {query
              ? "No matching conversations."
              : "Add a project to create your first conversation."}
          </p>
        )}
        {groups.map(({ project, sessions: rows }) => {
          const isCollapsed = !query && !!project && collapsed.has(project.id);
          const isPinned = !!project && project.id in projectPins;
          const edit = editing?.id === project?.id ? editing : null;
          const parent = project?.worktree
            ? projects.find((p) => p.id === project.worktree?.parentId)
            : null;
          const waiting = rows.some((s) => s.awaitingPermission);
          const working = rows.some((s) => s.busy);
          return (
            <section
              key={project?.id ?? "removed"}
              aria-label={project?.name ?? "Removed projects"}
            >
              <div className="mb-1 flex items-center gap-0.5 px-1">
                {edit?.mode === "rename" && project ? (
                  <RenameField
                    inputRef={renameInput}
                    initial={project.name}
                    onCancel={() => setEditing(null)}
                    onCommit={(name) => {
                      setEditing(null);
                      setError(null);
                      Promise.resolve(onRenameProject(project.id, name)).catch(
                        (e) =>
                          setError({
                            id: project.id,
                            message:
                              e instanceof Error
                                ? e.message
                                : "Could not rename project.",
                          }),
                      );
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={!project}
                    onClick={() => project && toggle(project.id)}
                    aria-expanded={!isCollapsed}
                    aria-controls={`project-${project?.id ?? "removed"}`}
                    title={
                      project
                        ? `${project.name} · ${project.displayPath}`
                        : undefined
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1.5 text-left"
                  >
                    {project?.git ? (
                      <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-zinc-300">
                        {project?.name ?? "Removed projects"}
                      </span>
                      {parent && (
                        <span className="block truncate text-[10px] text-muted-foreground">
                          Worktree of {parent.name}
                        </span>
                      )}
                    </span>
                    {isPinned && (
                      <Pin className="size-2.5 shrink-0 text-muted-foreground" />
                    )}
                    {isCollapsed && working && (
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${waiting ? "bg-amber-300" : "bg-indigo-300"}`}
                        aria-label={waiting ? "Needs approval" : "Working"}
                      />
                    )}
                    <ChevronRight
                      className={`size-3 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                    />
                  </button>
                )}
                {project && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Actions for project ${project.name}`}
                        className="text-muted-foreground"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      side="right"
                      onCloseAutoFocus={(event) => {
                        if (renameInput.current) {
                          event.preventDefault();
                          renameInput.current.focus();
                        }
                      }}
                    >
                      <DropdownMenuItem
                        onSelect={() => onNewSession(project.id)}
                      >
                        <SquarePen />
                        New conversation
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onTogglePinProject(project.id)}
                      >
                        {isPinned ? <PinOff /> : <Pin />}
                        {isPinned ? "Unpin project" : "Pin project"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          setEditing({ id: project.id, mode: "rename" })
                        }
                      >
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() =>
                          setEditing({ id: project.id, mode: "remove" })
                        }
                      >
                        <Trash2 />
                        Remove project
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {project?.exists === false && (
                <p className="px-3 pb-2 text-[11px] text-amber-300">
                  Project folder is missing
                </p>
              )}
              {edit?.mode === "remove" && project && (
                <RemoveConfirm
                  project={project}
                  onCancel={() => setEditing(null)}
                  onRemove={async (options) => {
                    await onRemoveProject(project.id, options);
                    setEditing(null);
                  }}
                />
              )}
              {error?.id === project?.id && (
                <p role="alert" className="px-3 text-xs text-destructive">
                  {error?.message}
                </p>
              )}
              <div
                id={`project-${project?.id ?? "removed"}`}
                hidden={isCollapsed}
                className="space-y-1"
              >
                {rows.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === active}
                    pinned={session.id in sessionPins}
                    now={now || session.lastActiveAt}
                    onSelect={onSelect}
                    onPrefetch={onPrefetch}
                    onDelete={onDeleteSession}
                    onTogglePin={onTogglePinSession}
                  />
                ))}
                {rows.length === 0 && (
                  <p className="px-3 py-3 text-[11px] text-muted-foreground">
                    No conversations yet
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </nav>
      <Button
        variant="ghost"
        onClick={onAddProject}
        className="mt-3 h-10 justify-start gap-2 border-t border-white/5 rounded-none px-3 text-xs text-muted-foreground"
      >
        <Plus className="size-3.5" />
        Add project
      </Button>
    </div>
  );
}

export default function Sidebar(props: SidebarProps) {
  const desktop = useMediaQuery("(min-width: 768px)", true);
  const [storedWidth, storeWidth] = usePreference(
    "portal.sidebar.width",
    "280",
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width =
    dragWidth ?? Math.max(240, Math.min(400, Number(storedWidth) || 280));
  if (!desktop)
    return (
      <Sheet
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <SheetContent
          side="left"
          showCloseButton={false}
          className="!w-[min(320px,88vw)] gap-0 p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("sidebar-toggle")?.focus();
          }}
        >
          <SheetTitle className="sr-only">Your workspace</SheetTitle>
          <SheetDescription className="sr-only">
            Browse projects and conversations.
          </SheetDescription>
          <SidebarContent {...props} />
        </SheetContent>
      </Sheet>
    );
  if (!props.desktopOpen) return null;
  return (
    <aside
      aria-label="Workspace sidebar"
      className="sidebar-shell glass-subtle relative"
      style={{ width }}
    >
      <SidebarContent {...props} />
      <div
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={240}
        aria-valuemax={400}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none hover:bg-white/5 focus-visible:bg-white/10"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            setDragWidth(Math.max(240, Math.min(400, e.clientX)));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          storeWidth(String(width));
          setDragWidth(null);
        }}
        onPointerCancel={() => setDragWidth(null)}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            storeWidth(
              String(
                e.key === "Home"
                  ? 240
                  : e.key === "End"
                    ? 400
                    : Math.max(
                        240,
                        Math.min(
                          400,
                          width + (e.key === "ArrowLeft" ? -16 : 16),
                        ),
                      ),
              ),
            );
          }
        }}
      />
    </aside>
  );
}
