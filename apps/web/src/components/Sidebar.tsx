"use client";

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  ArrowUpRight,
  Bot,
  DoorOpen,
  House,
  PanelLeftClose,
  Search,
  Settings,
  ShieldAlert,
  TerminalSquare,
  X,
} from "lucide-react";
import IconButton from "./IconButton";
import PortalMark from "./PortalMark";
import PortalViewBadge, { sidebarViews, usePortalViewCounts, viewMeta, type PortalViewCounts } from "./portal/views";
import ProjectsColumn from "./ProjectsColumn";
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
import { isMacPlatform, newestSessions } from "@/lib/search";
import { sessionDisplayTitle } from "@/lib/session-title";
import type { PinMap } from "@/lib/pins";
import { holdRoomMotion } from "@/lib/room-motion";
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
  /** Open one of Portal's views (Chat is the Agent popup). */
  onPortalView: (view: PortalView) => void;
  /** The Portal view on screen, or null while a session, the start page, or the terminal is open. */
  portalView: PortalView | null;
  /** True while a session or the start page is open: the Projects section is the place to be. */
  projectsActive: boolean;
  /** The Projects column's `+`: a start page with no project chosen. */
  onNewConversation: () => void;
  /** The pinned projects were dragged into `ids` order (every pinned id, first to last). */
  onReorderPinned: (ids: readonly string[]) => Promise<void>;
  onOpenSettings: () => void;
  /** Open the Agent popup (also ⌘K / Ctrl+K); on mobile the sheet closes first. */
  onOpenAgent: () => void;
  /** Open global search (also /); on mobile the sheet closes first. */
  onOpenSearch: () => void;
  /** Open Removed projects in a page overlay. */
  onOpenRemoved: () => void;
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
  /** The logo: enter Palace mode (docs/GLASS.md, Palace mode). */
  onShowRoom: (opener: HTMLElement) => void;
  /** Palace mode has finished sliding the desktop sidebar out: hidden and inert until it comes back. */
  away: boolean;
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
  terminalActive,
  onPortalView,
  onTerminal,
  onSelect,
  onPrefetch,
}: {
  sessions: SessionSummary[];
  portalView: PortalView | null;
  terminalActive: boolean;
  onPortalView: (view: PortalView) => void;
  onTerminal: () => void;
  onSelect: (id: string) => void;
  onPrefetch: (id: string) => void;
}) {
  const counts = usePortalViewCounts();
  const recent = useMemo(() => newestSessions(sessions, 3), [sessions]);
  const { needsAttention, working, headline, detail } = foyerSummary(sessions, counts);
  // The card is the way to the Needs-your-attention page (it has no sidebar entry), whatever it says.
  const openStatus = () => onPortalView("attention");

  return (
    <div className="flex flex-col px-0.5 pb-1">
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
                  <span className="block truncate text-xs font-medium text-foreground/90">{sessionDisplayTitle(session.title)}</span>
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

const subscribeNever = () => () => {};

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere; nothing during server rendering, which cannot know. */
function AgentShortcutHint() {
  const mac = useSyncExternalStore(subscribeNever, () => isMacPlatform(navigator.platform), () => null);
  if (mac === null) return null;
  return (
    <kbd aria-hidden="true" className="ml-auto font-sans text-[10px] tracking-wide text-muted-foreground/70">
      {mac ? "⌘K" : "Ctrl K"}
    </kbd>
  );
}

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
    onNewConversation,
    onReorderPinned,
    onRenameProject,
    onRemoveProject,
    removedProjects,
  } = props;
  const { sessions, renameSession } = useSessions();
  return (
    <div className="sidebar-content">
      <div className="mb-3 flex shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          aria-label="Show the room"
          onClick={(event) => props.onShowRoom(event.currentTarget)}
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
      <div className="mb-4 flex shrink-0 items-center gap-1">
        <Button variant="ghost" onClick={props.onOpenAgent} className="h-9 min-w-0 flex-1 justify-start gap-2 rounded-xl px-2 text-xs text-foreground/80">
          <Bot className="size-4" />
          Agent
          <AgentShortcutHint />
        </Button>
        <IconButton label="Search" title="Search (/)" onClick={props.onOpenSearch} className="text-muted-foreground">
          <Search className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-sidebar-scroll>
        <HomeColumn
          sessions={sessions}
          portalView={portalView}
          terminalActive={terminalActive}
          onPortalView={onPortalView}
          onTerminal={onTerminal}
          onSelect={onSelect}
          onPrefetch={onPrefetch}
        />
        <div className="my-5 border-t border-border/70" />
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
          onRenameSession={renameSession}
          onNewSession={onNewSession}
          onNewConversation={onNewConversation}
          onReorderPinned={onReorderPinned}
          onRenameProject={onRenameProject}
          onRemoveProject={onRemoveProject}
          removedCount={removedProjects.length}
          onOpenRemoved={props.onOpenRemoved}
        />
      </div>
      <div className="mt-auto shrink-0 pb-1 pt-2">
        <Button variant="ghost" onClick={props.onOpenSettings} className="mt-1 h-8 w-full justify-start gap-2 rounded-xl px-2 text-xs text-muted-foreground">
          <Settings className="size-3.5" />
          Settings
        </Button>
      </div>
    </div>
  );
}

