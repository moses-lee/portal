"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { useMediaQuery } from "./useMediaQuery";
import { usePreference } from "./usePreference";
import { clearSubmittedDraft, writeDraft } from "@/lib/drafts";
import Sidebar from "./Sidebar";
import SessionPane from "./SessionPane";
import TerminalPage from "./TerminalPage";
import PortalPage from "./PortalPage";
import AddProjectDialog from "./AddProjectDialog";
import SettingsDialog from "./SettingsDialog";
import { usePins } from "./usePins";
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
import { pinnedFirst } from "@/lib/pins";
import { createHistoryCache } from "@/lib/history-cache";
import { byRecentActivity, orderProjectsByActivity } from "@/lib/session-groups";
import { defaultSettings, type GitActionKind } from "@/lib/settings";
import {
  applyConfigChange,
  latestStateForAgent,
  nextConfigChange,
} from "@/lib/session-config";
import {
  isPortalPath,
  isTerminalPath,
  portalPath,
  sessionIdFromPath,
  sessionPath,
  terminalPath,
} from "@/lib/session-routes";
import type {
  AgentInfo,
  EventPage,
  GithubSummary,
  ProjectSummary,
  SessionListEvent,
  SessionState,
  SessionSummary,
  SetConfigRequest,
} from "@/lib/types";

const GithubInspector = dynamic(() => import("./GithubInspector"));

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

/** The app shell: sidebar, session list, project selection, and the pane for the session named by the URL. */
/** The latest transcript page for the history cache; null when the session is gone. */
async function fetchHistoryPage(id: string): Promise<EventPage | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as EventPage;
}

/**
 * Change the URL without a server round trip. Next syncs `usePathname` with the native history
 * API, and the session routes render nothing of their own, so a router navigation (which fetches
 * the route's payload first) would only delay the switch.
 */
const pushPath = (path: string) => window.history.pushState(null, "", path);
const replacePath = (path: string) =>
  window.history.replaceState(null, "", path);

