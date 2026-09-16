"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Group, Panel, Separator } from "react-resizable-panels";
import ReactMarkdown from "react-markdown";
import PermissionCard, { type PermissionBlock } from "./PermissionCard";
import SessionControls, { applyConfigChange } from "./SessionControls";
import CommandPalette, { commandInsertText, findCommandToken, matchCommands } from "./CommandPalette";
import ContextBar from "./ContextBar";
import Sidebar from "./Sidebar";
import StartPage from "./StartPage";
import AddProjectDialog from "./AddProjectDialog";
import { useProjects } from "./useProjects";
import type { AgentInfo, PortalEvent, SessionMetaEvent, SessionState, SessionSummary, SetConfigRequest } from "@/lib/types";
import type { AvailableCommand, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";

const TerminalPanel = dynamic(() => import("./TerminalPanel"), {
  ssr: false,
  loading: () => <p className="p-3 text-xs text-zinc-500">Loading terminal…</p>,
});

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

type ToolBlock = {
  kind: "tool";
  id: string;
  title: string;
  toolKind?: string | null;
  status?: string | null;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
};
type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | ToolBlock
  | { kind: "plan"; entries: { content: string; status: string }[] }
  | PermissionBlock
  | { kind: "turn_end"; stopReason: string }
  | { kind: "error"; message: string };

function reduce(events: PortalEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  const permissions = new Map<string, PermissionBlock>();
  const last = () => blocks[blocks.length - 1];
  const appendText = (kind: "assistant" | "thought", text: string) => {
    const l = last();
    if (l && l.kind === kind) l.text += text;
    else blocks.push({ kind, text });
  };
  for (const ev of events) {
    switch (ev.type) {
      case "user":
        blocks.push({ kind: "user", text: ev.text });
        break;
      case "turn_end":
        blocks.push({ kind: "turn_end", stopReason: ev.stopReason });
        break;
      case "error":
        blocks.push({ kind: "error", message: ev.message });
        break;
      case "permission_request": {
        const b: PermissionBlock = { kind: "permission", requestId: ev.requestId, toolCall: ev.toolCall, options: ev.options, response: null };
        permissions.set(ev.requestId, b);
        blocks.push(b);
        break;
      }
      case "permission_response": {
        const b = permissions.get(ev.requestId);
        if (!b) break;
        b.response = ev.outcome === "selected"
          ? { outcome: "selected", optionId: ev.optionId, optionName: ev.optionName }
          : { outcome: "cancelled" };
        break;
      }
      case "turn_start":
        break;
      case "update": {
        const u: SessionUpdate = ev.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") appendText("assistant", u.content.text);
            break;
          case "agent_thought_chunk":
            if (u.content.type === "text") appendText("thought", u.content.text);
            break;
          case "tool_call": {
            const b: ToolBlock = {
              kind: "tool",
              id: u.toolCallId,
              title: u.title,
              toolKind: u.kind,
              status: u.status ?? "pending",
              content: u.content ?? [],
              rawInput: u.rawInput,
              rawOutput: u.rawOutput,
            };
            tools.set(b.id, b);
            blocks.push(b);
            break;
          }
          case "tool_call_update": {
            const b = tools.get(u.toolCallId);
            if (!b) break;
            if (u.title) b.title = u.title;
            if (u.kind) b.toolKind = u.kind;
            if (u.status) b.status = u.status;
            if (u.content) b.content = u.content;
            if (u.rawInput !== undefined) b.rawInput = u.rawInput;
            if (u.rawOutput !== undefined) b.rawOutput = u.rawOutput;
            break;
          }
          case "plan":
          case "plan_update": {
            const entries = (u as { entries?: { content: string; status: string }[] }).entries ?? [];
            const l = last();
            if (l && l.kind === "plan") l.entries = entries;
            else blocks.push({ kind: "plan", entries });
            break;
          }
          default:
            break;
        }
      }
    }
  }
  return blocks;
}

const statusIcon: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✕",
};

