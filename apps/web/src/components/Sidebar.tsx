"use client";

import { Activity, memo, useCallback, useMemo, useState, type RefObject } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  DoorOpen,
  FolderKanban,
  House,
  PanelLeftClose,
  Settings,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import IconButton from "./IconButton";
import PortalMark from "./PortalMark";
import RoomModeControl from "./RoomModeControl";
import PortalViewBadge, { sidebarViews, usePortalViewCounts, viewMeta, type PortalViewCounts } from "./portal/views";
import ProjectsColumn from "./ProjectsColumn";
import RemovedProjects from "./RemovedProjects";
import { useMediaQuery } from "./useMediaQuery";
import { useSessions } from "./SessionsProvider";
import { usePreference } from "./usePreference";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import type { PortalView } from "@/lib/session-routes";
import type { PinMap } from "@/lib/pins";
import type { RemoveProjectOptions } from "./useProjects";
import type { ProjectSummary, RemovedProjectSummary, SessionSummary } from "@/lib/types";

export type SidebarProps = {
  projects: ProjectSummary[];
  projectPins: PinMap;
  sessionPins: PinMap;
  onTogglePinProject: (id: string) => void;
  onTogglePinSession: (id: string) => void;
  active: string | null;
  /** Sessions open somewhere in the workspace (decision 27): their rows show a small tab glyph. */
  openSessionIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  /** "Open in new tab": a tab of its own at the end of the strip, moved there when it is open elsewhere. */
  onOpenInNewTab: (id: string) => void;
  /** "Open beside current": split the focused pane to the right. */
  onOpenBeside: (id: string) => void;
  /** False off the workspace (a Portal view, the terminal): nothing to open beside. */
  canOpenBeside: boolean;
  /** Where focus returns when the mobile sheet closes: the toggle that opened it. */
  returnFocus?: RefObject<HTMLElement | null>;
  onPrefetch: (id: string) => void;
  onDeleteSession: (id: string) => void | Promise<void>;
  onNewSession: (projectId: string) => void;
  /** Open the standalone terminal page. */
  onTerminal: () => void;
  /** True while the standalone terminal page is open. */
  terminalActive: boolean;
  /** Open one of Portal's views (Chat is the home, `/`). */
  onPortalView: (view: PortalView) => void;
  /** The Portal view on screen, or null while a session, the start page, or the terminal is open. */
  portalView: PortalView | null;
  /** True while a session or the start page is open: the Projects section is the place to be. */
  projectsActive: boolean;
  onAddProject: () => void;
  onOpenSettings: () => void;
  onRenameProject: (id: string, name: string) => void | Promise<void>;
  onRemoveProject: (
    id: string,
    opts?: RemoveProjectOptions,
  ) => void | Promise<void>;
  /** Rows of the Removed view; the count shows on its button. */
  removedProjects: RemovedProjectSummary[];
  removedError: string | null;
  onRefreshRemoved: () => void | Promise<void>;
  /** Bring a removed project back; the sidebar returns to the workspace view once it resolves. */
  onRestoreProject: (id: string) => Promise<void>;
  /** Delete a removed project's conversations and forget it. */
  onDiscardRemoved: (id: string) => Promise<void>;
  open: boolean;
  onClose: () => void;
  desktopOpen: boolean;
  onCollapse: () => void;
};

const PortalViewEntries = memo(function PortalViewEntries({
  portalView,
  onPortalView,
  counts,
}: {
  portalView: PortalView | null;
  onPortalView: (view: PortalView) => void;
  counts: PortalViewCounts;
}) {
  return sidebarViews.map((entry) => {
    const Icon = viewMeta[entry].icon;
    const selected = entry === portalView;
    return (
      <Button
        key={entry}
        variant="ghost"
        onClick={() => onPortalView(entry)}
        aria-current={selected ? "page" : undefined}
        className={`mb-0.5 h-8 justify-start gap-2.5 rounded-lg px-2 text-[13px] ${selected ? "bg-muted/70 text-foreground" : "text-foreground/75"}`}
      >
        <Icon className="size-4" />
        {viewMeta[entry].label}
        <PortalViewBadge count={counts[entry]} />
      </Button>
    );
  });
});