export default function Chat() {
  const pathname = usePathname();
  /** The open session comes from the URL, so refresh, back, and shared links all land on it. */
  const active = useMemo(() => sessionIdFromPath(pathname ?? "/"), [pathname]);
  /** The standalone terminal page: no session, no start page. */
  const terminalOpen = isTerminalPath(pathname ?? "/");
  /** Talk to Portal: the orchestrator's thread, outside every project and session. */
  const portalOpen = isPortalPath(pathname ?? "/");
  const onStartPage = !active && !terminalOpen && !portalOpen;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** The current list, for stream handlers that must not close over a stale render. */
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const {
    projects,
    loading: projectsLoading,
    addProject,
    renameProject,
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
    projectPins,
    sessionPins,
    toggleProjectPin,
    toggleSessionPin,
    prune: prunePins,
  } = usePins();
  /** Pinned projects first (most recently pinned on top), then most recently worked in: the sidebar's and the start page's order. */
  const orderedProjects = useMemo(
    () => pinnedFirst(orderProjectsByActivity(projects, sessions), projectPins),
    [projects, sessions, projectPins],
  );
  /** The project picked this page load, or null to fall back to the remembered/newest one. */
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  /** The start page's worktree choice, tied to the project it was made for so a project change resets it. */
  const [worktreePick, setWorktreePick] = useState<{
    projectId: string;
    choice: WorktreeChoice;
  } | null>(null);
  /** Agent settings chosen on the start page, tied to the agent they were chosen for. */
  const [startConfig, setStartConfig] = useState<{
    agentId: string;
    state: SessionState;
  } | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** The section a `portal:open-settings` event asked for; null when the dialog was opened from its button. */
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(null);
  useOpenSettingsRequests((section) => {
    setSettingsSection(section);
    setShowSettings(true);
  });
  const [showShell, setShowShell] = useState(false);
  const [shellSize, setShellSize] = useState(33);
  const [showSidebar, setShowSidebar] = useState(false);
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
  const [initialSend, setInitialSend] = useState<{
    sessionId: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const creatingRef = useRef(false);
  /** Reduced transcripts of visited (and hovered) sessions, for instant switches. */
  const [historyCache] = useState(() => createHistoryCache(fetchHistoryPage));

  /** Refetch the whole list; used when the live feed names a session this page does not know. Resolves with the list. */
  const refetchSessions = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch("/api/sessions", { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { sessions: fetched } = (await r.json()) as {
      sessions: SessionSummary[];
    };
    if (!signal?.aborted) setSessions(fetched);
    return fetched;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [agentsResponse, sessionsResponse] = await Promise.all([
          fetch("/api/agents", { signal: controller.signal }),
          fetch("/api/sessions", { signal: controller.signal }),
        ]);
        if (!agentsResponse.ok || !sessionsResponse.ok) {
          throw new Error(
            "Could not load agents and sessions. Reload the page to retry.",
          );
        }
        const [registry, saved] = await Promise.all([
          agentsResponse.json() as Promise<{
            agents: AgentInfo[];
            defaultAgentId: string;
          }>,
          sessionsResponse.json() as Promise<{ sessions: SessionSummary[] }>,
        ]);
        if (controller.signal.aborted) return;
        setAgents(registry.agents);
        setSelectedAgentId(registry.defaultAgentId);
        setSessions(saved.sessions);
      } catch {
        if (!controller.signal.aborted) {
          setSessionError(
            "Could not load agents and sessions. Check the server and reload the page to retry.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  // Follow the list live once it has loaded: other sessions' busy, permission, connection, title,
  // and activity changes, plus sessions created or deleted from another browser. The open session's
  // own stream still patches its git state and agent state.
  useEffect(() => {
    if (loading || sessionError) return;
    const controller = new AbortController();
    const es = new EventSource("/api/sessions/stream");
    es.onmessage = (m) => {
      const event = JSON.parse(m.data) as SessionListEvent;
      switch (event.type) {
        case "snapshot": {
          const byId = new Map(event.sessions.map((s) => [s.id, s]));
          // The snapshot decides what exists; entries it lacks were deleted while we were not listening.
          setSessions((prev) =>
            prev
              .filter((s) => byId.has(s.id))
              .map((s) => ({ ...s, ...byId.get(s.id) })),
          );
          // A session created while we were not listening needs its full entry (folder, branch, project).
          const known = new Set(sessionsRef.current.map((s) => s.id));
          if (event.sessions.some((s) => !known.has(s.id)))
            refetchSessions(controller.signal).catch(() => {});
          return;
        }
        case "created":
          setSessions((prev) =>
            prev.some((s) => s.id === event.session.id)
              ? prev
              : [event.session, ...prev],
          );
          return;
        case "updated":
          setSessions((prev) =>
            prev.map((s) => (s.id === event.id ? { ...s, ...event.patch } : s)),
          );
          return;
        case "deleted":
          setSessions((prev) => prev.filter((s) => s.id !== event.id));
          historyCache.delete(event.id);
          writeDraft(event.id, "");
          return;
      }
    };
    return () => {
      controller.abort();
      es.close();
    };
  }, [loading, sessionError, refetchSessions, historyCache]);

  // Pins outlive their projects and sessions in storage; forget the ones for things that are gone.
  useEffect(() => {
    if (loading || sessionError || projectsLoading) return;
    prunePins(
      projects.map((p) => p.id),
      sessions.map((s) => s.id),
    );
  }, [loading, sessionError, projectsLoading, projects, sessions, prunePins]);

  // The project new sessions start in: the chosen one while it exists, else the remembered one, else the newest.
  // Projects only arrive after mount, so this stays "" during server rendering and hydration.
  const selectedProjectId = useMemo(() => {
    if (projectsLoading) return chosenProjectId ?? "";
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

  // The start page's agent settings: the user's picks this visit, else the agent's latest session
  // (its current option list and the values last chosen); null until the agent has had a session.
  const startSettings = useMemo(
    () =>
      startConfig?.agentId === selectedAgentId
        ? startConfig.state
        : latestStateForAgent(sessions, selectedAgentId),
    [startConfig, selectedAgentId, sessions],
  );
  const changeStartSetting = (request: SetConfigRequest) => {
    if (!startSettings) return;
    setStartConfig({
      agentId: selectedAgentId,
      state: applyConfigChange(startSettings, request),
    });
  };

  /**
   * Move a new session's settings to the ones chosen on the start page, one request at a time
   * since a model switch can change the choices of later options. Resolves with the final state.
   */
  const applyStartSettings = async (
    sessionId: string,
    desired: SessionState,
    actual: SessionState,
  ) => {
    let state = actual;
    for (let step = 0; step < 16; step++) {
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

  /** Navigate to a session (or the start page); the URL drives the rest. */
  const selectSession = (sessionId: string | null) => {
    if (sessionId !== active || terminalOpen || portalOpen)
      pushPath(sessionId ? sessionPath(sessionId) : "/");
    // The session's project becomes the default for the next new session.
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId;
    if (projectId && projects.some((p) => p.id === projectId))
      selectProject(projectId);
    setShowSidebar(false);
  };

  const updateSession = useCallback(
    (id: string, patch: Partial<SessionSummary>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  const initialSendHandled = useCallback((id: string) => {
    setInitialSend((previous) =>
      previous?.sessionId === id && !previous.pending ? null : previous,
    );
  }, []);

  /** Another viewer deleted the open session, or the server dropped it: leave it. */
  const sessionDeleted = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    replacePath("/");
  }, []);

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
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    historyCache.delete(sessionId);
    writeDraft(sessionId, "");
    if (sessionId === active) replacePath("/");
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
    pushPath(newest ? sessionPath(newest.id) : "/");
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

  /** The sidebar's `+`: open the start page with `projectId` selected so the worktree picker is available. */
  const startIn = (projectId: string) => {
    selectProject(projectId);
    if (!onStartPage) pushPath("/");
    setShowSidebar(false);
  };

  /** The sidebar's Terminal button: open the standalone terminal page. */
  const openTerminal = () => {
    if (!terminalOpen) pushPath(terminalPath());
    setShowSidebar(false);
  };

  /** The sidebar's Talk to Portal button: open the orchestrator's page. */
  const openPortal = () => {
    if (!portalOpen) pushPath(portalPath());
    setShowSidebar(false);
  };

  /** The sidebar toggle shared by the pages without a session header of their own. */
  const toggleSidebar = () => {
    if (desktop)
      setSidebarPreference(sidebarPreference === "true" ? "false" : "true");
    else setShowSidebar(true);
  };

  /** Start a session in `projectId`, first turning a non-Original `choice` into its worktree project. */
  const newSession = async (
    projectId: string = selectedProjectId,
    choice: WorktreeChoice = ORIGINAL,
    firstPrompt = "",
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
    setCreating(true);
    setSessionError(null);
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
        body: JSON.stringify({ projectId, agentId: selectedAgentId }),
      });
      const session = (await r.json()) as SessionSummary & { error?: string };
      if (!r.ok || !session.id) {
        setSessionError(
          session.error ??
            "Could not create a session. Check the server and try again.",
        );
        return;
      }
      // The worktree choice was for this start only; the next start page begins at Original again.
      setWorktreePick(null);
      setSessions((prev) => [
        session,
        ...prev.filter((item) => item.id !== session.id),
      ]);
      if (firstPrompt.trim()) {
        writeDraft(session.id, firstPrompt);
        clearSubmittedDraft("new", firstPrompt);
        setInitialSend({ sessionId: session.id, pending: true, error: null });
      }
      pushPath(sessionPath(session.id));
      setShowSidebar(false);
      if (desiredSettings) {
        // The next start page seeds from this session, which now carries these choices.
        setStartConfig(null);
        try {
          const state = await applyStartSettings(
            session.id,
            desiredSettings,
            session.state,
          );
          updateSession(session.id, { state });
        } catch (error) {
          setInitialSend({
            sessionId: session.id,
            pending: false,
            error: `${error instanceof Error ? error.message : "Could not apply the agent settings."} Check Agent settings, then send your message.`,
          });
          return;
        }
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
      setCreating(false);
    }
  };

  // The GitHub panel follows the open session's project, else the project new sessions start in.
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
   * the user picks the agent and model and sends. Nothing is created until they do.
   */
  const startGitAction = (kind: GitActionKind, summary: GithubSummary) => {
    if (!githubProjectId) return;
    const promptText = (settings ?? defaultSettings).gitActions.prompts[kind];
    const text = buildGitActionPrompt(kind, summary, promptText);
    selectProject(githubProjectId);
    // The start page begins at Original again; the draft replaces whatever was there.
    setWorktreePick(null);
    writeDraft("new", text);
    if (!onStartPage) pushPath("/");
    setShowSidebar(false);
  };
  return (
    <div className="portal-shell">
      <Sidebar
        projects={orderedProjects}
        sessions={sessions}
        projectPins={projectPins}
        sessionPins={sessionPins}
        onTogglePinProject={toggleProjectPin}
        onTogglePinSession={toggleSessionPin}
        active={active}
        onSelect={(id) => selectSession(id)}
        onPrefetch={(id) => historyCache.prefetch(id)}
        onDeleteSession={deleteSession}
        onNewSession={startIn}
        onAddProject={() => setShowAddProject(true)}
        onOpenSettings={() => setShowSettings(true)}
        onRenameProject={async (id, name) => {
          await renameProject(id, name);
        }}
        onRemoveProject={removeProjectFromWorkspace}
        removedProjects={removedProjects}
        removedError={removedError}
        onRefreshRemoved={refreshRemoved}
        onRestoreProject={restoreProject}
        onDiscardRemoved={discardRemovedProject}
        open={showSidebar}
        onClose={() => setShowSidebar(false)}
        onHome={() => selectSession(null)}
        onTerminal={openTerminal}
        terminalActive={terminalOpen}
        onPortal={openPortal}
        portalActive={portalOpen}
        desktopOpen={sidebarPreference === "true"}
        onCollapse={() => setSidebarPreference("false")}
      />
      <AddProjectDialog
        open={showAddProject}
        onClose={() => setShowAddProject(false)}
        onAdd={async (input) => {
          const project = await addProject(input);
          selectProject(project.id);
        }}
      />
      <SettingsDialog
        open={showSettings}
        section={settingsSection}
        onClose={() => {
          setShowSettings(false);
          setSettingsSection(null);
        }}
      />
      {portalOpen ? (
        <PortalPage
          onOpenSidebar={toggleSidebar}
          onOpenSession={selectSession}
        />
      ) : terminalOpen ? (
        <TerminalPage onOpenSidebar={toggleSidebar} />
      ) : (
      /* Keyed by session so switching remounts the pane with fresh history; terminals keep running server-side. */
      <SessionPane
        key={active ?? ""}
        sessionId={active}
        session={activeSession}
        start={{
          projects: orderedProjects,
          selectedProjectId,
          onSelectProject: selectProject,
          onAddProject: () => setShowAddProject(true),
          worktree: worktreeChoice,
          onWorktreeChange: (choice) =>
            setWorktreePick({ projectId: selectedProjectId, choice }),
          agents,
          selectedAgentId,
          onSelectAgent: setSelectedAgentId,
          settings: startSettings,
          onSettingsChange: changeStartSetting,
          loading: loading || projectsLoading,
          canCreate,
          creating,
          error: sessionError,
          onCreate: (text) =>
            void newSession(selectedProjectId, worktreeChoice, text),
        }}
        onOpenSidebar={() => {
          if (desktop)
            setSidebarPreference(
              sidebarPreference === "true" ? "false" : "true",
            );
          else setShowSidebar(true);
        }}
        showGithub={showGithub}
        onToggleGithub={() =>
          setGithubPreference(showGithub ? "false" : "true")
        }
        initialSend={initialSend}
        onInitialSendHandled={initialSendHandled}
        onBack={() => selectSession(null)}
        onSessionUpdate={updateSession}
        onSessionDeleted={sessionDeleted}
        historyCache={historyCache}
        showShell={showShell}
        onShowShell={setShowShell}
        shellSize={shellSize}
        onShellSize={setShellSize}
      />
      )}
      {showGithub && !terminalOpen && !portalOpen && (
        <GithubInspector
          open={showGithub}
          onClose={() => setGithubPreference("false")}
          projectId={githubProjectId}
          projectRemoved={githubProjectRemoved}
          session={activeSession}
          onGitAction={startGitAction}
        />
      )}
    </div>
  );
}
