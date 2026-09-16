"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import TerminalView, { type TerminalViewHandle } from "./TerminalView";
import type { ShellViewState } from "@/lib/shell-client";
import type { TerminalInfo } from "@/lib/shell-types";

export type TerminalPanelProps = {
  sessionId: string;
  /** Hide the panel; the caller returns focus to the header's Terminal toggle. */
  onHide: () => void;
};

/**
 * Tabs, the selected one, the ones ever selected (kept mounted while hidden), and each tab's
 * "Terminal N" number, assigned on first sight and never reused so labels stay put as tabs close.
 */
type Tabs = { terminals: TerminalInfo[]; activeId: string | null; mounted: string[]; labels: Record<string, number> };

const EMPTY: Tabs = { terminals: [], activeId: null, mounted: [], labels: {} };
const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";
const KEY_ROW: [string, string][] = [["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl+C", "\u0003"], ["↑", "\u001b[A"], ["↓", "\u001b[B"]];

const labelOf = (tabs: Tabs, id: string) => `Terminal ${tabs.labels[id] ?? "?"}`;

function withLabels(tabs: Tabs, terminals: TerminalInfo[]): Tabs {
  const unseen = terminals.filter((t) => !(t.id in tabs.labels));
  if (unseen.length === 0) return tabs;
  const labels = { ...tabs.labels };
  for (const t of unseen) labels[t.id] = Object.keys(labels).length + 1;
  return { ...tabs, labels };
}

function activate(tabs: Tabs, id: string | null): Tabs {
  if (id === tabs.activeId) return tabs;
  return { ...tabs, activeId: id, mounted: id && !tabs.mounted.includes(id) ? [...tabs.mounted, id] : tabs.mounted };
}

/** Remove a tab; when it was active, the left neighbor takes over, else the right one. */
function without(tabs: Tabs, id: string): Tabs {
  const index = tabs.terminals.findIndex((t) => t.id === id);
  if (index === -1) return tabs;
  const next: Tabs = { ...tabs, terminals: tabs.terminals.filter((t) => t.id !== id), mounted: tabs.mounted.filter((m) => m !== id) };
  if (tabs.activeId !== id) return next;
  return activate({ ...next, activeId: null }, (tabs.terminals[index - 1] ?? tabs.terminals[index + 1])?.id ?? null);
}

/** Adopt the server's list, keeping the selection when it still exists. */
function reconcile(tabs: Tabs, terminals: TerminalInfo[]): Tabs {
  const ids = new Set(terminals.map((t) => t.id));
  const kept = withLabels({ ...tabs, terminals, activeId: null, mounted: tabs.mounted.filter((id) => ids.has(id)) }, terminals);
  return activate(kept, tabs.activeId && ids.has(tabs.activeId) ? tabs.activeId : terminals[0]?.id ?? null);
}

function insert(tabs: Tabs, terminal: TerminalInfo): Tabs {
  if (tabs.terminals.some((t) => t.id === terminal.id)) return withLabels(tabs, [terminal]);
  return withLabels({ ...tabs, terminals: [...tabs.terminals, terminal].sort((a, b) => a.createdAt - b.createdAt) }, [terminal]);
}

function omit<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const rest = { ...record };
  delete rest[id];
  return rest;
}

async function readError(r: Response, fallback: string) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error ?? fallback);
}

function statusText(view: ShellViewState | undefined) {
  if (!view || (!view.connected && !view.closed)) return "Connecting…";
  if (view.closed) return "Closed";
  if (view.shell?.status === "exited") return `Exited (${view.shell.exitCode})`;
  return view.shell?.shell ?? "";
}

