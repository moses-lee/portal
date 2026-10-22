"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useMediaQuery } from "./useMediaQuery";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { RoomHostProvider } from "@/room/host";
import RoomBackground from "@/room/RoomBackground";
import type { AgentActivity } from "@/lib/agent-activity";
import { portalActivity } from "@/lib/orchestrator/format";
import { usePreference } from "./usePreference";
import { clearSubmittedDraft, startKey, writeDraft } from "@/lib/drafts";
import {
  clearAttachments,
  moveAttachments,
  readAttachments,
  uploadAttachments,
} from "@/lib/attachments";
import {
  forgetPromptHistory,
  recordPrompt,
  sessionHistoryKey,
} from "@/lib/prompt-history";
import Sidebar from "./Sidebar";
import type { InitialSend, StartPaneProps } from "./SessionPane";
import TerminalPage from "./TerminalPage";
import RemovedProjects from "./RemovedProjects";
import PalaceView from "@/room/PalaceView";
import PortalMark from "./PortalMark";
import { APP_NAVIGATION_EVENT } from "@/lib/surface-navigation";
import { palaceEscapeToggles, palaceKeyState, type PalaceKeyState } from "@/lib/palace-mode";
import { holdRoomMotion } from "@/lib/room-motion";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";
import PortalPage from "./PortalPage";
import WorkspaceView from "./workspace/WorkspaceView";
import { useWorkspaceActions } from "./workspace/useWorkspaceActions";
import { PortalLiveProvider, usePortalLive } from "./portal/PortalLive";
import { AgentInboxProvider, useAgentInboxState } from "./portal/AgentInbox";
import { SessionsProvider, useSessions } from "./SessionsProvider";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";
import { useSessionPins } from "./usePins";
import { useProjects } from "./useProjects";
import { useRemovedProjects } from "./useRemovedProjects";
import {
  useOpenSettingsRequests,
  useSettings,
  type SettingsSection,
} from "./useSettings";
import type { WorktreeChoice } from "./WorktreePicker";
import { ORIGINAL } from "@/lib/branch-matching";
import { buildGitActionPrompt } from "@/lib/git-action-prompt";
import { pinnedFirst, projectPinOrderOf, projectPinsOf } from "@/lib/pins";
import { byRecentActivity, orderProjectsByActivity } from "@/lib/session-groups";
import { defaultSettings, type GitActionKind } from "@/lib/settings";
import {
  applyConfigChange,
  hasSettings,
  startSettingsForAgent,
  MAX_CONFIG_STEPS,
  nextConfigChange,
  overlaySettings,
  settingsOf,
} from "@/lib/session-config";
import { useLastUsed } from "./useLastUsed";
import { navigateTo, pushPath } from "@/lib/navigation";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  isMacPlatform,
  paletteShortcut,
  searchShortcutAllowed,
  parseRecents,
  pruneRecents,
  RECENTS_KEY,
  recentsAfterOpen,
  type PaletteTab,
  type RecentItem,
} from "@/lib/search";
import {
  isPalaceLinkPath,
  isTerminalPath,
  portalLocation,
  sessionIdFromPath,
  type PortalLocation,
  type WorkspaceRoute,
  sessionPath,
  workspaceRoute,
  type PortalView,
} from "@/lib/session-routes";
import { allPanes } from "@portal/shared/workspace";
import { canSplitPane, locationPath } from "@/lib/workspace";
import type {
  GithubSummary,
  ProjectSummary,
  SessionDetail,
  SessionListState,
  SessionState,
  SetConfigRequest,
} from "@/lib/types";

const GithubInspector = dynamic(() => import("./GithubInspector"));
// Shown rarely, so their code (the settings dialog alone is the sidebar kit and a 1,500-line form) loads when first needed.
const SettingsDialog = dynamic(() => import("./SettingsDialog"));
const ApprovalsDialog = dynamic(() => import("./portal/ApprovalsDialog"));
const SearchDialog = dynamic(() => import("./SearchDialog"));
const AgentPage = dynamic(() => import("./AgentPage"));
type PageSurface = PortalLocation | { view: "terminal" } | { view: "removed" };

const SELECTED_PROJECT_KEY = "portal.selectedProjectId";

