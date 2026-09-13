"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { PortalEvent } from "@/lib/acp";
import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";

type SessionMeta = { id: string; cwd: string; createdAt: number; busy: boolean };

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
  | { kind: "permission"; title: string; optionName: string }
  | { kind: "turn_end"; stopReason: string }
  | { kind: "error"; message: string };

function reduce(events: PortalEvent[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
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
      case "permission":
        blocks.push({ kind: "permission", title: ev.title, optionName: ev.optionName });
        break;
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

function BlockView({ b }: { b: Block }) {
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
      return (
        <div className="text-[11px] text-zinc-600">
          auto-approved: {b.title} ({b.optionName})
        </div>
      );
    case "turn_end":
      return b.stopReason === "end_turn" ? null : (
        <div className="text-[11px] text-zinc-600">turn ended: {b.stopReason}</div>
      );
    case "error":
      return <div className="rounded bg-red-950/50 px-3 py-2 text-sm text-red-300">{b.message}</div>;
  }
}

export default function Chat() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [cwd, setCwd] = useState("~/repos/monorepo");
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [showSidebar, setShowSidebar] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const refreshSessions = useCallback(async () => {
    const r = await fetch("/api/sessions");
    const j = (await r.json()) as { sessions: SessionMeta[] };
    setSessions(j.sessions);
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Subscribe to the active session's event stream.
  useEffect(() => {
    esRef.current?.close();
    setEvents([]);
    setBusy(false);
    if (!active) return;
    const es = new EventSource(`/api/sessions/${active}/events`);
    esRef.current = es;
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as PortalEvent;
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "turn_start") setBusy(true);
      if (ev.type === "turn_end" || ev.type === "error") setBusy(false);
    };
    es.addEventListener("meta", (m) => {
      const meta = JSON.parse((m as MessageEvent).data) as { busy: boolean };
      setBusy(meta.busy);
    });
    return () => es.close();
  }, [active]);

  const blocks = useMemo(() => reduce(events), [events]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [blocks.length, events.length]);

  const newSession = async () => {
    const r = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const j = (await r.json()) as { id?: string; error?: string };
    if (j.error) {
      alert(j.error);
      return;
    }
    await refreshSessions();
    setActive(j.id!);
    setShowSidebar(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !active || busy) return;
    setInput("");
    const r = await fetch(`/api/sessions/${active}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      const j = (await r.json()) as { error?: string };
      setEvents((prev) => [...prev, { type: "error", message: j.error ?? "send failed" }]);
    }
  };

  const stop = async () => {
    if (!active) return;
    await fetch(`/api/sessions/${active}/cancel`, { method: "POST" });
  };

  const activeMeta = sessions.find((s) => s.id === active);

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside
        className={`${showSidebar ? "flex" : "hidden"} absolute inset-y-0 left-0 z-20 w-72 flex-col border-r border-zinc-800 bg-zinc-950 p-3 md:static md:flex`}
      >
        <div className="mb-3 text-sm font-semibold tracking-wide text-zinc-400">portal</div>
        <label className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">working directory</label>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          className="mb-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-500"
        />
        <button onClick={newSession} className="mb-4 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500">
          + New session
        </button>
        <div className="flex-1 space-y-1 overflow-y-auto">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setActive(s.id);
                setShowSidebar(false);
              }}
              className={`block w-full rounded px-2 py-1.5 text-left text-xs ${s.id === active ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
            >
              <div className="truncate font-mono text-zinc-300">{s.cwd.replace(/^\/Users\/[^/]+/, "~")}</div>
              <div className="text-[10px] text-zinc-600">
                {new Date(s.createdAt).toLocaleTimeString()} · {s.id.slice(0, 8)}
              </div>
            </button>
          ))}
        </div>
      </aside>
      {showSidebar && <div className="absolute inset-0 z-10 bg-black/60 md:hidden" onClick={() => setShowSidebar(false)} />}

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <button onClick={() => setShowSidebar(true)} className="rounded border border-zinc-800 px-2 py-1 md:hidden">
            ☰
          </button>
          <span className="truncate font-mono text-zinc-400">
            {activeMeta ? activeMeta.cwd.replace(/^\/Users\/[^/]+/, "~") : "no session"}
          </span>
          {busy && <span className="ml-auto animate-pulse text-amber-400">working…</span>}
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4 md:px-6">
          {!active && (
            <div className="mt-20 text-center text-sm text-zinc-500">Create a session to start chatting with Claude Code.</div>
          )}
          {blocks.map((b, i) => (
            <BlockView key={i} b={b} />
          ))}
          <div ref={bottomRef} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex items-end gap-2 border-t border-zinc-800 p-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={active ? "Message Claude Code…" : "Create a session first"}
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
      </main>
    </div>
  );
}
