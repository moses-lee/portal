"use client";

import { Activity, memo, useCallback, useState } from "react";
import {
  ChevronRight,
  FolderKanban,
  PanelLeftClose,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import IconButton from "./IconButton";
import PortalMark from "./PortalMark";
import PortalViewBadge, { usePortalViewCounts, viewMeta } from "./portal/views";
import ProjectsColumn from "./ProjectsColumn";
import RemovedProjects from "./RemovedProjects";
import { useMediaQuery } from "./useMediaQuery";
import { usePreference } from "./usePreference";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { portalViews, type PortalView } from "@/lib/session-routes";
import type { PinMap } from "@/lib/pins";
import type { RemoveProjectOptions } from "./useProjects";
import type {
  ProjectSummary,
  RemovedProjectSummary,
  SessionSummary,
} from "@/lib/types";

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

/**
 * Portal's view entries. The only reader of the live context in the sidebar: it turns the stream into
 * a handful of counts once and hands each badge plain numbers, so a stream event re-renders this list
 * rather than one subscriber per entry, or the whole sidebar.
 */
const PortalViewEntries = memo(function PortalViewEntries({
  portalView,
  onPortalView,
}: {
  portalView: PortalView | null;
  onPortalView: (view: PortalView) => void;
}) {
  const counts = usePortalViewCounts();
  return portalViews.map((entry) => {
    const Icon = viewMeta[entry].icon;
    const selected = entry === portalView;
    return (
      <Button
        key={entry}
        variant="ghost"
        onClick={() => onPortalView(entry)}
        aria-current={selected ? "page" : undefined}
        className={`mb-0.5 h-8 justify-start gap-2.5 rounded-lg px-2 text-[13px] ${selected ? "text-foreground" : "text-foreground/80"}`}
      >
        <Icon className="size-4" />
        {viewMeta[entry].label}
        <PortalViewBadge
          view={entry}
          approvals={entry === "chat" ? counts.approvals : 0}
          count={counts[entry]}
        />
      </Button>
    );
  });
});

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
        <nav aria-label="Portal" className="flex min-h-0 flex-1 flex-col">
          <PortalViewEntries
            portalView={portalView}
            onPortalView={onPortalView}
          />
          <Button
            variant="ghost"
            onClick={onTerminal}
            aria-current={terminalActive ? "page" : undefined}
            className={`mb-0.5 h-8 justify-start gap-2.5 rounded-lg px-2 text-[13px] ${terminalActive ? "text-foreground" : "text-foreground/80"}`}
          >
            <TerminalSquare className="size-4" />
            Terminal
          </Button>
          <Button
            variant="ghost"
            onClick={() => setColumn("projects")}
            aria-current={projectsActive ? "page" : undefined}
            className={`mb-0.5 h-8 justify-start gap-2.5 rounded-lg px-2 text-[13px] ${projectsActive ? "text-foreground" : "text-foreground/80"}`}
          >
            <FolderKanban className="size-4" />
            Projects
            <ChevronRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
          <div className="mt-auto flex flex-col gap-0.5 pt-3">
            <Button
              variant="ghost"
              onClick={props.onOpenSettings}
              className="h-10 justify-start gap-2 rounded-xl px-3 text-xs text-muted-foreground"
            >
              <Settings className="size-3.5" />
              Settings
            </Button>
          </div>
        </nav>
      </Activity>
      <Activity mode={column === "projects" ? "visible" : "hidden"}>
        <ProjectsColumn
          projects={projects}
          sessions={sessions}
          projectPins={projectPins}
          sessionPins={sessionPins}
          active={active}
          onSelect={onSelect}
          onPrefetch={onPrefetch}
          onDeleteSession={onDeleteSession}
          onTogglePinSession={onTogglePinSession}
          onTogglePinProject={onTogglePinProject}
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
