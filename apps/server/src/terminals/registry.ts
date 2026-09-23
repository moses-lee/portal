import { randomUUID } from "node:crypto";
import { createShellRuntime } from "./shell-runtime.ts";
import type { TerminalInfo } from "../lib/shell-types.ts";

export type ShellRuntime = ReturnType<typeof createShellRuntime>;
type RuntimeOptions = NonNullable<Parameters<typeof createShellRuntime>[0]>;

/** One terminal tab: a PTY runtime owned by a chat session, or by nobody (`sessionId: null`) for the standalone terminal page. */
export type TerminalEntry = {
  id: string;
  sessionId: string | null;
  createdAt: number;
  runtime: ShellRuntime;
};

export function info(entry: TerminalEntry): TerminalInfo {
  return { id: entry.id, sessionId: entry.sessionId, createdAt: entry.createdAt, state: entry.runtime.getState() };
}

export function createTerminalRegistry({
  createRuntime = createShellRuntime,
}: { createRuntime?: (options: RuntimeOptions) => ShellRuntime } = {}) {
  // Insertion order is creation order, which is also the tab order clients show.
  const entries = new Map<string, TerminalEntry>();
  const closeListeners = new Set<(entry: TerminalEntry) => void>();
  let disposed = false;

  /** Registers a terminal without starting its PTY; the first attached viewer sends `start`. */
  function create({ sessionId, ...options }: RuntimeOptions & { sessionId: string | null; cwd: string }): TerminalEntry {
    if (disposed) throw new Error("Terminals are shutting down.");
    const entry: TerminalEntry = { id: randomUUID(), sessionId, createdAt: Date.now(), runtime: createRuntime(options) };
    entries.set(entry.id, entry);
    return entry;
  }

  function get(id: string): TerminalEntry | undefined {
    return entries.get(id);
  }

  function listBySession(sessionId: string): TerminalEntry[] {
    return [...entries.values()].filter((entry) => entry.sessionId === sessionId);
  }

  /** Terminals that belong to no session; they end only when closed, when their shell exits, or when Portal stops. */
  function listStandalone(): TerminalEntry[] {
    return [...entries.values()].filter((entry) => entry.sessionId === null);
  }

  function close(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) return false;
    // Viewers are told first so they see "closed" rather than a bare disconnect.
    for (const listener of closeListeners) listener(entry);
    entry.runtime.dispose();
    entries.delete(id);
    return true;
  }

  function closeSession(sessionId: string) {
    for (const entry of listBySession(sessionId)) close(entry.id);
  }

  function onClose(listener: (entry: TerminalEntry) => void) {
    closeListeners.add(listener);
    return () => { closeListeners.delete(listener); };
  }

  /** Kills every PTY synchronously; safe to call from an `exit` handler and more than once. */
  function disposeAll() {
    if (disposed) return;
    disposed = true;
    for (const id of [...entries.keys()]) close(id);
    closeListeners.clear();
  }

  return { create, get, listBySession, listStandalone, close, closeSession, onClose, disposeAll };
}