/** The desktop sidebar's collapse and expand (docs/GLASS.md, Sidebar collapse); `globals.css` has the same duration. */
const SLIDE_MS = 220;

/**
 * Whether the collapsible sidebar is mounted, and whether it is shown (expanded), for an `open`
 * that changes. Closing keeps it mounted while it slides out and unmounts it after, keeping its
 * React work out of the tree as before; opening mounts it collapsed and expands it two frames
 * later, so the transition runs. Under reduced motion both happen at once, and so does any change
 * before the page has settled from hydration (the stored preference replacing the server's
 * default must not slide). While it slides, the room's loop draws at full rate (`holdRoomMotion`)
 * and terminals wait for the end to refit.
 */
function useSidebarSlide(open: boolean, reducedMotion: boolean) {
  // False through hydration and the store re-renders that follow it (they run in its passive
  // effects, before the next frame); true from the first frame after.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const instant = reducedMotion || !settled;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  // Derived during render, so a change is one render, not an effect pass.
  if (open && !mounted) setMounted(true);
  if (!open && shown) setShown(false);
  if (instant && !open && mounted) setMounted(false);
  if (instant && open && !shown) setShown(true);
  useEffect(() => {
    if (!open || shown) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [open, shown]);
  // Unmount once closed for the length of the slide, whether or not it had got as far as expanding
  // (an expand undone within its two frames never changes `shown`); reopening cancels it.
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => setMounted(false), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);
  const previous = useRef(shown);
  useEffect(() => {
    if (previous.current === shown) return;
    previous.current = shown;
    const release = holdRoomMotion();
    // An instant change holds for a frame only: under reduced motion the room's still frame redraws
    // when the boost comes and goes (`room/loop.ts`), so no glass is left where the panel was.
    const timer = setTimeout(release, instant ? 16 : SLIDE_MS);
    return () => {
      clearTimeout(timer);
      release();
    };
  }, [shown, instant]);
  return { mounted, shown };
}

export default function Sidebar(props: SidebarProps) {
  const desktop = useMediaQuery("(min-width: 768px)", true);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { mounted, shown } = useSidebarSlide(props.desktopOpen, reducedMotion);
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
          liquid
          showCloseButton={false}
          className="!w-[min(320px,88vw)] gap-0 p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Palace mode's pinned logo has focus when the sheet's logo entered it.
            if (document.querySelector('[data-palace-logo="in"]')) return;
            // The opener may be gone (its pane closed, its tab unmounted): then the first toggle on the page.
            const opener = props.returnFocus?.current;
            (opener?.isConnected ? opener : document.getElementById("sidebar-toggle"))?.focus();
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
  if (!mounted) return null;
  return (
    // The slot animates its width (the panel's and the gap's) while the panel slides out or in.
    <div
      className="sidebar-slot"
      inert={props.away}
      data-shown={shown ? "" : undefined}
      data-resizing={dragWidth !== null ? "" : undefined}
      style={{ width: shown ? width + 10 : 0 }}
    >
    <aside
      aria-label="Workspace sidebar"
      aria-hidden={!shown || undefined}
      inert={!shown}
      className="sidebar-shell shell-panel frost-subtle liquid relative"
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
        // In the gap beside the panel, not over its rim.
        className="absolute inset-y-0 -right-[9px] z-20 w-2 cursor-col-resize touch-none rounded-full hover:bg-white/5 focus-visible:bg-white/10"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          // The panel's width is measured from its own left edge (the shell's padding is left of it).
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            setDragWidth(Math.max(240, Math.min(400, e.clientX - e.currentTarget.parentElement!.getBoundingClientRect().left)));
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
    </div>
  );
}