function ToolCard({ b }: { b: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const diffs = b.content.filter((c) => c.type === "diff");
  const texts = b.content.filter((c) => c.type === "content");
  return (
    <div className="my-1 rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs text-zinc-300"
      >
        <span className={b.status === "failed" ? "text-red-400" : b.status === "completed" ? "text-emerald-400" : "text-amber-400"}>
          {statusIcon[b.status ?? "pending"] ?? "○"}
        </span>
        <span className="text-zinc-500">{b.toolKind ?? "tool"}</span>
        <span className="truncate">{b.title}</span>
        <span className="ml-auto text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2">
          {b.rawInput !== undefined && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-[11px] text-zinc-400">
              {typeof b.rawInput === "string" ? b.rawInput : JSON.stringify(b.rawInput, null, 2)}
            </pre>
          )}
          {diffs.map((d, i) => (
            <div key={i} className="rounded bg-black/40 p-2 font-mono text-[11px]">
              <div className="mb-1 text-zinc-500">{(d as { path: string }).path}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-red-400/80">{(d as { oldText?: string | null }).oldText ?? ""}</pre>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-emerald-400/80">{(d as { newText: string }).newText}</pre>
            </div>
          ))}
          {texts.map((t, i) => {
            const c = (t as { content: { type: string; text?: string } }).content;
            return c.type === "text" ? (
              <pre key={i} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-[11px] text-zinc-300">
                {c.text}
              </pre>
            ) : null;
          })}
          {b.rawOutput !== undefined && texts.length === 0 && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-2 text-[11px] text-zinc-300">
              {typeof b.rawOutput === "string" ? b.rawOutput : JSON.stringify(b.rawOutput, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function BlockView({ b, onAnswerPermission }: {
  b: Block;
  onAnswerPermission: (requestId: string, optionId: string) => Promise<void>;
}) {
  const [showThought, setShowThought] = useState(false);
  switch (b.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2 text-sm text-white">
            {b.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="prose prose-invert prose-sm max-w-none prose-pre:bg-black/40 prose-pre:text-xs">
          <ReactMarkdown>{b.text}</ReactMarkdown>
        </div>
      );
    case "thought":
      return (
        <div className="text-xs text-zinc-500">
          <button onClick={() => setShowThought((s) => !s)} className="italic">
            {showThought ? "▾ thinking" : "▸ thinking…"}
          </button>
          {showThought && <div className="mt-1 whitespace-pre-wrap border-l border-zinc-800 pl-2">{b.text}</div>}
        </div>
      );
    case "tool":
      return <ToolCard b={b} />;
    case "plan":
      return (
        <div className="my-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
          <div className="mb-1 text-zinc-500">plan</div>
          {b.entries.map((e, i) => (
            <div key={i} className="flex gap-2">
              <span className={e.status === "completed" ? "text-emerald-400" : e.status === "in_progress" ? "text-amber-400" : "text-zinc-600"}>
                {statusIcon[e.status] ?? "○"}
              </span>
              <span className={e.status === "completed" ? "text-zinc-500 line-through" : "text-zinc-300"}>{e.content}</span>
            </div>
          ))}
        </div>
      );
    case "permission":
      return <PermissionCard b={b} onAnswer={onAnswerPermission} />;
    case "turn_end":
      return b.stopReason === "end_turn" ? null : (
        <div className="text-[11px] text-zinc-600">turn ended: {b.stopReason}</div>
      );
    case "error":
      return <div className="rounded bg-red-950/50 px-3 py-2 text-sm text-red-300">{b.message}</div>;
  }
}

export default function Chat() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const { projects, loading: projectsLoading, addProject, renameProject, removeProject } = useProjects();
  /** The project picked this page load, or null to fall back to the remembered/newest one. */
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showShell, setShowShell] = useState(false);
  const [shellSize, setShellSize] = useState(33);
  const shellButton = useRef<HTMLButtonElement>(null);
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [configInFlight, setConfigInFlight] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [paletteClosed, setPaletteClosed] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showSidebar, setShowSidebar] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const pendingPromptsRef = useRef(new Set<string>());
  const creatingRef = useRef(false);

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

  // Subscribe to the active session's event stream.
  useEffect(() => {
    esRef.current?.close();
    if (!active) return;
    const es = new EventSource(`/api/sessions/${active}/events`);
    esRef.current = es;
    es.onmessage = (m) => {
      if (esRef.current !== es || activeSessionRef.current !== active) return;
      const ev = JSON.parse(m.data) as PortalEvent;
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "turn_start" || ev.type === "turn_end" || ev.type === "error") {
        pendingPromptsRef.current.delete(active);
      }
      if (ev.type === "turn_start") setBusy(true);
      if (ev.type === "turn_end" || ev.type === "error") setBusy(false);
    };
    es.addEventListener("meta", (m) => {
      if (esRef.current !== es || activeSessionRef.current !== active) return;
      const meta = JSON.parse((m as MessageEvent).data) as Partial<SessionMetaEvent>;
      if (meta.busy !== undefined) setBusy(meta.busy);
      // Agent state (modes, config options, commands) changes from any viewer; the stream is the source of truth.
      if (meta.state) setSessionState(meta.state);
      // The stream tracks the session directory's branch, project, and existence live; keep the list in step.
      if (meta.git !== undefined || meta.state || meta.project !== undefined || meta.cwdMissing !== undefined) {
        setSessions((prev) => prev.map((s) => (s.id === active
          ? {
            ...s,
            git: meta.git === undefined ? s.git : meta.git,
            state: meta.state ?? s.state,
            project: meta.project === undefined ? s.project : meta.project,
            cwdMissing: meta.cwdMissing ?? s.cwdMissing,
          }
          : s)));
      }
    });
    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [active]);

  const blocks = useMemo(() => reduce(events), [events]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [blocks.length, events.length]);

  /** Switch sessions; `seed` is the session's last known state (defaults to the list entry's) until the stream's meta arrives. */
  const selectSession = (sessionId: string | null, seed?: SessionState | null) => {
    if (sessionId !== activeSessionRef.current) {
      activeSessionRef.current = sessionId;
      esRef.current?.close();
      setEvents([]);
      setBusy(false);
      setSessionState(seed ?? sessions.find((s) => s.id === sessionId)?.state ?? null);
      setConfigInFlight(false);
      setConfigError(null);
      setPaletteClosed(false);
      setPaletteIndex(0);
      setActive(sessionId);
    }
    // The session's project becomes the default for the next new session.
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId;
    if (projectId && projects.some((p) => p.id === projectId)) selectProject(projectId);
    setShowSidebar(false);
  };

  const canCreate = !loading && !projectsLoading && !creating && !!selectedAgentId && !!selectedProjectId;

  const newSession = async (projectId: string = selectedProjectId) => {
    if (creatingRef.current || loading || projectsLoading || !selectedAgentId || !projectId) return;
    creatingRef.current = true;
    setCreating(true);
    setSessionError(null);
    if (projectId !== selectedProjectId) selectProject(projectId);
    try {
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
      setSessions((prev) => [session, ...prev]);
      selectSession(session.id, session.state ?? null);
    } catch {
      setSessionError("Could not create a session. Check the server connection and try again.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const showRequestError = (sessionId: string, message: string) => {
    if (activeSessionRef.current !== sessionId) return;
    setEvents((prev) => [...prev, { type: "error", message }]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !active || busy || pendingPromptsRef.current.has(active)) return;
    const sessionId = active;
    pendingPromptsRef.current.add(sessionId);
    setInput("");
    try {
      const r = await fetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        pendingPromptsRef.current.delete(sessionId);
        const j = (await r.json()) as { error?: string };
        showRequestError(sessionId, j.error ?? "Could not send the message. Try again.");
      }
    } catch {
      pendingPromptsRef.current.delete(sessionId);
      showRequestError(sessionId, "Could not send the message. Check the server connection and try again.");
    }
  };

  const stop = async () => {
    if (!active) return;
    const sessionId = active;
    try {
      const r = await fetch(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        showRequestError(sessionId, j.error ?? "Could not stop the agent. Try Stop again.");
      }
    } catch {
      showRequestError(sessionId, "Could not stop the agent. Check the server connection and try Stop again.");
    }
  };

  /** Change a config option or mode: apply locally first, then adopt the agent's confirmed state or revert. */
  const setConfig = async (request: SetConfigRequest) => {
    if (!active || !sessionState || configInFlight) return;
    const sessionId = active;
    const previous = sessionState;
    setConfigError(null);
    setConfigInFlight(true);
    setSessionState(applyConfigChange(previous, request));
    const revert = (message: string) => {
      if (activeSessionRef.current !== sessionId) return;
      setSessionState(previous);
      setConfigError(message);
    };
    try {
      const r = await fetch(`/api/sessions/${sessionId}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const j = (await r.json()) as { state?: SessionState; error?: string };
      if (!r.ok || !j.state) {
        revert(j.error ?? "Could not change the setting. Try again.");
        return;
      }
      if (activeSessionRef.current !== sessionId) return;
      const confirmed = j.state;
      setSessionState(confirmed);
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, state: confirmed } : s)));
    } catch {
      revert("Could not change the setting. Check the server connection and try again.");
    } finally {
      if (activeSessionRef.current === sessionId) setConfigInFlight(false);
    }
  };

  /** Answer a permission request; the card resolves when the matching `permission_response` arrives over SSE. */
  const answerPermission = async (requestId: string, optionId: string) => {
    if (!active) throw new Error("No active session.");
    let r: Response;
    try {
      r = await fetch(`/api/sessions/${active}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, optionId }),
      });
    } catch {
      throw new Error("Could not send the answer. Check the server connection and try again.");
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? "Could not send the answer. Try again.");
    }
  };

  const activeMeta = sessions.find((s) => s.id === active);
  const awaitingPermission = busy && blocks.some((b) => b.kind === "permission" && b.response === null);

  // Slash-command autocomplete: driven by the `/` or `$` token under the caret.
  const commands = active ? sessionState?.commands : undefined;
  const token = useMemo(() => (commands?.length ? findCommandToken(input, caret) : null), [commands, input, caret]);
  const matches = useMemo(() => (token && commands ? matchCommands(commands, token.query) : []), [commands, token]);
  const paletteOpen = token !== null && matches.length > 0 && !paletteClosed;
  const selectedMatch = matches.length ? Math.min(paletteIndex, matches.length - 1) : 0;

  const insertCommand = (command: AvailableCommand) => {
    if (!token) return;
    const text = commandInsertText(command, token.trigger) + " ";
    const caretAfter = token.start + text.length;
    pendingCaretRef.current = caretAfter;
    setInput(input.slice(0, token.start) + text + input.slice(token.end));
    setCaret(caretAfter);
    setPaletteIndex(0);
  };

  // Place the caret after an inserted command once the new text has rendered.
  useEffect(() => {
    const position = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (position === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(position, position);
  }, [input]);

  const hideShell = () => {
    setShowShell(false);
    shellButton.current?.focus();
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100">
      <Sidebar
        projects={projects}
        sessions={sessions}
        active={active}
        onSelect={(id) => selectSession(id)}
        onNewSession={(projectId) => void newSession(projectId)}
        onAddProject={() => setShowAddProject(true)}
        onRenameProject={async (id, name) => { await renameProject(id, name); }}
        onRemoveProject={removeProject}
        open={showSidebar}
        onClose={() => setShowSidebar(false)}
      />
      <AddProjectDialog
        open={showAddProject}
        onClose={() => setShowAddProject(false)}
        onAdd={async (input) => {
          const project = await addProject(input);
          selectProject(project.id);
        }}
      />

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <button aria-label="Open sessions sidebar" onClick={() => setShowSidebar(true)} className="rounded border border-zinc-800 px-2 py-1 md:hidden">
            ☰
          </button>
          <span className="truncate text-zinc-200">{activeMeta ? activeMeta.agentName : "New session"}</span>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {busy && <span className="animate-pulse text-amber-400">{awaitingPermission ? "waiting for permission…" : "working…"}</span>}
            {active && (
              <button onClick={() => selectSession(null)} className="rounded border border-zinc-700 px-3 py-1.5 hover:bg-zinc-800">+ New</button>
            )}
            <button
              ref={shellButton}
              id="terminal-toggle"
              aria-expanded={showShell && !!active}
              aria-controls="terminal-panel"
              disabled={!active}
              title={active ? "Terminals for this session" : "Open a session to use its terminals"}
              onClick={() => setShowShell((open) => !open)}
              className={`rounded border px-3 py-1.5 disabled:opacity-40 ${showShell && active ? "border-indigo-500 bg-indigo-950 text-indigo-200" : "border-zinc-700 hover:bg-zinc-800"}`}
            >
              Terminal
            </button>
          </div>
        </header>

        <Group orientation="vertical" className="min-h-0 flex-1" onLayoutChanged={(layout) => { if (layout.shell) setShellSize(layout.shell); }}>
          <Panel id="chat" minSize="25%" className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 md:px-6">
              {!active && (
                <StartPage
                  projects={projects}
                  selectedProjectId={selectedProjectId}
                  onSelectProject={selectProject}
                  onAddProject={() => setShowAddProject(true)}
                  agents={agents}
                  selectedAgentId={selectedAgentId}
                  onSelectAgent={setSelectedAgentId}
                  loading={loading || projectsLoading}
                  canCreate={canCreate}
                  creating={creating}
                  error={sessionError}
                  onCreate={() => void newSession()}
                />
              )}
              {blocks.map((b, i) => (
                <BlockView key={i} b={b} onAnswerPermission={answerPermission} />
              ))}
              <div ref={bottomRef} />
            </div>

            <div className="relative shrink-0">
              {paletteOpen && token && (
                <CommandPalette
                  id="command-palette"
                  matches={matches}
                  trigger={token.trigger}
                  selected={selectedMatch}
                  onSelect={insertCommand}
                  onHighlight={setPaletteIndex}
                />
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
                className="flex items-end gap-2 border-t border-zinc-800 p-3 pb-2"
              >
                <textarea
                  ref={textareaRef}
                  aria-label={activeMeta ? `Message ${activeMeta.agentName}` : "Message"}
                  aria-describedby="session-context"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={paletteOpen}
                  aria-controls={paletteOpen ? "command-palette" : undefined}
                  aria-activedescendant={paletteOpen ? `command-palette-${selectedMatch}` : undefined}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    setCaret(e.target.selectionStart);
                    setPaletteClosed(false);
                    setPaletteIndex(0);
                  }}
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                  onBlur={() => setPaletteClosed(true)}
                  onKeyDown={(e) => {
                    if (paletteOpen) {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const step = e.key === "ArrowDown" ? 1 : matches.length - 1;
                        setPaletteIndex((selectedMatch + step) % matches.length);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        if (!e.nativeEvent.isComposing) insertCommand(matches[selectedMatch]);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setPaletteClosed(true);
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={activeMeta ? `Message ${activeMeta.agentName}…` : "Start a session above to chat"}
                  disabled={!active}
                  rows={2}
                  className="flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-50"
                />
                {busy ? (
                  <button type="button" onClick={stop} className="rounded-xl bg-red-700 px-4 py-2 text-sm font-medium hover:bg-red-600">
                    Stop
                  </button>
                ) : (
                  <button type="submit" disabled={!active || !input.trim()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40">
                    Send
                  </button>
                )}
              </form>
            </div>
            {active && sessionState && (
              <SessionControls state={sessionState} disabled={busy || configInFlight} error={configError} onChange={(request) => void setConfig(request)} />
            )}
            {activeMeta ? (
              <ContextBar
                cwd={activeMeta.cwd}
                displayCwd={activeMeta.displayCwd}
                git={activeMeta.git}
                note={activeMeta.cwdMissing ? "Working directory is missing" : undefined}
              />
            ) : (
              <ContextBar
                cwd={selectedProject?.path}
                displayCwd={selectedProject?.displayPath}
                git={selectedProject?.git ?? null}
                note={selectedProject ? "new sessions start here" : undefined}
              />
            )}
          </Panel>
          {showShell && active && <Separator aria-label="Resize terminal panel" className="h-1.5 shrink-0 bg-zinc-800 transition-colors hover:bg-indigo-500 focus-visible:bg-indigo-500 focus-visible:outline-none" />}
          {showShell && active && (
            <Panel id="shell" defaultSize={`${shellSize}%`} minSize="20%" maxSize="75%">
              {/* A session switch remounts the panel; its PTYs keep running server-side. */}
              <TerminalPanel key={active} sessionId={active} onHide={hideShell} />
            </Panel>
          )}
        </Group>
      </main>
    </div>
  );
}
