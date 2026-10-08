"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useMediaQuery } from "./useMediaQuery";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { usePreference } from "./usePreference";
import { clearSubmittedDraft, startKey, writeDraft } from "@/lib/drafts";
import {
  forgetPromptHistory,
  recordPrompt,
  sessionHistoryKey,
} from "@/lib/prompt-history";
import Sidebar from "./Sidebar";
import type { InitialSend, StartPaneProps } from "./SessionPane";
import TerminalPage from "./TerminalPage";
import PortalPage from "./PortalPage";
import WorkspaceView from "./workspace/WorkspaceView";
import { useWorkspaceActions } from "./workspace/useWorkspaceActions";
import { PortalLiveProvider } from "./portal/PortalLive";
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
  latestStateForAgent,
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
  isSearchShortcut,
  parseRecents,
  pruneRecents,
  RECENTS_KEY,
  recentsAfterOpen,
  type RecentItem,
} from "@/lib/search";
import {
  isPortalPath,
  isTerminalPath,
  portalLocation,
  portalPathKeepingPanel,
  sessionPath,
  terminalPath,
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

/** The app shell: sidebar, project selection, and the workspace (or Portal, or the terminal) named by the URL. */
function ChatShell() {
  const pathname = usePathname();
  /**
   * The workspace route from the URL: a tab (its pane comes from the query, read by the view), or a
   * resolver (`/new`, `/sessions/<id>`) the view settles; null on Portal and the terminal.
   */
  const route = useMemo(() => workspaceRoute(pathname ?? "/"), [pathname]);
  const { workspace, focus, apply, keyOf } = useWorkspace();
  const actions = useWorkspaceActions();
  /** The focused pane's session (decision 27): the sidebar's highlight, the GitHub inspector's session, the title. */
  const active = focus.sessionId;
  /** The standalone terminal page: no session, no start page. */
  const terminalOpen = isTerminalPath(pathname ?? "/");
  /** A start page is on screen: the focused pane is one, or `/new` is resolving. */
  const onStartPage = route?.kind === "start" || (focus.pane !== null && focus.pane.sessionId === null);
  /** Portal, the orchestrator: the home (`/`) and its views, outside every project and session. */
  const portalOpen = isPortalPath(pathname ?? "/");
  const portalView: PortalView | null = portalOpen ? portalLocation(pathname ?? "/").view : null;
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
  /** The project picked this page load: "" for none (the sidebar's "New conversation"), null to fall back to the remembered/newest one. */
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
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
    setSettingsSection(section);
    setShowSettings(true);
  });
  const [showSearch, setShowSearch] = useState(false);
  /** What search opened, newest first, per device; the dialog's Recent section. */
  const [searchRecents, setSearchRecents] = usePreference(RECENTS_KEY, "[]");
  /**
   * ⌘K (Ctrl+K off Apple platforms) toggles search from anywhere, a focused composer or terminal
   * included: caught at the document in the capture phase, before xterm or a textarea sees it.
   * Another open dialog (settings, approvals, a sheet) keeps it, and keeps the key.
   */
  useEffect(() => {
    const mac = isMacPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event, mac)) return;
      // Held keys repeat; toggling on each would flicker the dialog. Still keep them from the page.
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      const searchOpen = !!document.querySelector("[data-search-dialog][data-state=open]");
      const otherOpen = !!document.querySelector(
        ":is([role=dialog], [role=alertdialog])[data-state=open]:not([data-search-dialog])",
      );
      if (!searchOpen && otherOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setShowSearch(!searchOpen);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const [showSidebar, setShowSidebar] = useState(false);
  /** The button that opened the sidebar sheet or the GitHub inspector sheet; focus returns there when it closes. */
  const sidebarOpener = useRef<HTMLElement | null>(null);
  const githubOpener = useRef<HTMLElement | null>(null);
  const desktop = useMediaQuery("(min-width: 768px)", true);
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

  // The start page's agent settings: the ones the user last left this agent with (with the option
  // lists they were picked from). Before Portal has any for the agent, its latest session's; null
  // until the agent has had a session.
  const storedSettings = lastUsed?.settings[selectedAgentId];
  const startSettings = useMemo(
    () => storedSettings ?? latestStateForAgent(sessions, selectedAgentId),
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
   * conversation; opening a persisted session is what reconnects its agent.
   */
  const restoreProject = async (id: string) => {
    const project = await restoreRemoved(id);
    // The project is back either way; a failed refetch only costs the jump to its conversation.
    const [, fetched] = await Promise.all([
      refreshProjects(),
      refetchSessions().catch(() => sessionsRef.current),
    ]);
    selectProject(project.id);
    const newest = fetched
      .filter((s) => s.projectId === project.id)
      .sort(byRecentActivity)[0];
    if (newest) void actions.openSession(newest.id);
    else void actions.openStartTab();
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
    selectProject(projectId);
    void actions.openStartTab();
    setShowSidebar(false);
  };

  /** The Projects column's `+`: a start-page tab with no project chosen, since the button belongs to none. */
  const startFresh = () => {
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

  /** The sidebar's Terminal button: open the standalone terminal page. */
  const openTerminal = () => {
    if (!terminalOpen) pushPath(terminalPath());
    setShowSidebar(false);
  };

  /**
   * A Portal entry in the sidebar: open that view's root (Chat is the main thread, `/`). Compares
   * paths, not views, so Chat from a side thread returns to the main thread and Memory from an
   * entity returns to the list. The tracked panel's `?session=` stays open across Portal views; a
   * session page, the terminal, and `/new` carry no query, so leaving Portal drops it.
   */
  const openPortalView = (view: PortalView) => {
    const path = portalPathKeepingPanel(view, window.location.search);
    if (path !== `${window.location.pathname}${window.location.search}`) pushPath(path);
    setShowSidebar(false);
  };

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
   */
  const newSession = async (
    projectId: string = selectedProjectId,
    choice: WorktreeChoice = ORIGINAL,
    firstPrompt = "",
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
      if (firstPrompt.trim()) {
        writeDraft(session.id, firstPrompt);
        clearSubmittedDraft(key, firstPrompt);
        setInitialSend({ sessionId: session.id, pending: true, error: null });
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
      if (firstPrompt.trim()) {
        try {
          const response = await fetch(
            `/api/sessions/${encodeURIComponent(session.id)}/prompt`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: firstPrompt.trim() }),
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
          recordPrompt(sessionHistoryKey(session.id), firstPrompt);
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
  // Decision: the document title is the focused session's display title, else "Portal".
  const activeTitle = activeSession ? sessionDisplayTitle(activeSession.title) : null;
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
    void actions.moveToNewTab(id);
    setShowSidebar(false);
  });
  const sidebarOpenBeside = useStableCallback((id: string) => {
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
    setShowSearch(true);
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

  return (
    <div className="portal-shell">
      <Sidebar
        projects={orderedProjects}
        projectPins={projectPins}
        sessionPins={sessionPins}
        onTogglePinProject={toggleProjectPin}
        onTogglePinSession={toggleSessionPin}
        active={active}
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
        open={showSearch}
        onOpenChange={setShowSearch}
        sessions={sessions}
        projects={orderedProjects}
        onOpenSession={searchOpenSession}
        onOpenProject={searchOpenProject}
      />
      {portalOpen ? (
        <PortalPage
          pathname={pathname ?? "/"}
          onNavigate={pushPath}
          onOpenSidebar={toggleSidebar}
          onOpenSession={sidebarSelect}
        />
      ) : terminalOpen ? (
        <TerminalPage onOpenSidebar={toggleSidebar} />
      ) : route ? (
        /* The view reads `?pane=` with useSearchParams, which needs a boundary on the prerendered `/new`; the data is client-side anyway. */
        <Suspense fallback={<main className="flex min-w-0 flex-1 flex-col" />}>
          <WorkspaceView
            route={route}
            start={start}
            onOpenSidebar={toggleSidebar}
            showGithub={showGithub}
            onToggleGithub={toggleGithub}
            initialSend={initialSend}
            onInitialSendHandled={initialSendHandled}
            onSessionDeleted={sessionDeleted}
          />
        </Suspense>
      ) : null}
      {showGithub && !terminalOpen && !portalOpen && (
        <GithubInspector
          open={showGithub}
          onClose={() => setGithubPreference("false")}
          projectId={githubProjectId}
          projectRemoved={githubProjectRemoved}
          session={activeSession}
          onGitAction={startGitAction}
          returnFocus={githubOpener}
        />
      )}
      <ApprovalsDialog
        onNavigate={(path) => {
          // Its links are Portal paths; the tracked panel's session stays open across them.
          pushPath(
            isPortalPath(path)
              ? portalPathKeepingPanel(portalLocation(path), window.location.search)
              : path,
          );
          setShowSidebar(false);
        }}
      />
    </div>
  );
}