function readStoredProjectId() {
  try {
    return localStorage.getItem(SELECTED_PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProjectId(id: string) {
  try {
    localStorage.setItem(SELECTED_PROJECT_KEY, id);
  } catch {
    // Storage is a convenience; selection still works for this page load.
  }
}

/**
 * The app: the live orchestrator state, the session list, and the workspace (tabs and panes), which
 * every page reads, around the shell. The layout mounts this once, so the providers live for the
 * whole visit.
 */
export default function Chat() {
  return (
    <PortalLiveProvider>
      <SessionsProvider>
        <WorkspaceProvider>
          <ChatShell />
        </WorkspaceProvider>
      </SessionsProvider>
    </PortalLiveProvider>
  );
}

/**
 * How long Palace mode's animations take (docs/GLASS.md, Palace mode → Animation), as `globals.css`
 * times them: on desktop the panels slide for 320 ms; on a phone the sheet closes first and the
 * pinned logo fades in after the centre; under reduced motion, 120 ms crossfades.
 */
const PALACE_MS = { desktop: 320, phone: 560, reduced: 120 } as const;

/**
 * The room behind Portal and the workspace (docs/PALACE.md), mounted once by the shell so moving
 * between a Portal page and a session keeps the canvas: Portal's activity on its pages and in Palace
 * mode, the focused pane's agent in the workspace, and Palace mode's flag (no veil, and a clicked
 * robot waves).
 */
function ShellRoom({ portal, palace, workspaceActivity }: { portal: boolean; palace: boolean; workspaceActivity: AgentActivity }) {
  const { status, approvals } = usePortalLive();
  return <RoomBackground activity={portal ? portalActivity(status, approvals) : workspaceActivity} palace={palace} />;
}

function ChatShell() {
  const pathname = usePathname();
  const [palette, setPalette] = useState<PaletteTab | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);

  const route = useMemo(() => workspaceRoute(pathname ?? "/"), [pathname]);
  // Page surfaces never navigate: the same workspace, including its local state, stays underneath.
  const [retainedRoute, setRetainedRoute] = useState<WorkspaceRoute>(route ?? { kind: "start" });
  if (route && route !== retainedRoute) setRetainedRoute(route);
  const [surface, setSurface] = useState<PageSurface | null>(null);
  /**
   * Palace mode (docs/GLASS.md): the panels leave and the room is all there is. Not stored and not in
   * the URL; a reload starts out of it. `palaceSettled` is false while its animation runs either way;
   * once it has gone out, the panels are hidden and inert (`away`).
   */
  const [palace, setPalace] = useState(false);
  const [palaceSettled, setPalaceSettled] = useState(true);
  const away = palace && palaceSettled;
  /** What had focus before Palace mode; it gets it back on leaving with the pinned logo or Esc. */
  const palaceOpener = useRef<HTMLElement | null>(null);
  const pinnedLogo = useRef<HTMLButtonElement>(null);
  const desktop = useMediaQuery("(min-width: 768px)", true);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const palaceMs = reducedMotion ? PALACE_MS.reduced : desktop ? PALACE_MS.desktop : PALACE_MS.phone;
  /** The focused pane, for where focus lands after leaving Palace mode (set below, once the workspace is read). */
  const focusedPaneId = useRef<string | null>(null);
  /**
   * Where focus goes on leaving Palace mode when what entered it is gone (or something navigated):
   * the focused pane's composer on desktop when `composerFirst`, else the sidebar's logo (the "Show
   * the room" button, back in place), else the composer, else the first sidebar toggle.
   */
  const workspaceFocusTarget = (composerFirst: boolean): HTMLElement | null => {
    const pane = focusedPaneId.current;
    const composer = window.matchMedia("(min-width: 768px)").matches
      ? (pane ? document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(pane)}"] textarea:not(:disabled)`) : null) ??
        document.querySelector<HTMLElement>("[data-workspace-layer] textarea:not(:disabled)")
      : null;
    const logo = document.querySelector<HTMLElement>('.sidebar-slot[data-shown] button[aria-label="Show the room"]');
    const order = composerFirst ? [composer, logo] : [logo, composer];
    return order.find((element) => element?.isConnected) ?? document.getElementById("sidebar-toggle");
  };
  /** Leaving with nothing to restore: focus is on the pinned logo, which goes once the exit has run. */
  const placeFocusAfterExit = useRef(false);
  /** Leave Palace mode; `restoreFocus` when the user asked to (not when something navigated). */
  const leavePalace = useStableCallback((restoreFocus: boolean) => {
    if (!palace) return;
    setPalace(false);
    setPalaceSettled(false);
    const opener = palaceOpener.current;
    palaceOpener.current = null;
    // The panels are inert until this render commits; focus once they are not.
    if (restoreFocus) requestAnimationFrame(() => (opener?.isConnected ? opener : workspaceFocusTarget(false))?.focus());
    else placeFocusAfterExit.current = true;
  });
  useEffect(() => {
    if (palaceSettled) return;
    const release = holdRoomMotion();
    const timer = setTimeout(() => {
      release();
      setPalaceSettled(true);
    }, palaceMs);
    return () => {
      clearTimeout(timer);
      release();
    };
  }, [palace, palaceSettled, palaceMs]);
  useEffect(() => {
    // After a navigation out of Palace mode (a room object, a link): the pinned logo has just gone with
    // focus on it; the workspace the navigation opened takes it, unless something already did.
    if (palace || !palaceSettled || !placeFocusAfterExit.current) return;
    placeFocusAfterExit.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) workspaceFocusTarget(true)?.focus({ preventScroll: true });
  });
  useEffect(() => {
    // Browser Back/Forward is explicit navigation. Background resolver URL repairs leave pages open.
    const onPopState = () => {
      setSurface(null);
      leavePalace(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [leavePalace]);
  /**
   * Enter Palace mode: the sheet, the Agent and Search dialogs and any page overlay close; focus goes
   * to the pinned logo, the only control left outside the room.
   */
  const enterPalace = (opener?: HTMLElement | null) => {
    if (palace) return;
    placeFocusAfterExit.current = false;
    // The control that entered it (the sidebar's logo, which slides away, or the sheet's, which goes):
    // focus comes back to it if it is still there. A click in Safari does not focus the button, so
    // the caller passes it; otherwise whatever had focus.
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    palaceOpener.current = opener ?? focused;
    setPalace(true);
    setPalaceSettled(false);
    setSurface(null);
    setPalette(null);
    setShowSidebar(false);
  };
  useEffect(() => {
    if (palace) pinnedLogo.current?.focus({ preventScroll: true });
  }, [palace]);
  /** Esc enters and leaves Palace mode on desktop (`palaceEscapeToggles`), after every other handler has had the key. */
  const togglePalace = useStableCallback(() => (palace ? leavePalace(true) : enterPalace(null)));
  useEffect(() => {
    let atStart: PalaceKeyState | null = null;
    // What was open when the key went down: a handler on the way may close a dialog before the key gets here.
    const onKeyDownCapture = (event: KeyboardEvent) => {
      atStart = event.key === "Escape" ? palaceKeyState(window.matchMedia("(min-width: 768px)").matches) : null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const state = atStart;
      atStart = null;
      if (!state || !palaceEscapeToggles(event, state)) return;
      event.preventDefault();
      togglePalace();
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [togglePalace]);

  const { workspace, focus, apply, keyOf, setCovered } = useWorkspace();
  useEffect(() => {
    focusedPaneId.current = focus.pane?.id ?? null;
  });
  const actions = useWorkspaceActions();
  const active = focus.sessionId;
  const terminalOpen = surface?.view === "terminal";
  const portalView: PortalView | null = surface && surface.view !== "terminal" && surface.view !== "removed" ? surface.view : null;
  const portalOpen = surface !== null;
  const onStartPage = !surface && (route?.kind === "start" || (focus.pane !== null && focus.pane.sessionId === null));
  useEffect(() => setCovered(surface !== null), [surface, setCovered]);
  const surfaceOpener = useRef<HTMLElement | null>(null);
  const openSurface = useStableCallback((next: PageSurface) => {
    if (!surface) surfaceOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSurface(next);
    setPalette(null);
    setShowSidebar(false);
    leavePalace(false);
  });
  const closeSurface = useStableCallback(() => {
    setSurface(null);
    requestAnimationFrame(() => {
      // A quick reopen or another surface takes focus before this scheduled restoration runs.
      if (document.querySelector('[data-page-overlay], :is([role="dialog"], [role="alertdialog"])[data-state="open"]')) return;
      const opener = surfaceOpener.current;
      const target = opener?.isConnected && opener.getClientRects().length ? opener : workspaceFocusTarget(true);
      target?.focus({ preventScroll: true });
    });
  });
  useEffect(() => {
    if (!surface) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(":is([role=dialog], [role=alertdialog])[data-state=open]")) return;
      event.preventDefault();
      closeSurface();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [surface, closeSurface]);
  /** The focused pane's agent, as the workspace reports it, for the room. */
  const [workspaceActivity, setWorkspaceActivity] = useState<AgentActivity>("idle");
  const {
    agents,
    defaultAgentId,
    sessions,
    loading,
    loadError,
    updateSession,
    putSession,
    removeSession,
    refetchSessions,
    confirmProject,
    historyCache,
  } = useSessions();
  /**
   * The agent and agent settings the user last picked (on the start page or in a session's Agent
   * settings), kept by the server for every project; refreshed each time the start page opens.
   */
  const { lastUsed, save: saveLastUsed } = useLastUsed(onStartPage);
  /** The agent new sessions start with: the last one picked while it is still offered, else the registry's default. */
  const selectedAgentId =
    lastUsed?.agentId && agents.some((agent) => agent.id === lastUsed.agentId)
      ? lastUsed.agentId
      : defaultAgentId;
  const selectAgent = (agentId: string) => saveLastUsed({ agentId });
  /** The start page creating a session (its `startKey`), and the last creation failure with the page it happened in: per pane, not shared. */
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [createError, setCreateError] = useState<{ startKey: string; message: string } | null>(null);
  const creating = creatingIn !== null;
  const sessionError = createError?.message ?? loadError;
  /** The current list, for handlers that must not close over a stale render. */
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const {
    projects,
    loading: projectsLoading,
    addProject,
    renameProject,
    setProjectPinned,
    reorderPinned,
    removeProject,
    refresh: refreshProjects,
  } = useProjects();
  /** Projects removed while conversations still pointed at them; the sidebar's Removed view. */
  const {
    removed: removedProjects,
    loading: removedProjectsLoading,
    error: removedError,
    refresh: refreshRemoved,
    restore: restoreRemoved,
    discard: discardRemoved,
  } = useRemovedProjects();
  const {
    sessionPins,
    toggleSessionPin,
    prune: pruneSessionPins,
  } = useSessionPins();
  /** Project pins come from the server (`pinnedAt`); pinned worktrees are never removed for being idle. */
  const projectPins = useMemo(() => projectPinsOf(projects), [projects]);
  /** Where the user dragged each pinned project to; pins never dragged sort first, newest on top. */
  const projectPinOrder = useMemo(() => projectPinOrderOf(projects), [projects]);
  const toggleProjectPin = useCallback(
    (id: string) => {
      // A refusal is undone by the refetch `setProjectPinned` runs; there is nothing more to show.
      void setProjectPinned(id, !(id in projectPins)).catch(() => {});
    },
    [setProjectPinned, projectPins],
  );
  /** Pinned projects first (most recently pinned on top), then most recently worked in: the sidebar's and the start page's order. */
  const orderedProjects = useMemo(
    () => pinnedFirst(orderProjectsByActivity(projects, sessions), projectPins, projectPinOrder),
    [projects, sessions, projectPins, projectPinOrder],
  );
  /**
   * The project picked this page load: "" for none (the sidebar's "New conversation", and home: `/`
   * opens the start page with nothing picked, docs/GLASS.md), null to fall back to the remembered/newest one.
   */
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(() => (pathname === "/" ? "" : null));
  /** The start page's worktree choice, tied to the project it was made for so a project change resets it. */
  const [worktreePick, setWorktreePick] = useState<{
    projectId: string;
    choice: WorktreeChoice;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** The section a `portal:open-settings` event asked for; null when the dialog was opened from its button. */
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  useOpenSettingsRequests((section) => {
    setPalette(null);
    setSettingsSection(section);
    setShowSettings(true);
  });
  /** Remember the last thread and retain its conversation after Agent first opens. */
  const [agentThreadId, setAgentThreadId] = useState(MAIN_THREAD_ID);
  const [agentVisited, setAgentVisited] = useState(false);
  if (surface?.view === "chat" && !agentVisited) setAgentVisited(true);
  /** What search opened, newest first, per device; the dialog's Recent section. */
  const [searchRecents, setSearchRecents] = usePreference(RECENTS_KEY, "[]");
  /** Capture Agent's shortcut even in composers and terminals; slash belongs to Search only outside editors. */
  useEffect(() => {
    const mac = isMacPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      const tab = paletteShortcut(event, mac);
      if (!tab || (tab === "search" && !searchShortcutAllowed(event.target))) return;
      // Held keys repeat; toggling on each would flicker the dialog. Still keep them from the page.
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      const otherOpen = !!document.querySelector(
        ":is([role=dialog], [role=alertdialog])[data-state=open]:not([data-palette-dialog])",
      );
      if (otherOpen) return;
      event.preventDefault();
      event.stopPropagation();
      if (tab === "agent") {
        if (surface?.view === "chat" && palette !== "search") closeSurface();
        else openSurface({ view: "chat", threadId: agentThreadId });
      } else setPalette((current) => (current === tab ? null : tab));
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [surface, agentThreadId, palette, closeSurface, openSurface]);
  /** The button that opened the sidebar sheet or the GitHub inspector sheet; focus returns there when it closes. */
  const sidebarOpener = useRef<HTMLElement | null>(null);
  const githubOpener = useRef<HTMLElement | null>(null);
  const [sidebarPreference, setSidebarPreference] = usePreference(
    "portal.sidebar.open",
    "true",
  );
  const [githubPreference, setGithubPreference] = usePreference(
    "portal.githubInspector.open",
    "false",
  );
  const showGithub = githubPreference === "true";
  /** Portal preferences; the source control panel's actions read their prompts from here. */
  const { settings } = useSettings();
  const [initialSend, setInitialSend] = useState<InitialSend>(null);
  const creatingRef = useRef(false);
  // Session pins outlive their sessions in storage; forget the ones for sessions that are gone.
  useEffect(() => {
    if (loading || sessionError) return;
    pruneSessionPins(sessions.map((s) => s.id));
  }, [loading, sessionError, sessions, pruneSessionPins]);

  // The project new sessions start in: the chosen one while it exists, else the remembered one, else the newest.
  // Projects only arrive after mount, so this stays "" during server rendering and hydration.
  const selectedProjectId = useMemo(() => {
    if (projectsLoading) return chosenProjectId ?? "";
    if (chosenProjectId === "") return "";
    if (chosenProjectId && projects.some((p) => p.id === chosenProjectId))
      return chosenProjectId;
    const stored = readStoredProjectId();
    if (stored && projects.some((p) => p.id === stored)) return stored;
    return projects.at(-1)?.id ?? "";
  }, [chosenProjectId, projects, projectsLoading]);

  const selectProject = (projectId: string) => {
    setChosenProjectId(projectId);
    if (projectId) storeProjectId(projectId);
  };

  const worktreeChoice =
    worktreePick?.projectId === selectedProjectId
      ? worktreePick.choice
      : ORIGINAL;

  // Keep the user's picks, refreshing the available models/modes from a connected session.
  // A saved option list can predate an adapter upgrade even after Portal itself restarts.
  const storedSettings = lastUsed?.settings[selectedAgentId];
  const startSettings = useMemo(
    () => startSettingsForAgent(sessions, selectedAgentId, storedSettings),
    [storedSettings, selectedAgentId, sessions],
  );
  const changeStartSetting = (request: SetConfigRequest) => {
    if (!startSettings) return;
    saveLastUsed({
      settings: {
        [selectedAgentId]: applyConfigChange(settingsOf(startSettings), request),
      },
    });
  };

  /**
   * Move a new session's settings to the ones chosen on the start page, one request at a time
   * since a model switch can change the choices of later options. Resolves with the final state.
   */
  const applyStartSettings = async (
    sessionId: string,
    desired: SessionListState,
    actual: SessionState,
  ) => {
    let state = actual;
    for (let step = 0; step < MAX_CONFIG_STEPS; step++) {
      const request = nextConfigChange(desired, state);
      if (!request) break;
      let r: Response;
      try {
        r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
      } catch {
        throw new Error(
          "Could not reach the server to apply the agent settings.",
        );
      }
      const j = (await r.json().catch(() => ({}))) as {
        state?: SessionState;
        error?: string;
      };
      if (!r.ok || !j.state)
        throw new Error(j.error ?? "Could not apply the agent settings.");
      state = j.state;
    }
    return state;
  };

  /** Open a session (decision 8): focus its pane if it is open anywhere, else a new tab; the URL drives the rest. */
  const selectSession = (sessionId: string) => {
    setSurface(null);
    setPalette(null);
    leavePalace(false);
    void actions.openSession(sessionId);
    // The session's project becomes the default for the next new session.
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId;
    if (projectId && projects.some((p) => p.id === projectId))
      selectProject(projectId);
    setShowSidebar(false);
  };

  const initialSendHandled = useCallback((id: string) => {
    setInitialSend((previous) =>
      previous?.sessionId === id && !previous.pending ? null : previous,
    );
  }, []);

  /** Another viewer deleted an open session, or the server dropped it; the server closes its pane and pushes the workspace. */
  const sessionDeleted = useCallback(
    (id: string) => {
      removeSession(id);
    },
    [removeSession],
  );

  /** `DELETE /api/sessions/[id]`; leaves the session if it is open. Rejects with the server's message. */
  const deleteSession = async (sessionId: string) => {
    let r: Response;
    try {
      r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    } catch {
      throw new Error(
        "Could not reach the server. Check the connection and try again.",
      );
    }
    if (!r.ok && r.status !== 404) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? "Could not delete the session. Try again.");
    }
    removeSession(sessionId);
    historyCache.delete(sessionId);
    writeDraft(sessionId, "");
    forgetPromptHistory(sessionHistoryKey(sessionId));
    // A removed project's last conversation going away drops its Removed row.
    void refreshRemoved();
  };

  /** Remove a project; while conversations reference it, it moves to the Removed view. */
  const removeProjectFromWorkspace: typeof removeProject = async (id, opts) => {
    await removeProject(id, opts);
    void refreshRemoved();
  };

  /**
   * Bring a removed project back (recreating its worktree when needed), then open its most recent
   * conversation (or the one being viewed); opening a persisted session reconnects its agent.
   */
  const restoreProject = async (id: string, sessionId?: string) => {
    const project = await restoreRemoved(id);
    confirmProject(project);
    // The project is back either way; a failed refetch only costs the jump to its conversation.
    const [, fetched] = await Promise.all([
      refreshProjects(),
      refetchSessions().catch(() => sessionsRef.current),
    ]);
    selectProject(project.id);
    setSurface(null);
    setPalette(null);
    leavePalace(false);
    const target = sessionId ?? fetched
      .filter((s) => s.projectId === project.id)
      .sort(byRecentActivity)[0]?.id;
    if (target) await actions.openSession(target);
    else await actions.openStartTab();
    setShowSidebar(false);
  };

  /** Delete a removed project's conversations for good; the list feed leaves the open one if it was among them. */
  const discardRemovedProject = async (id: string) => {
    await discardRemoved(id);
    await refetchSessions().catch(() => {});
  };

  const canCreate =
    !loading &&
    !projectsLoading &&
    !!lastUsed &&
    !creating &&
    !!selectedAgentId &&
    !!selectedProjectId;

  /** Create (or reuse) the worktree project for `choice` under `projectId`; rejects with the server's message. */
  const ensureWorktreeProject = async (
    projectId: string,
    choice: Exclude<WorktreeChoice, { kind: "original" }>,
  ) => {
    let r: Response;
    try {
      r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branch: choice.branch,
            create: choice.kind === "create",
          }),
        },
      );
    } catch {
      throw new Error(
        "Could not prepare the worktree. Check the server connection and try again.",
      );
    }
    const j = (await r.json().catch(() => ({}))) as {
      project?: ProjectSummary;
      error?: string;
    };
    if (!r.ok || !j.project)
      throw new Error(j.error ?? "Could not prepare the worktree. Try again.");
    return j.project;
  };

  /** A project's "New conversation": a start-page tab with `projectId` selected so the worktree picker is available. */
  const startIn = (projectId: string) => {
    setSurface(null);
    setPalette(null);
    leavePalace(false);
    selectProject(projectId);
    void actions.openStartTab();
    setShowSidebar(false);
  };

  /** The Projects column's `+`: a start-page tab with no project chosen, since the button belongs to none. */
  const startFresh = () => {
    setSurface(null);
    setPalette(null);
    leavePalace(false);
    setChosenProjectId("");
    setWorktreePick(null);
    void actions.openStartTab();
    setShowSidebar(false);
  };

  /** The start page's folder pick: add it as a project (or take the existing one) and select it. */
  const addFolder = async (path: string) => {
    const project = await addProject({ path });
    selectProject(project.id);
  };

  const openTerminal = () => openSurface({ view: "terminal" });
  const openPortalView = (view: PortalView) => {
    if (view === "chat") {
      setAgentThreadId(MAIN_THREAD_ID);
      openSurface({ view: "chat", threadId: MAIN_THREAD_ID });
    } else openSurface(view === "memory" ? { view, entityId: null } : { view });
  };
  // Legacy paths remain a link format inside stored replies, but never become page URLs.
  const navigateSurface = useStableCallback((path: string) => {
    const destination = new URL(path, window.location.origin);
    if (destination.origin !== window.location.origin) return;
    // `/` and `/palace` opened the Palace page; they enter Palace mode now. Anything else leaves it on the way.
    if (isPalaceLinkPath(destination.pathname)) { enterPalace(null); return; }
    leavePalace(false);
    const sessionId = sessionIdFromPath(destination.pathname);
    if (sessionId) { selectSession(sessionId); return; }
    if (workspaceRoute(destination.pathname)) {
      setSurface(null);
      setPalette(null);
      pushPath(`${destination.pathname}${destination.search}`);
      return;
    }
    if (isTerminalPath(destination.pathname)) { openTerminal(); return; }
    const location = portalLocation(destination.pathname);
    if (location.view === "chat") {
      setAgentThreadId(location.threadId);
      openSurface(location);
    } else openSurface(location);
  });

  useEffect(() => {
    const onNavigate = (event: Event) => navigateSurface((event as CustomEvent<string>).detail);
    window.addEventListener(APP_NAVIGATION_EVENT, onNavigate);
    return () => window.removeEventListener(APP_NAVIGATION_EVENT, onNavigate);
  }, [navigateSurface]);

  /** The sidebar toggle: collapse or expand on desktop, the sheet on mobile (focus returns to `opener` when it closes). */
  const toggleSidebar = (opener?: HTMLElement | null) => {
    sidebarOpener.current = opener ?? null;
    if (desktop)
      setSidebarPreference(sidebarPreference === "true" ? "false" : "true");
    else setShowSidebar(true);
  };
  const toggleGithub = (opener?: HTMLElement | null) => {
    githubOpener.current = opener ?? null;
    setGithubPreference(showGithub ? "false" : "true");
  };

  /**
   * Start a session in `projectId`, first turning a non-Original `choice` into its worktree project.
   * It opens in `paneId` (the start-page pane that asked, decision 9), else in a new tab. `key` is
   * the asking start page's `startKey`: its draft, and where the spinner and any error show.
   * A first message (`firstPrompt` given, even empty) takes the start page's attachments: they
   * move to the new session's composer, upload there, and go out with the text (docs/FILES.md).
   */
  const newSession = async (
    projectId: string = selectedProjectId,
    choice: WorktreeChoice = ORIGINAL,
    firstPromptText?: string,
    paneId: string | null = null,
    key: string = startKey(null),
  ) => {
    if (
      creatingRef.current ||
      loading ||
      projectsLoading ||
      !selectedAgentId ||
      !projectId
    )
      return;
    const firstPrompt = firstPromptText ?? "";
    // "Start an empty conversation" passes no text and sends nothing; any attachments still move to the session's composer.
    const firstSend =
      !!firstPrompt.trim() ||
      (firstPromptText !== undefined && readAttachments(key).length > 0);
    creatingRef.current = true;
    setCreatingIn(key);
    setCreateError(null);
    const setSessionError = (message: string) => setCreateError({ startKey: key, message });
    const agentId = selectedAgentId;
    const desiredSettings = startSettings;
    if (projectId !== selectedProjectId) selectProject(projectId);
    try {
      if (choice.kind !== "original") {
        let worktreeProject: ProjectSummary;
        try {
          worktreeProject = await ensureWorktreeProject(projectId, choice);
        } catch (e) {
          setSessionError(
            e instanceof Error
              ? e.message
              : "Could not prepare the worktree. Try again.",
          );
          return;
        }
        await refreshProjects();
        projectId = worktreeProject.id;
        selectProject(projectId);
      }
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, agentId }),
      });
      const session = (await r.json()) as SessionDetail & { error?: string };
      if (!r.ok || !session.id) {
        setSessionError(
          session.error ??
            "Could not create a session. Check the server and try again.",
        );
        return;
      }
      // The worktree choice was for this start only; the next start page begins at Original again.
      setWorktreePick(null);
      putSession({ ...session, liveness: session.liveness.state });
      if (firstSend) {
        writeDraft(session.id, firstPrompt);
        clearSubmittedDraft(key, firstPrompt);
        // The session's composer is keyed by its id: a failed upload or send leaves the chips there to retry.
        moveAttachments(key, session.id);
        setInitialSend({ sessionId: session.id, pending: true, error: null });
      } else {
        // The start page goes with its key; its chips (and their previews) would be left behind there.
        moveAttachments(key, session.id);
      }
      await placeNewSession(session.id, paneId);
      setShowSidebar(false);
      try {
        const state = desiredSettings
          ? await applyStartSettings(session.id, desiredSettings, session.state)
          : session.state;
        if (desiredSettings) updateSession(session.id, { state });
        // The record takes this session's option lists (an agent may offer new models since) with
        // the values chosen, so the next start page shows what the agent offers now.
        const settings = desiredSettings
          ? overlaySettings(desiredSettings, state)
          : settingsOf(state);
        saveLastUsed({
          agentId,
          ...(hasSettings(settings) ? { settings: { [agentId]: settings } } : {}),
        });
      } catch (error) {
        setInitialSend({
          sessionId: session.id,
          pending: false,
          error: `${error instanceof Error ? error.message : "Could not apply the agent settings."} Check Agent settings, then send your message.`,
        });
        return;
      }
      if (firstSend) {
        try {
          const { attachments, ids } = await uploadAttachments(session.id, session.id);
          const response = await fetch(
            `/api/sessions/${encodeURIComponent(session.id)}/prompt`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: firstPrompt.trim(),
                ...(attachments.length ? { attachments } : {}),
              }),
            },
          );
          if (!response.ok) {
            const result = (await response.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(
              result.error ??
                "Could not send your first message. Your draft is saved; try again.",
            );
          }
          clearSubmittedDraft(session.id, firstPrompt);
          clearAttachments(session.id, ids);
          if (firstPrompt.trim()) recordPrompt(sessionHistoryKey(session.id), firstPrompt);
          setInitialSend(null);
        } catch (error) {
          setInitialSend({
            sessionId: session.id,
            pending: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not send your first message. Your draft is saved; try again.",
          });
        }
      }
    } catch {
      setSessionError(
        "Could not create a session. Check the server connection and try again.",
      );
    } finally {
      creatingRef.current = false;
      setCreatingIn(null);
    }
  };

  /**
   * Where a new session shows: the start-page pane that asked becomes its pane (`replace_pane`),
   * else it opens in a new tab. If the workspace refuses, the session page path still resolves it.
   */
  const placeNewSession = async (sessionId: string, paneId: string | null) => {
    try {
      const { workspace: next, location } = paneId
        ? await apply({ op: "replace_pane", paneId, sessionId })
        : await apply({ op: "open", sessionId });
      if (location) navigateTo(locationPath(next, location), { replace: !!paneId });
    } catch {
      pushPath(sessionPath(sessionId));
    }
  };

  // The GitHub panel follows the focused pane's session's project, else the project new sessions start in.
  // Nothing until the session list has loaded, so it does not fetch the start page's project and then switch.
  const activeSession = sessions.find((s) => s.id === active);
  const githubProjectId = active
    ? !loading &&
      activeSession &&
      projects.some((p) => p.id === activeSession.projectId)
      ? activeSession.projectId
      : null
    : selectedProjectId || null;
  const githubProjectRemoved =
    !!active &&
    !!activeSession &&
    activeSession.projectId !== "" &&
    !githubProjectId;

  /**
   * A source control panel action: draft its prompt on the start page for the panel's project, so
   * the user picks the agent and model and sends. Nothing is created until they do. The draft goes
   * to the start page that opens (or is reused), under that pane's key.
   */
  const startGitAction = (kind: GitActionKind, summary: GithubSummary) => {
    if (!githubProjectId) return;
    const promptText = (settings ?? defaultSettings).gitActions.prompts[kind];
    const text = buildGitActionPrompt(kind, summary, promptText);
    selectProject(githubProjectId);
    // The start page begins at Original again; the draft replaces whatever was there.
    setWorktreePick(null);
    void actions.openStartTab().then((location) => {
      writeDraft(startKey(location ? keyOf(location.paneId) : null), text);
    });
    setShowSidebar(false);
  };
  /** The sessions open somewhere in the workspace: their sidebar rows get the tab glyph (not the focused one's, decision 27). */
  const openSessionIds = useMemo(
    () => new Set(allPanes(workspace).flatMap(({ pane }) => (pane.sessionId === null || pane.sessionId === active ? [] : [pane.sessionId]))),
    [workspace, active],
  );
  // Decision: the document title is the page overlay's, else the focused file's name or session's display title, else "Portal".
  const focusedFile = focus.leaf?.kind === "file" ? focus.leaf.path : null;
  const activeTitle = surface ? surface.view === "chat" ? "Agent" : surface.view === "attention" ? "Foyer" : surface.view === "removed" ? "Removed projects" : surface.view[0].toUpperCase() + surface.view.slice(1) : focusedFile !== null ? focusedFile.split("/").pop() || focusedFile : activeSession ? sessionDisplayTitle(activeSession.title) : null;
  useEffect(() => {
    document.title = activeTitle ?? "Portal";
  }, [activeTitle]);
  // The start page's handlers, stable so `start` (and the memoised panes holding it) only changes with its data.
  const startSelectProject = useStableCallback(selectProject);
  const startAddFolder = useStableCallback(addFolder);
  const startWorktreeChange = useStableCallback((choice: WorktreeChoice) => setWorktreePick({ projectId: selectedProjectId, choice }));
  const startSelectAgent = useStableCallback(selectAgent);
  const startSettingsChange = useStableCallback(changeStartSetting);
  const startCreate = useStableCallback((text: string | undefined, paneId: string | null, key: string) => {
    void newSession(selectedProjectId, worktreeChoice, text, paneId, key);
  });
  const startLoading = loading || projectsLoading || !lastUsed;
  /** The start page's props, shared by every start-page pane; the per-pane parts are keyed by `startKey` (see `StartPaneProps`). */
  const start = useMemo<StartPaneProps>(
    () => ({
      projects: orderedProjects,
      projectPins,
      selectedProjectId,
      onSelectProject: startSelectProject,
      onAddFolder: startAddFolder,
      worktree: worktreeChoice,
      onWorktreeChange: startWorktreeChange,
      agents,
      selectedAgentId,
      onSelectAgent: startSelectAgent,
      settings: startSettings,
      onSettingsChange: startSettingsChange,
      loading: startLoading,
      canCreate,
      creatingIn,
      createError,
      loadError,
      onCreate: startCreate,
    }),
    [
      orderedProjects,
      projectPins,
      selectedProjectId,
      startSelectProject,
      startAddFolder,
      worktreeChoice,
      startWorktreeChange,
      agents,
      selectedAgentId,
      startSelectAgent,
      startSettings,
      startSettingsChange,
      startLoading,
      canCreate,
      creatingIn,
      createError,
      loadError,
      startCreate,
    ],
  );
  // Stable identities for the sidebar: its rows are memoised, and this component re-renders on
  // every list-stream event, so an inline arrow here would re-render every row each time.
  const sidebarSelect = useStableCallback((id: string) => selectSession(id));
  const sidebarOpenInTab = useStableCallback((id: string) => {
    setSurface(null);
    setPalette(null);
    leavePalace(false);
    void actions.moveToNewTab(id);
    setShowSidebar(false);
  });
  const sidebarOpenBeside = useStableCallback((id: string) => {
    setSurface(null);
    setPalette(null);
    leavePalace(false);
    void actions.openBeside(id);
    setShowSidebar(false);
  });
  const sidebarPrefetch = useStableCallback((id: string) => historyCache.prefetch(id));
  const sidebarDelete = useStableCallback(deleteSession);
  const sidebarNewSession = useStableCallback(startIn);
  const sidebarNewConversation = useStableCallback(startFresh);
  const sidebarReorderPinned = useStableCallback(async (ids: readonly string[]) => {
    await reorderPinned(ids);
  });
  const sidebarOpenSettings = useStableCallback(() => setShowSettings(true));
  const sidebarOpenSearch = useStableCallback(() => {
    setShowSidebar(false);
    setPalette("search");
  });
  /** Remember what search opened (its Recent section), newest first; entries for what is gone make room. */
  const rememberSearchOpen = (kind: RecentItem["kind"], id: string) => {
    const kept = pruneRecents(parseRecents(searchRecents), sessionsRef.current, projects);
    setSearchRecents(JSON.stringify(recentsAfterOpen(kept, { kind, id, at: Date.now() })));
  };
  const searchOpenSession = useStableCallback((id: string) => {
    rememberSearchOpen("session", id);
    selectSession(id);
  });
  const searchOpenProject = useStableCallback((id: string) => {
    rememberSearchOpen("project", id);
    startIn(id);
  });
  const sidebarRename = useStableCallback(async (id: string, name: string) => {
    await renameProject(id, name);
  });
  const sidebarRemove = useStableCallback(removeProjectFromWorkspace);
  const sidebarRefreshRemoved = useStableCallback(refreshRemoved);
  const sidebarRestore = useStableCallback(restoreProject);
  const sidebarDiscard = useStableCallback(discardRemovedProject);
  const sidebarClose = useStableCallback(() => setShowSidebar(false));
  const sidebarTerminal = useStableCallback(openTerminal);
  const sidebarPortalView = useStableCallback(openPortalView);
  const sidebarCollapse = useStableCallback(() => setSidebarPreference("false"));
  const sidebarShowRoom = useStableCallback(enterPalace);
  /** The room's frames open their project the way the sidebar's project entries do: a start page with it picked. */
  const roomOpenProject = useStableCallback(startIn);
  const roomHost = useMemo(() => ({ projects, openProject: roomOpenProject }), [projects, roomOpenProject]);
  /** The phone bar's Agent button and reply preview (docs/WORKSPACE.md, Mobile). */
  const openAgent = useStableCallback((threadId?: string) => {
    if (threadId) setAgentThreadId(threadId);
    openSurface({ view: "chat", threadId: threadId ?? agentThreadId });
  });
  const agentInbox = useAgentInboxState({ open: surface?.view === "chat", threadId: agentThreadId, previews: !desktop, openAgent });
  const restoreSearchFocus = useStableCallback(() => {
    if (surface?.view !== "chat") return false;
    const composer = document.querySelector<HTMLTextAreaElement>(`[data-agent-page] [data-thread="${CSS.escape(agentThreadId)}"] textarea:not(:disabled)`);
    if (!composer) return false;
    composer.focus({ preventScroll: true });
    return true;
  });

  return (
    <AgentInboxProvider value={agentInbox}>
    <RoomHostProvider value={roomHost}>
      <div className="portal-shell" data-palace-mode={palace ? (away ? "away" : "") : undefined}>
        <Sidebar
          projects={orderedProjects}
          projectPins={projectPins}
          sessionPins={sessionPins}
          onTogglePinProject={toggleProjectPin}
          onTogglePinSession={toggleSessionPin}
          active={active}
          selectedProjectId={active === null && route !== null && !surface && !palace ? selectedProjectId || null : null}
          openSessionIds={openSessionIds}
          onSelect={sidebarSelect}
          onOpenInNewTab={sidebarOpenInTab}
          onOpenBeside={sidebarOpenBeside}
          canOpenBeside={focus.tab !== null && focus.pane !== null && canSplitPane(workspace, focus.tab.id, focus.pane.id, "right")}
          returnFocus={sidebarOpener}
          onPrefetch={sidebarPrefetch}
          onDeleteSession={sidebarDelete}
          onNewSession={sidebarNewSession}
          onNewConversation={sidebarNewConversation}
          onReorderPinned={sidebarReorderPinned}
          onOpenSettings={sidebarOpenSettings}
          onOpenSearch={sidebarOpenSearch}
          onOpenAgent={() => openAgent()}
          onOpenRemoved={() => openSurface({ view: "removed" })}
          onRenameProject={sidebarRename}
          onRemoveProject={sidebarRemove}
          removedProjects={removedProjects}
          removedError={removedError}
          onRefreshRemoved={sidebarRefreshRemoved}
          onRestoreProject={sidebarRestore}
          onDiscardRemoved={sidebarDiscard}
          open={showSidebar}
          onClose={sidebarClose}
          onTerminal={sidebarTerminal}
          terminalActive={terminalOpen}
          onPortalView={sidebarPortalView}
          portalView={portalView}
          projectsActive={route !== null}
          desktopOpen={sidebarPreference === "true"}
          onCollapse={sidebarCollapse}
          onShowRoom={sidebarShowRoom}
          away={away}
        />
        <SettingsDialog
          open={showSettings}
          section={settingsSection}
          onRemovedDeleted={() => void refreshRemoved()}
          onClose={() => {
            setShowSettings(false);
            setSettingsSection(null);
          }}
        />
        <SearchDialog
          open={palette === "search"}
          onClose={() => setPalette(null)}
          sessions={sessions}
          projects={orderedProjects}
          onOpenSession={searchOpenSession}
          onOpenProject={searchOpenProject}
          onRestoreFocus={restoreSearchFocus}
        />
        <ShellRoom portal={portalOpen || palace} palace={palace} workspaceActivity={workspaceActivity} />
        {/* The centre panel (docs/GLASS.md, Floating panels): a rounded clip, not frosted; page overlays fill it. */}
        <div data-shell-centre inert={away} className="shell-centre relative flex min-h-0 min-w-0 flex-1">
          <div data-workspace-layer inert={surface !== null} aria-hidden={surface !== null || undefined} className={`flex min-h-0 min-w-0 flex-1 ${surface ? "invisible pointer-events-none" : ""}`}>
            <Suspense fallback={<main className="flex min-w-0 flex-1 flex-col" />}>
              <WorkspaceView
                route={route ?? retainedRoute}
                start={start}
                removedProjects={removedProjects}
                removedProjectsLoading={removedProjectsLoading}
                removedProjectsError={removedError}
                onRefreshRemovedProjects={refreshRemoved}
                onRestoreProject={restoreProject}
                onOpenSidebar={toggleSidebar}
                showGithub={showGithub}
                onToggleGithub={toggleGithub}
                initialSend={initialSend}
                onInitialSendHandled={initialSendHandled}
                onSessionDeleted={sessionDeleted}
                onRoomActivity={setWorkspaceActivity}
              />
            </Suspense>
          </div>
          {agentVisited && <AgentPage open={surface?.view === "chat"} onClose={closeSurface} threadId={agentThreadId} onThreadChange={setAgentThreadId} onNavigate={navigateSurface} onOpenSidebar={toggleSidebar} unread={agentInbox.unread} />}
          {surface && surface.view !== "chat" ? <div key={surface.view} data-page-overlay role="region" aria-label={surface.view === "removed" ? "Removed projects" : surface.view} className="page-overlay">
            {surface.view === "terminal" ? <TerminalPage onOpenSidebar={toggleSidebar} onClose={closeSurface} /> : surface.view === "removed" ? <RemovedProjects rows={removedProjects} error={removedError} onRefresh={sidebarRefreshRemoved} onRestore={sidebarRestore} onDiscard={sidebarDiscard} onBack={closeSurface} /> : <PortalPage location={surface} onNavigate={navigateSurface} onOpenSidebar={toggleSidebar} onOpenSession={sidebarSelect} onClose={closeSurface} />}
          </div> : null}
        </div>
        {/* The shell's third panel, beside the centre rather than in it; hidden under a page overlay as before. */}
        {showGithub && <GithubInspector open={showGithub && !surface} onClose={() => setGithubPreference("false")} projectId={githubProjectId} projectRemoved={githubProjectRemoved} session={activeSession} onGitAction={startGitAction} returnFocus={githubOpener} away={away} />}
        {palace && (
          // The room, see-through for its hover cards and clicks (`room/pointer.ts`) while the panels are out.
          <div data-palace-layer className="fixed inset-0 z-20 flex">
            <PalaceView />
          </div>
        )}
        {(palace || !palaceSettled) && (
          // The pinned logo (docs/GLASS.md, Palace mode): where the sidebar's was, the way back. Liquid
          // only once the sidebar has gone, since liquid panels must not overlap.
          <button
            ref={pinnedLogo}
            type="button"
            aria-label="Back to workspace"
            data-palace-logo={palace ? "in" : "out"}
            onClick={() => leavePalace(true)}
            className={`palace-logo frost-subtle${away ? " liquid" : ""}`}
          >
            <PortalMark />
          </button>
        )}
        <ApprovalsDialog onNavigate={navigateSurface} />
      </div>
    </RoomHostProvider>
    </AgentInboxProvider>
  );
}
