"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Group, Panel, Separator } from "react-resizable-panels";
import ReactMarkdown from "react-markdown";
import PermissionCard, { type PermissionBlock } from "./PermissionCard";
import SessionControls, { applyConfigChange } from "./SessionControls";
import CommandPalette, { commandInsertText, findCommandToken, matchCommands } from "./CommandPalette";
import ContextBar from "./ContextBar";
import StartPage, { type StartPageProps } from "./StartPage";
import type { EventPage, PortalEvent, SessionLink, SessionMetaEvent, SessionState, SessionSummary, SetConfigRequest, StoredEvent } from "@/lib/types";
import type { AvailableCommand, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";

const TerminalPanel = dynamic(() => import("./TerminalPanel"), {
  ssr: false,
  loading: () => <p className="p-3 text-xs text-zinc-500">Loading terminal…</p>,
});

/** Viewers this close to the bottom (px) follow new output; further up they keep their place. */
const STICK_THRESHOLD = 80;
/** Scrolling this close to the top (px) fetches the previous page. */
const LOAD_OLDER_THRESHOLD = 240;

const sessionUrl = (id: string, suffix = "") => `/api/sessions/${encodeURIComponent(id)}${suffix}`;

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

function reduce(events: StoredEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  const permissions = new Map<string, PermissionBlock>();
  const last = () => blocks[blocks.length - 1];
  // The server settles every open prompt before it ends a turn, so a request still unanswered when a
  // server-side turn_end or error arrives (a restart cut the turn off) can no longer be answered.
  const closeOpenPermissions = () => {
    for (const b of permissions.values()) if (b.response === null) b.response = { outcome: "cancelled" };
  };
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
        closeOpenPermissions();
        blocks.push({ kind: "turn_end", stopReason: ev.stopReason });
        break;
      case "error":
        // Client-only notices (negative seq) describe a failed request, not the end of the turn.
        if (ev.seq >= 0) closeOpenPermissions();
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

/** One turn of the transcript: a `user` event and everything the agent did in response. */
type Turn = { key: number; events: StoredEvent[]; blocks: Block[] };

/**
 * The loaded part of the log, reduced turn by turn. Pages start at turn boundaries and tool,
 * plan, and permission updates only ever refer to their own turn, so a live event re-reduces
 * only the last turn and an older page only adds turns in front.
 */
type History = { turns: Turn[]; hasMore: boolean };

function segment(events: StoredEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    const current = turns.at(-1);
    if (current && event.type !== "user") current.events.push(event);
    else turns.push({ key: event.seq, events: [event], blocks: [] });
  }
  for (const turn of turns) turn.blocks = reduce(turn.events);
  return turns;
}

function appendEvent({ turns, hasMore }: History, event: StoredEvent): History {
  const current = turns.at(-1);
  if (!current || event.type === "user") return { turns: [...turns, { key: event.seq, events: [event], blocks: reduce([event]) }], hasMore };
  const events = [...current.events, event];
  return { turns: [...turns.slice(0, -1), { ...current, events, blocks: reduce(events) }], hasMore };
}

const firstSeq = ({ turns }: History) => turns[0]?.events[0]?.seq;
const lastSeq = ({ turns }: History) => turns.at(-1)?.events.at(-1)?.seq;

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

export type SessionPaneProps = {
  /** The open session, or null for the start page. The parent keys this component by it. */
  sessionId: string | null;
  /** The session's list entry when known; seeds state until the stream's `meta` arrives. */
  session: SessionSummary | undefined;
  /** Props for the start page shown when no session is open. */
  start: StartPageProps;
  /** Context bar under the message box when no session is open. */
  startContext: ReactNode;
  onOpenSidebar: () => void;
  /** "+ New": back to the start page. */
  onBack: () => void;
  /** Live changes to the session's list entry (title, branch, connection, …). */
  onSessionUpdate: (id: string, patch: Partial<SessionSummary>) => void;
  /** The session was deleted (by this or another viewer). */
  onSessionDeleted: (id: string) => void;
  showShell: boolean;
  onShowShell: (open: boolean) => void;
  shellSize: number;
  onShellSize: (size: number) => void;
};

/** The main column: header, transcript, message box, controls, and terminals for one session. */
export default function SessionPane({
  sessionId, session, start, startContext, onOpenSidebar, onBack, onSessionUpdate, onSessionDeleted,
  showShell, onShowShell, shellSize, onShellSize,
}: SessionPaneProps) {
  const [history, setHistory] = useState<History>({ turns: [], hasMore: false });
  const [historyLoading, setHistoryLoading] = useState(!!sessionId);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [link, setLink] = useState<SessionLink | null>(session?.link ?? null);
  const [busy, setBusy] = useState(session?.busy ?? false);
  const [sessionState, setSessionState] = useState<SessionState | null>(session?.state ?? null);
  const [configInFlight, setConfigInFlight] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [paletteClosed, setPaletteClosed] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const shellButton = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Follow new output while the viewer is at the bottom. */
  const stickRef = useRef(true);
  /** Set before an older page is prepended so the layout effect can keep the viewport still. */
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  /** A prompt POST is in flight or its turn has not started yet. */
  const pendingPromptRef = useRef(false);
  /** Client-only notices (failed requests) get negative seqs so they never collide with the log. */
  const localSeqRef = useRef(-1);
  const loadingOlderRef = useRef(false);

  // Load the newest page, then follow the live tail. Opening the stream also asks the server to
  // reattach the agent when the session was persisted by an earlier run.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let es: EventSource | null = null;
    const applyMeta = (meta: Partial<SessionMetaEvent>) => {
      if (meta.busy !== undefined) setBusy(meta.busy);
      if (meta.link) setLink(meta.link);
      // Agent state (modes, config options, commands) changes from any viewer; the stream is the source of truth.
      if (meta.state) setSessionState(meta.state);
      const patch: Partial<SessionSummary> = {};
      if (meta.busy !== undefined) patch.busy = meta.busy;
      if (meta.link) patch.link = meta.link;
      if (meta.title !== undefined) patch.title = meta.title;
      if (meta.git !== undefined) patch.git = meta.git;
      if (meta.state) patch.state = meta.state;
      if (meta.project !== undefined) patch.project = meta.project;
      if (meta.cwdMissing !== undefined) patch.cwdMissing = meta.cwdMissing;
      onSessionUpdate(sessionId, patch);
    };
    const open = async () => {
      setHistoryLoading(true);
      try {
        const r = await fetch(sessionUrl(sessionId, "/events"), { signal: controller.signal });
        if (r.status === 404) {
          setNotFound(true);
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const page = (await r.json()) as EventPage;
        if (controller.signal.aborted) return;
        stickRef.current = true;
        setHistory({ turns: segment(page.events), hasMore: page.hasMore });
        // The page is authoritative: whatever prompt was in flight has either started or failed by now.
        pendingPromptRef.current = false;
        es?.close();
        const mine = new EventSource(sessionUrl(sessionId, `/stream?since=${page.nextSeq - 1}`));
        es = mine;
        mine.onmessage = (m) => {
          if (es !== mine) return;
          const ev = JSON.parse(m.data) as PortalEvent;
          const seq = Number(m.lastEventId);
          setHistory((prev) => {
            const last = lastSeq(prev);
            return last !== undefined && last >= seq ? prev : appendEvent(prev, { ...ev, seq, ts: Date.now() });
          });
          if (ev.type === "turn_start" || ev.type === "turn_end" || ev.type === "error") pendingPromptRef.current = false;
          if (ev.type === "turn_start") setBusy(true);
          if (ev.type === "turn_end" || ev.type === "error") setBusy(false);
        };
        mine.addEventListener("meta", (m) => {
          if (es === mine) applyMeta(JSON.parse((m as MessageEvent).data) as Partial<SessionMetaEvent>);
        });
        // The server no longer holds the events between our cursor and now: start over from a fresh page.
        mine.addEventListener("reset", () => {
          if (es === mine) void open();
        });
        mine.addEventListener("deleted", () => {
          if (es !== mine) return;
          mine.close();
          onSessionDeleted(sessionId);
        });
      } catch {
        if (!controller.signal.aborted) setHistoryError("Could not load the conversation. Check the server and reload the page to retry.");
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    };
    void open();
    return () => {
      controller.abort();
      es?.close();
      es = null;
    };
  }, [sessionId, onSessionUpdate, onSessionDeleted]);

  // Fetch the page before the oldest loaded event and prepend it without moving the viewport.
  const loadOlder = async () => {
    const before = firstSeq(history);
    if (!sessionId || !history.hasMore || loadingOlderRef.current || historyLoading || before === undefined || before <= 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const r = await fetch(sessionUrl(sessionId, `/events?before=${before}`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const page = (await r.json()) as EventPage;
      const container = scrollRef.current;
      setHistory((prev) => {
        // History was replaced (a `reset`) while this page was in flight: it no longer fits.
        if (firstSeq(prev) !== before) return prev;
        if (container) anchorRef.current = { height: container.scrollHeight, top: container.scrollTop };
        return { turns: [...segment(page.events), ...prev.turns], hasMore: page.hasMore };
      });
    } catch {
      setHistoryError("Could not load earlier messages. Scroll up to retry.");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  // Keep the viewport still when older events are prepended; otherwise follow the bottom while the viewer is there.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const anchor = anchorRef.current;
    if (anchor) {
      anchorRef.current = null;
      container.scrollTop = container.scrollHeight - anchor.height + anchor.top;
    } else if (stickRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [history]);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    stickRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < STICK_THRESHOLD;
    if (container.scrollTop < LOAD_OLDER_THRESHOLD) void loadOlder();
  };

  const showRequestError = (message: string) => {
    stickRef.current = true;
    setHistory((prev) => appendEvent(prev, { type: "error", message, seq: localSeqRef.current--, ts: Date.now() }));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !sessionId || busy || pendingPromptRef.current) return;
    pendingPromptRef.current = true;
    setInput("");
    try {
      const r = await fetch(sessionUrl(sessionId, "/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        pendingPromptRef.current = false;
        const j = (await r.json()) as { error?: string };
        showRequestError(j.error ?? "Could not send the message. Try again.");
      }
    } catch {
      pendingPromptRef.current = false;
      showRequestError("Could not send the message. Check the server connection and try again.");
    }
  };

  const stop = async () => {
    if (!sessionId) return;
    try {
      const r = await fetch(sessionUrl(sessionId, "/cancel"), { method: "POST" });
      if (!r.ok) {
        const j = (await r.json()) as { error?: string };
        showRequestError(j.error ?? "Could not stop the agent. Try Stop again.");
      }
    } catch {
      showRequestError("Could not stop the agent. Check the server connection and try Stop again.");
    }
  };

  /** Ask the server to reconnect the agent; the outcome arrives as `meta.link` on the stream. */
  const retryAttach = async () => {
    if (!sessionId) return;
    setLink({ status: "connecting" });
    try {
      const r = await fetch(sessionUrl(sessionId, "/attach"), { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setLink({ status: "offline", error: j.error ?? "Could not reconnect." });
      }
    } catch {
      setLink({ status: "offline", error: "Could not reach the server." });
    }
  };

  /** Change a config option or mode: apply locally first, then adopt the agent's confirmed state or revert. */
  const setConfig = async (request: SetConfigRequest) => {
    if (!sessionId || !sessionState || configInFlight) return;
    const previous = sessionState;
    setConfigError(null);
    setConfigInFlight(true);
    setSessionState(applyConfigChange(previous, request));
    const revert = (message: string) => {
      setSessionState(previous);
      setConfigError(message);
    };
    try {
      const r = await fetch(sessionUrl(sessionId, "/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const j = (await r.json()) as { state?: SessionState; error?: string };
      if (!r.ok || !j.state) {
        revert(j.error ?? "Could not change the setting. Try again.");
        return;
      }
      setSessionState(j.state);
      onSessionUpdate(sessionId, { state: j.state });
    } catch {
      revert("Could not change the setting. Check the server connection and try again.");
    } finally {
      setConfigInFlight(false);
    }
  };

  /** Answer a permission request; the card resolves when the matching `permission_response` arrives over SSE. */
  const answerPermission = async (requestId: string, optionId: string) => {
    if (!sessionId) throw new Error("No active session.");
    let r: Response;
    try {
      r = await fetch(sessionUrl(sessionId, "/permission"), {
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

  const lastTurn = history.turns.at(-1);
  const awaitingPermission = busy && !!lastTurn?.blocks.some((b) => b.kind === "permission" && b.response === null);
  const offline = link?.status === "offline";
  const agentName = session?.agentName ?? "the agent";

  // Slash-command autocomplete: driven by the `/` or `$` token under the caret.
  const commands = sessionId ? sessionState?.commands : undefined;
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
    onShowShell(false);
    shellButton.current?.focus();
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
        <button aria-label="Open sessions sidebar" onClick={onOpenSidebar} className="rounded border border-zinc-800 px-2 py-1 md:hidden">
          ☰
        </button>
        <span className="truncate text-zinc-200">{session ? session.title ?? session.agentName : sessionId ? "Session" : "New session"}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {busy && <span className="animate-pulse text-amber-400">{awaitingPermission ? "waiting for permission…" : "working…"}</span>}
          {sessionId && (
            <button onClick={onBack} className="rounded border border-zinc-700 px-3 py-1.5 hover:bg-zinc-800">+ New</button>
          )}
          <button
            ref={shellButton}
            id="terminal-toggle"
            aria-expanded={showShell && !!sessionId}
            aria-controls="terminal-panel"
            disabled={!sessionId}
            title={sessionId ? "Terminals for this session" : "Open a session to use its terminals"}
            onClick={() => onShowShell(!showShell)}
            className={`rounded border px-3 py-1.5 disabled:opacity-40 ${showShell && sessionId ? "border-indigo-500 bg-indigo-950 text-indigo-200" : "border-zinc-700 hover:bg-zinc-800"}`}
          >
            Terminal
          </button>
        </div>
      </header>

      <Group orientation="vertical" className="min-h-0 flex-1" onLayoutChanged={(layout) => { if (layout.shell) onShellSize(layout.shell); }}>
        <Panel id="chat" minSize="25%" className="flex min-h-0 flex-col">
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4 md:px-6">
            {!sessionId && <StartPage {...start} />}
            {sessionId && notFound && (
              <div className="mx-auto mt-16 max-w-md rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-6 text-center text-sm">
                <p className="text-zinc-200">This session no longer exists.</p>
                <p className="mt-1 text-xs text-zinc-500">It may have been deleted, or the link is from another Portal.</p>
                <button onClick={onBack} className="mt-4 rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">Back to start</button>
              </div>
            )}
            {sessionId && !notFound && (history.hasMore || loadingOlder || historyLoading) && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder || historyLoading}
                  className="rounded-full border border-zinc-800 px-3 py-1 text-[11px] text-zinc-400 hover:bg-zinc-900 disabled:opacity-60"
                >
                  {historyLoading ? "Loading conversation…" : loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                </button>
              </div>
            )}
            {historyError && <div role="alert" className="rounded bg-red-950/50 px-3 py-2 text-sm text-red-300">{historyError}</div>}
            {history.turns.map((turn) => turn.blocks.map((b, i) => (
              <BlockView key={`${turn.key}:${i}`} b={b} onAnswerPermission={answerPermission} />
            )))}
          </div>
          {sessionId && link && link.status !== "live" && (
            <div role="status" className={`flex flex-wrap items-center gap-2 border-t px-3 py-1.5 text-xs ${offline ? "border-amber-900/60 bg-amber-950/30 text-amber-200" : "border-zinc-800 bg-zinc-900/60 text-zinc-400"}`}>
              {link.status === "connecting" ? (
                <span className="animate-pulse">Connecting to {agentName}…</span>
              ) : (
                <>
                  <span className="min-w-0 flex-1 break-words">{link.error ?? `${agentName} is not connected to this session.`}</span>
                  <button type="button" onClick={() => void retryAttach()} className="rounded border border-amber-800 px-2 py-0.5 hover:bg-amber-900/40">Reconnect</button>
                </>
              )}
            </div>
          )}

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
                aria-label={session ? `Message ${session.agentName}` : "Message"}
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
                placeholder={session ? `Message ${session.agentName}…` : sessionId ? "Message…" : "Start a session above to chat"}
                disabled={!sessionId || notFound}
                rows={2}
                className="flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-50"
              />
              {busy ? (
                <button type="button" onClick={stop} className="rounded-xl bg-red-700 px-4 py-2 text-sm font-medium hover:bg-red-600">
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={!sessionId || notFound || !input.trim()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40">
                  Send
                </button>
              )}
            </form>
          </div>
          {sessionId && sessionState && (
            <SessionControls state={sessionState} disabled={busy || configInFlight} error={configError} onChange={(request) => void setConfig(request)} />
          )}
          {session ? (
            <ContextBar
              cwd={session.cwd}
              displayCwd={session.displayCwd}
              git={session.git}
              label={session.project?.name}
              note={session.cwdMissing ? "Working directory is missing" : undefined}
            />
          ) : startContext}
        </Panel>
        {showShell && sessionId && <Separator aria-label="Resize terminal panel" className="h-1.5 shrink-0 bg-zinc-800 transition-colors hover:bg-indigo-500 focus-visible:bg-indigo-500 focus-visible:outline-none" />}
        {showShell && sessionId && (
          <Panel id="shell" defaultSize={`${shellSize}%`} minSize="20%" maxSize="75%">
            <TerminalPanel sessionId={sessionId} onHide={hideShell} />
          </Panel>
        )}
      </Group>
    </main>
  );
}
