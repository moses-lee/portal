"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import ContextBar from "./ContextBar";
import Sidebar from "./Sidebar";
import SessionPane from "./SessionPane";
import AddProjectDialog from "./AddProjectDialog";
import { usePins } from "./usePins";
import { useProjects } from "./useProjects";
import type { WorktreeChoice } from "./WorktreePicker";
import { ORIGINAL, worktreeTarget } from "@/lib/branch-matching";
import { pinnedFirst } from "@/lib/pins";
import { sessionIdFromPath, sessionPath } from "@/lib/session-routes";
import type { AgentInfo, ProjectSummary, SessionListEvent, SessionSummary } from "@/lib/types";

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
export default function Chat() {
  const router = useRouter();
  const pathname = usePathname();
  /** The open session comes from the URL, so refresh, back, and shared links all land on it. */
  const active = useMemo(() => sessionIdFromPath(pathname ?? "/"), [pathname]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** The current list, for stream handlers that must not close over a stale render. */
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const { projects, loading: projectsLoading, addProject, renameProject, removeProject, refresh: refreshProjects } = useProjects();
  const { projectPins, sessionPins, toggleProjectPin, toggleSessionPin, prune: prunePins } = usePins();
  /** Pinned projects first (most recently pinned on top), then creation order: the sidebar's and the start page's order. */
  const orderedProjects = useMemo(() => pinnedFirst(projects, projectPins), [projects, projectPins]);
  /** The project picked this page load, or null to fall back to the remembered/newest one. */
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  /** The start page's worktree choice, tied to the project it was made for so a project change resets it. */
  const [worktreePick, setWorktreePick] = useState<{ projectId: string; choice: WorktreeChoice } | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showShell, setShowShell] = useState(false);
  const [shellSize, setShellSize] = useState(33);
  const [showSidebar, setShowSidebar] = useState(false);

  /** Refetch the whole list; used when the live feed names a session this page does not know. */
  const refetchSessions = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch("/api/sessions", { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { sessions: fetched } = (await r.json()) as { sessions: SessionSummary[] };
    if (!signal?.aborted) setSessions(fetched);
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
          throw new Error("Could not load agents and sessions. Reload the page to retry.");
        }
        const [registry, saved] = await Promise.all([
          agentsResponse.json() as Promise<{ agents: AgentInfo[]; defaultAgentId: string }>,
          sessionsResponse.json() as Promise<{ sessions: SessionSummary[] }>,
        ]);
        if (controller.signal.aborted) return;
        setAgents(registry.agents);
        setSelectedAgentId(registry.defaultAgentId);
        setSessions(saved.sessions);
      } catch {
        if (!controller.signal.aborted) {
          setSessionError("Could not load agents and sessions. Check the server and reload the page to retry.");
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
          setSessions((prev) => prev.filter((s) => byId.has(s.id)).map((s) => ({ ...s, ...byId.get(s.id) })));
          // A session created while we were not listening needs its full entry (folder, branch, project).
          const known = new Set(sessionsRef.current.map((s) => s.id));
          if (event.sessions.some((s) => !known.has(s.id))) refetchSessions(controller.signal).catch(() => {});
          return;
        }
        case "created":
          setSessions((prev) => (prev.some((s) => s.id === event.session.id) ? prev : [event.session, ...prev]));
          return;
        case "updated":
          setSessions((prev) => prev.map((s) => (s.id === event.id ? { ...s, ...event.patch } : s)));
          return;
        case "deleted":
          setSessions((prev) => prev.filter((s) => s.id !== event.id));
          return;
      }
    };
    return () => {
      controller.abort();
      es.close();
    };
  }, [loading, sessionError, refetchSessions]);

  // Pins outlive their projects and sessions in storage; forget the ones for things that are gone.
  useEffect(() => {
    if (loading || sessionError || projectsLoading) return;
    prunePins(projects.map((p) => p.id), sessions.map((s) => s.id));
  }, [loading, sessionError, projectsLoading, projects, sessions, prunePins]);

  // The project new sessions start in: the chosen one while it exists, else the remembered one, else the newest.
  // Projects only arrive after mount, so this stays "" during server rendering and hydration.
  const selectedProjectId = useMemo(() => {
    if (projectsLoading) return chosenProjectId ?? "";
    if (chosenProjectId && projects.some((p) => p.id === chosenProjectId)) return chosenProjectId;
    const stored = readStoredProjectId();
    if (stored && projects.some((p) => p.id === stored)) return stored;
    return projects.at(-1)?.id ?? "";
  }, [chosenProjectId, projects, projectsLoading]);

  const selectProject = (projectId: string) => {
    setChosenProjectId(projectId);
    if (projectId) storeProjectId(projectId);
  };

  const worktreeChoice = worktreePick?.projectId === selectedProjectId ? worktreePick.choice : ORIGINAL;

  /** Navigate to a session (or the start page); the URL drives the rest. */
  const selectSession = (sessionId: string | null) => {
    if (sessionId !== active) router.push(sessionId ? sessionPath(sessionId) : "/");
    // The session's project becomes the default for the next new session.
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId;
    if (projectId && projects.some((p) => p.id === projectId)) selectProject(projectId);
    setShowSidebar(false);
  };

  const updateSession = useCallback((id: string, patch: Partial<SessionSummary>) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  /** Another viewer deleted the open session, or the server dropped it: leave it. */
  const sessionDeleted = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    router.replace("/");
  }, [router]);

  /** `DELETE /api/sessions/[id]`; leaves the session if it is open. Rejects with the server's message. */
  const deleteSession = async (sessionId: string) => {
    let r: Response;
    try {
      r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch {
      throw new Error("Could not reach the server. Check the connection and try again.");
    }
    if (!r.ok && r.status !== 404) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? "Could not delete the session. Try again.");
    }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (sessionId === active) router.replace("/");
  };

  const canCreate = !loading && !projectsLoading && !creating && !!selectedAgentId && !!selectedProjectId;

  /** Create (or reuse) the worktree project for `choice` under `projectId`; rejects with the server's message. */
  const ensureWorktreeProject = async (projectId: string, choice: Exclude<WorktreeChoice, { kind: "original" }>) => {
    let r: Response;
    try {
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: choice.branch, create: choice.kind === "create" }),
      });
    } catch {
      throw new Error("Could not prepare the worktree. Check the server connection and try again.");
    }
    const j = (await r.json().catch(() => ({}))) as { project?: ProjectSummary; error?: string };
    if (!r.ok || !j.project) throw new Error(j.error ?? "Could not prepare the worktree. Try again.");
    return j.project;
  };

  /** The sidebar's `+`: open the start page with `projectId` selected so the worktree picker is available. */
  const startIn = (projectId: string) => {
    selectProject(projectId);
    if (active) router.push("/");
    setShowSidebar(false);
  };

  /** Start a session in `projectId`, first turning a non-Original `choice` into its worktree project. */
  const newSession = async (projectId: string = selectedProjectId, choice: WorktreeChoice = ORIGINAL) => {
    if (creating || loading || projectsLoading || !selectedAgentId || !projectId) return;
    setCreating(true);
    setSessionError(null);
    if (projectId !== selectedProjectId) selectProject(projectId);
    try {
      if (choice.kind !== "original") {
        let worktreeProject: ProjectSummary;
        try {
          worktreeProject = await ensureWorktreeProject(projectId, choice);
        } catch (e) {
          setSessionError(e instanceof Error ? e.message : "Could not prepare the worktree. Try again.");
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
        setSessionError(session.error ?? "Could not create a session. Check the server and try again.");
        return;
      }
      // The worktree choice was for this start only; the next start page begins at Original again.
      setWorktreePick(null);
      setSessions((prev) => [session, ...prev]);
      router.push(sessionPath(session.id));
      setShowSidebar(false);
    } catch {
      setSessionError("Could not create a session. Check the server connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  // The GitHub panel follows the open session's project, else the project new sessions start in.
  // Nothing until the session list has loaded, so it does not fetch the start page's project and then switch.
  const activeSession = sessions.find((s) => s.id === active);
  const githubProjectId = active
    ? (!loading && activeSession && projects.some((p) => p.id === activeSession.projectId) ? activeSession.projectId : null)
    : selectedProjectId || null;
  const githubProjectRemoved = !!active && !!activeSession && activeSession.projectId !== "" && !githubProjectId;
  // Where the start page's next session runs when a worktree is chosen (git projects only).
  const startTarget = selectedProject ? worktreeTarget(selectedProject, worktreeChoice) : null;
  const startContext = startTarget && selectedProject?.git ? (
    <ContextBar
      cwd={startTarget.displayPath}
      displayCwd={startTarget.displayPath}
      git={{ ...selectedProject.git, branch: startTarget.branch, detached: false }}
      label={selectedProject.name}
      note={worktreeChoice.kind === "create" ? "new sessions start in a new worktree" : "new sessions start in this worktree"}
    />
  ) : (
    <ContextBar
      cwd={selectedProject?.path}
      displayCwd={selectedProject?.displayPath}
      git={selectedProject?.git ?? null}
      label={selectedProject?.name}
      note={selectedProject ? "new sessions start here" : undefined}
    />
  );

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100">
      <Sidebar
        projects={orderedProjects}
        sessions={sessions}
        projectPins={projectPins}
        sessionPins={sessionPins}
        onTogglePinProject={toggleProjectPin}
        onTogglePinSession={toggleSessionPin}
        active={active}
        onSelect={(id) => selectSession(id)}
        onDeleteSession={deleteSession}
        onNewSession={startIn}
        onAddProject={() => setShowAddProject(true)}
        onRenameProject={async (id, name) => { await renameProject(id, name); }}
        onRemoveProject={removeProject}
        open={showSidebar}
        onClose={() => setShowSidebar(false)}
        githubProjectId={githubProjectId}
        githubProjectRemoved={githubProjectRemoved}
        activeSession={activeSession}
      />
      <AddProjectDialog
        open={showAddProject}
        onClose={() => setShowAddProject(false)}
        onAdd={async (input) => {
          const project = await addProject(input);
          selectProject(project.id);
        }}
      />
      {/* Keyed by session so switching remounts the pane with fresh history; terminals keep running server-side. */}
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
          onWorktreeChange: (choice) => setWorktreePick({ projectId: selectedProjectId, choice }),
          agents,
          selectedAgentId,
          onSelectAgent: setSelectedAgentId,
          loading: loading || projectsLoading,
          canCreate,
          creating,
          error: sessionError,
          onCreate: () => void newSession(selectedProjectId, worktreeChoice),
        }}
        startContext={startContext}
        onOpenSidebar={() => setShowSidebar(true)}
        onBack={() => selectSession(null)}
        onSessionUpdate={updateSession}
        onSessionDeleted={sessionDeleted}
        showShell={showShell}
        onShowShell={setShowShell}
        shellSize={shellSize}
        onShellSize={setShellSize}
      />
    </div>
  );
}