/** Find the newest few sessions without sorting the full list on every stream update. */
function recentRooms(sessions: SessionSummary[]): SessionSummary[] {
  const recent: SessionSummary[] = [];
  for (const session of sessions) {
    const index = recent.findIndex((row) => session.lastActiveAt > row.lastActiveAt);
    if (index === -1) {
      if (recent.length < 3) recent.push(session);
    } else {
      recent.splice(index, 0, session);
      if (recent.length > 3) recent.pop();
    }
  }
  return recent;
}

function foyerSummary(sessions: SessionSummary[], counts: PortalViewCounts) {
  let waitingCount = 0;
  let working = 0;
  for (const session of sessions) {
    if (session.awaitingPermission) waitingCount++;
    if (session.busy) working++;
  }
  const portalWaiting = counts.approvals > 0 || counts.attention > 0;
  const needsAttention = portalWaiting || waitingCount > 0;
  const headline = counts.approvals > 0
    ? `${counts.approvals} Portal ${counts.approvals === 1 ? "approval" : "approvals"} waiting`
    : counts.attention > 0
      ? `${counts.attention} ${counts.attention === 1 ? "item needs" : "items need"} you`
      : waitingCount > 0
        ? `${waitingCount} ${waitingCount === 1 ? "room needs" : "rooms need"} you`
        : working > 0
          ? `${working} ${working === 1 ? "room is" : "rooms are"} in motion`
          : "Everything is in place";
  const detail = portalWaiting && waitingCount > 0
    ? `${waitingCount} ${waitingCount === 1 ? "session is" : "sessions are"} also waiting for you`
    : needsAttention
      ? "Step in and keep things moving"
      : working > 0
        ? "Your agents are at work"
        : "Your rooms are ready when you are";
  return { needsAttention, working, headline, detail };
}