/** A session's terminals as tabs; each tab is its own PTY, started on first attach and kept running while hidden. */
export default function TerminalPanel({ sessionId, onHide }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<Tabs>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [views, setViews] = useState<Record<string, ShellViewState>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Id of a tab another viewer closed; shown briefly by its label. */
  const [closedNotice, setClosedNotice] = useState<string | null>(null);
  const clients = useRef(new Map<string, TerminalViewHandle>());
  const deleting = useRef(new Set<string>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listUrl = `/api/sessions/${encodeURIComponent(sessionId)}/terminals`;

  const showClosedNotice = useCallback((id: string) => {
    clearTimeout(noticeTimer.current);
    setClosedNotice(id);
    noticeTimer.current = setTimeout(() => setClosedNotice(null), 6000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const fetchTerminals = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch(listUrl, { signal });
    if (!r.ok) throw await readError(r, "Could not load this session's terminals.");
    return ((await r.json()) as { terminals: TerminalInfo[] }).terminals;
  }, [listUrl]);

  const createTerminal = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch(listUrl, { method: "POST", signal });
    if (!r.ok) throw await readError(r, "Could not create a terminal.");
    return (await r.json()) as TerminalInfo;
  }, [listUrl]);

  // Load on open (creating the first tab when there is none) and reconcile with the server on every return to the tab.
  useEffect(() => {
    const controller = new AbortController();
    const adopt = (terminals: TerminalInfo[]) => {
      // A tab we are deleting may still be listed until the DELETE lands.
      const visible = terminals.filter((t) => !deleting.current.has(t.id));
      setTabs((prev) => reconcile(prev, visible));
      setViews((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => visible.some((t) => t.id === id))));
    };
    const load = async () => {
      try {
        let terminals = await fetchTerminals(controller.signal);
        if (terminals.length === 0) terminals = [await createTerminal(controller.signal)];
        if (controller.signal.aborted) return;
        adopt(terminals);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : NETWORK_ERROR);
      } finally {
        if (!controller.signal.aborted) setLoaded(true);
      }
    };
    const refetch = async () => {
      try {
        const terminals = await fetchTerminals(controller.signal);
        if (!controller.signal.aborted) adopt(terminals);
      } catch {
        // Keep what we have; the next focus retries.
      }
    };
    const onFocus = () => void refetch();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchTerminals, createTerminal]);

  const focusTab = (id: string | null) => {
    (id ? document.getElementById(`terminal-tab-${id}`) : document.getElementById("terminal-new-tab"))?.focus();
  };

  const newTab = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const terminal = await createTerminal();
      setTabs((prev) => activate(insert(prev, terminal), terminal.id));
    } catch (e) {
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : NETWORK_ERROR);
    } finally {
      setCreating(false);
    }
  };

  const closeTab = async (id: string) => {
    const index = tabs.terminals.findIndex((t) => t.id === id);
    if (index === -1 || deleting.current.has(id)) return;
    const removed = tabs.terminals[index];
    deleting.current.add(id);
    setTabs((prev) => without(prev, id));
    setViews((prev) => omit(prev, id));
    try {
      const r = await fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) throw await readError(r, "Could not close the terminal.");
    } catch (e) {
      setTabs((prev) => insert(prev, removed));
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : NETWORK_ERROR);
    } finally {
      deleting.current.delete(id);
    }
  };

  const onView = useCallback((id: string, view: ShellViewState) => {
    if (view.closed) {
      // Deleted by another viewer; our own deletes unmount the tab before this can arrive.
      setTabs((prev) => without(prev, id));
      setViews((prev) => omit(prev, id));
      showClosedNotice(id);
      return;
    }
    setViews((prev) => ({ ...prev, [id]: view }));
  }, [showClosedNotice]);

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = tabs.terminals.map((t) => t.id);
    const index = tabs.activeId ? ids.indexOf(tabs.activeId) : -1;
    if (ids.length === 0 || index === -1) return;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft": next = (index + ids.length - 1) % ids.length; break;
      case "ArrowRight": next = (index + 1) % ids.length; break;
      case "Home": next = 0; break;
      case "End": next = ids.length - 1; break;
      case "Delete": {
        e.preventDefault();
        // Focus a neighbor now; it exists already, and selection follows once the removal renders.
        focusTab(ids[index - 1] ?? ids[index + 1] ?? null);
        void closeTab(ids[index]);
        return;
      }
      default: return;
    }
    e.preventDefault();
    setTabs((prev) => activate(prev, ids[next!]));
    focusTab(ids[next]);
  };

  const active = tabs.activeId ? tabs.terminals.find((t) => t.id === tabs.activeId) : undefined;
  const activeView = tabs.activeId ? views[tabs.activeId] : undefined;
  const running = !!activeView?.connected && activeView.shell?.status === "running";
  const activeError = activeView?.error && !activeView.closed ? activeView.error : null;

  return (
    <section id="terminal-panel" aria-label="Terminal" className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-xs text-zinc-400">
        <span className="shrink-0 font-medium text-zinc-200">Terminal</span>
        <div role="tablist" aria-label="Terminals" onKeyDown={onTabKeyDown} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.terminals.map((t) => {
            const selected = t.id === tabs.activeId;
            const name = labelOf(tabs, t.id);
            return (
              <div key={t.id} className={`flex shrink-0 items-center rounded border ${selected ? "border-indigo-500 bg-indigo-950 text-indigo-100" : "border-zinc-800 text-zinc-300 hover:bg-zinc-900"}`}>
                <button
                  type="button"
                  role="tab"
                  id={`terminal-tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls={`terminal-tabpanel-${t.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTabs((prev) => activate(prev, t.id))}
                  className="px-2 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400"
                >
                  {name}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  title="Close terminal"
                  tabIndex={-1}
                  onClick={() => void closeTab(t.id)}
                  className="px-1.5 py-1 text-zinc-500 hover:text-zinc-200"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            id="terminal-new-tab"
            aria-label="New terminal"
            title="New terminal"
            onClick={() => void newTab()}
            disabled={creating || !loaded}
            className="shrink-0 rounded border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
          >
            +
          </button>
        </div>
        <button aria-label="Hide terminal" onClick={onHide} className="ml-auto shrink-0 rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800">Hide</button>
      </div>
      {active && (
        <div className="flex shrink-0 items-center gap-3 px-3 pb-1.5 text-xs text-zinc-400">
          <span className="truncate font-mono" title={activeView?.shell?.cwd}>{activeView?.shell?.displayCwd}</span>
          <span role="status" className="ml-auto shrink-0">{statusText(activeView)}</span>
          {activeView?.connected && activeView.shell?.status !== "running" && (
            <button onClick={() => clients.current.get(active.id)?.start()} className="shrink-0 rounded bg-indigo-600 px-2 py-1 text-white hover:bg-indigo-500">
              Start new shell
            </button>
          )}
        </div>
      )}
      {(error || activeError) && <p role="alert" className="px-3 pb-2 text-xs text-red-300">{error ?? activeError}</p>}
      {closedNotice && <p role="status" className="px-3 pb-2 text-xs text-amber-300">{labelOf(tabs, closedNotice)} was closed on another device.</p>}
      <div className="min-h-0 flex-1 px-3 pb-2">
        {tabs.terminals.filter((t) => tabs.mounted.includes(t.id)).map((t) => (
          <TerminalView
            key={t.id}
            terminalId={t.id}
            active={t.id === tabs.activeId}
            onChange={(view) => onView(t.id, view)}
            ref={(handle) => {
              if (handle) clients.current.set(t.id, handle);
              else clients.current.delete(t.id);
            }}
          />
        ))}
        {loaded && tabs.terminals.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-zinc-500">
            <p>No terminals in this session.</p>
            <button
              type="button"
              onClick={() => void newTab()}
              disabled={creating}
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              {creating ? "Creating…" : "New terminal"}
            </button>
          </div>
        )}
        {!loaded && !error && <p className="p-3 text-xs text-zinc-500">Loading terminals…</p>}
      </div>
      <div className="flex shrink-0 gap-2 border-t border-zinc-800 px-3 py-1 md:hidden">
        {KEY_ROW.map(([name, data]) => (
          <button
            key={name}
            disabled={!running}
            onClick={() => { if (active) clients.current.get(active.id)?.input(data); }}
            className="rounded bg-zinc-900 px-3 py-2 text-xs disabled:opacity-40"
          >
            {name}
          </button>
        ))}
      </div>
    </section>
  );
}