/** A useful front door: the next request, recent conversations, then the full navigation. */
const HomeColumn = memo(function HomeColumn({
  sessions,
  portalView,
  projectsActive,
  terminalActive,
  onPortalView,
  onTerminal,
  onSelect,
  onPrefetch,
  onShowProjects,
}: {
  sessions: SessionSummary[];
  portalView: PortalView | null;
  projectsActive: boolean;
  terminalActive: boolean;
  onPortalView: (view: PortalView) => void;
  onTerminal: () => void;
  onSelect: (id: string) => void;
  onPrefetch: (id: string) => void;
  onShowProjects: () => void;
}) {
  const counts = usePortalViewCounts();
  const recent = useMemo(() => recentRooms(sessions), [sessions]);
  const { needsAttention, working, headline, detail } = foyerSummary(sessions, counts);
  // The card is the way to the Needs-your-attention page (it has no sidebar entry), whatever it says.
  const openStatus = () => onPortalView("attention");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-0.5 pb-1">
      <div className="px-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">Your foyer</div>
      <button
        type="button"
        onClick={openStatus}
        aria-current={portalView === "attention" ? "page" : undefined}
        className="group mt-2 w-full rounded-2xl border border-border/80 bg-card/70 p-3.5 text-left shadow-sm transition-colors hover:border-amber-200/30 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-start justify-between gap-2">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-xl border ${needsAttention ? "border-amber-300/20 bg-amber-300/10 text-amber-200" : "border-border bg-muted/60 text-foreground/70"}`}>
            {needsAttention ? <ShieldAlert className="size-4" aria-hidden="true" /> : <House className="size-4" aria-hidden="true" />}
          </span>
          <ArrowUpRight className="size-3.5 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
        </span>
        <span className="mt-3 block text-[13px] font-semibold leading-5 text-foreground">{headline}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{detail}</span>
        <span className="mt-3 flex items-center gap-1.5 border-t border-border/70 pt-2.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          <span className={`size-1.5 rounded-full ${needsAttention ? "bg-amber-300" : working > 0 ? "bg-emerald-400" : "bg-muted-foreground/50"}`} aria-hidden="true" />
          {needsAttention ? "Needs your attention" : working > 0 ? "Work in progress" : "All caught up"}
        </span>
      </button>

      <section aria-labelledby="recent-rooms-title" className="mt-6">
        <div className="flex items-center justify-between gap-2 px-1.5">
          <h2 id="recent-rooms-title" className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">Recent rooms</h2>
          <button type="button" onClick={onShowProjects} className="rounded-md px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">View all</button>
        </div>
        {recent.length > 0 ? (
          <div className="mt-2 space-y-1">
            {recent.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
                onMouseEnter={() => onPrefetch(session.id)}
                onFocus={() => onPrefetch(session.id)}
                className="group flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 text-left transition-colors hover:border-border/70 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/45 text-foreground/60 group-hover:text-foreground" aria-hidden="true"><DoorOpen className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground/90">{session.title || "New conversation"}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{session.project?.name ?? session.agentName}</span>
                </span>
                <span className={`size-1.5 shrink-0 rounded-full ${session.awaitingPermission ? "bg-amber-300" : session.busy ? "bg-emerald-400" : "bg-muted-foreground/35"}`} aria-hidden="true" />
                <span className="sr-only">{session.awaitingPermission ? "Needs your approval" : session.busy ? "Working" : "Ready"}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="px-2 py-3 text-[11px] leading-4 text-muted-foreground">Your recent sessions will appear here.</p>
        )}
      </section>

      <nav aria-label="Portal" className="mt-6 flex flex-col">
        <span className="px-1.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">Portal</span>
        <PortalViewEntries portalView={portalView} onPortalView={onPortalView} counts={counts} />
        <span className="mt-4 px-1.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">Workspace</span>
        <Button
          variant="ghost"
          onClick={onShowProjects}
          aria-current={projectsActive ? "page" : undefined}
          className={`mb-0.5 h-8 justify-start gap-2.5 rounded-lg px-2 text-[13px] ${projectsActive ? "bg-muted/70 text-foreground" : "text-foreground/75"}`}
        >
          <FolderKanban className="size-4" />
          Projects
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          onClick={onTerminal}
          aria-current={terminalActive ? "page" : undefined}
          className={`mb-0.5 h-8 justify-start gap-2.5 rounded-lg px-2 text-[13px] ${terminalActive ? "bg-muted/70 text-foreground" : "text-foreground/75"}`}
        >
          <TerminalSquare className="size-4" />
          Terminal
        </Button>
      </nav>
    </div>
  );
});

function SidebarContent(props: SidebarProps) {
  const {
    projects,
    projectPins,
    sessionPins,
    active,
    openSessionIds,
    onSelect,
    onOpenInNewTab,
    onOpenBeside,
    canOpenBeside,
    onPrefetch,
    onDeleteSession,
    onTogglePinSession,
    onTogglePinProject,
    onNewSession,
    onTerminal,
    terminalActive,
    onPortalView,
    portalView,
    projectsActive,
    onAddProject,
    onRenameProject,
    onRemoveProject,
    removedProjects,
    removedError,
    onRefreshRemoved,
    onRestoreProject,
    onDiscardRemoved,
  } = props;
  const { sessions, tracked, track, untrack, renameSession } = useSessions();
  const trackedIds = useMemo(
    () => new Set(tracked.map((entry) => entry.sessionId)),
    [tracked],
  );
  // Stable (track and untrack are), so the memoised rows keep their props.
  const toggleTrack = useCallback(
    (id: string, on: boolean) => (on ? track(id) : untrack(id)),
    [track, untrack],
  );
  /**
   * The column on show: Portal's views (home), the Projects section (projects and their
   * conversations), or the list of removed projects. It follows the URL: a session or the start page
   * opens Projects so the active row is in view, a Portal view opens home. Removed is reached from
   * Projects only.
   */
  const wanted: "home" | "projects" = projectsActive ? "projects" : "home";
  const [column, setColumn] = useState<"home" | "projects" | "removed">(wanted);
  const [followed, setFollowed] = useState(wanted);
  if (wanted !== followed) {
    setFollowed(wanted);
    setColumn(wanted);
  }
  // Stable, so the memoised Projects column is not re-rendered by a new arrow on every sidebar render.
  const showHome = useCallback(() => setColumn("home"), []);
  const showProjects = useCallback(() => setColumn("projects"), []);
  const showRemoved = useCallback(() => setColumn("removed"), []);
  return (
    <div className="sidebar-content">
      <div className="mb-4 flex items-center gap-2 px-2">
        <button
          type="button"
          aria-label="Portal home"
          onClick={() => onPortalView("chat")}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left"
        >
          <PortalMark />
          <span className="flex-1 text-[15px] font-semibold tracking-[-.03em]">
            Portal
          </span>
        </button>
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
      {/*
        Home and Projects stay mounted and swap under Activity, so going back and forth keeps the
        project tree's scroll position, search, and expanded lists. Hidden means display:none on the
        column's root, so the one on show takes the full height.
      */}
      <Activity mode={column === "home" ? "visible" : "hidden"}>
        <HomeColumn
          sessions={sessions}
          portalView={portalView}
          projectsActive={projectsActive}
          terminalActive={terminalActive}
          onPortalView={onPortalView}
          onTerminal={onTerminal}
          onSelect={onSelect}
          onPrefetch={onPrefetch}
          onShowProjects={showProjects}
        />
      </Activity>
      <Activity mode={column === "projects" ? "visible" : "hidden"}>
        <ProjectsColumn
          projects={projects}
          sessions={sessions}
          projectPins={projectPins}
          sessionPins={sessionPins}
          active={active}
          openSessionIds={openSessionIds}
          onSelect={onSelect}
          onOpenInNewTab={onOpenInNewTab}
          onOpenBeside={canOpenBeside ? onOpenBeside : null}
          onPrefetch={onPrefetch}
          onDeleteSession={onDeleteSession}
          onTogglePinSession={onTogglePinSession}
          onTogglePinProject={onTogglePinProject}
          trackedIds={trackedIds}
          onToggleTrack={toggleTrack}
          onRenameSession={renameSession}
          onNewSession={onNewSession}
          onAddProject={onAddProject}
          onRenameProject={onRenameProject}
          onRemoveProject={onRemoveProject}
          removedCount={removedProjects.length}
          onBack={showHome}
          onOpenRemoved={showRemoved}
        />
      </Activity>
      {column === "removed" && (
        <RemovedProjects
          rows={removedProjects}
          error={removedError}
          onBack={() => setColumn("projects")}
          onRefresh={onRefreshRemoved}
          onRestore={async (id) => {
            await onRestoreProject(id);
            setColumn("projects");
          }}
          onDiscard={onDiscardRemoved}
        />
      )}
      <div className="mt-auto shrink-0 pb-1 pt-2">
        <RoomModeControl />
        <Button variant="ghost" onClick={props.onOpenSettings} className="mt-1 h-8 w-full justify-start gap-2 rounded-xl px-2 text-xs text-muted-foreground">
          <Settings className="size-3.5" />
          Settings
        </Button>
      </div>
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
            (props.returnFocus?.current ?? document.getElementById("sidebar-toggle"))?.focus();
          }}
        >
          <SheetTitle className="sr-only">Your workspace</SheetTitle>
          <SheetDescription className="sr-only">
            Portal, its views, and your projects and conversations.
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
