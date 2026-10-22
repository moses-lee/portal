"use client";

import { useEffect, useSyncExternalStore } from "react";
import { MAX_EXISTS_PATHS } from "@portal/contracts/files";

/**
 * Which candidate paths in agent text exist (docs/FILES.md, decision 14). Every candidate on
 * screen asks for itself; the asks made in one render are sent as one `POST /api/files/exists`
 * per working directory, and the answers are kept for the page's life, so a message is checked
 * once and a remount costs nothing.
 */

/** cwd ("" for none) -> path as written -> exists. */
const known = new Map<string, Map<string, boolean>>();
/** cwd -> paths asked about and not yet answered (queued or in flight). */
const asked = new Map<string, Set<string>>();
let queued = new Map<string, Set<string>>();
let flushing = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function check(cwd: string, paths: string[]) {
  let existing: string[] = [];
  let answered = false;
  try {
    const r = await fetch("/api/files/exists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cwd ? { cwd, paths } : { paths }),
    });
    if (r.ok) {
      existing = ((await r.json()) as { existing?: string[] }).existing ?? [];
      answered = true;
    }
  } catch {
    // Offline or the server is restarting: these stay unknown, so a later render asks again.
  }
  const pending = asked.get(cwd);
  const results = known.get(cwd) ?? new Map<string, boolean>();
  known.set(cwd, results);
  const found = new Set(existing);
  for (const path of paths) {
    pending?.delete(path);
    if (answered) results.set(path, found.has(path));
  }
  if (!answered) return;
  for (const listener of listeners) listener();
}

function flush() {
  flushing = false;
  const batch = queued;
  queued = new Map();
  for (const [cwd, paths] of batch) {
    const list = [...paths];
    for (let i = 0; i < list.length; i += MAX_EXISTS_PATHS) void check(cwd, list.slice(i, i + MAX_EXISTS_PATHS));
  }
}

function ask(cwd: string, path: string) {
  if (known.get(cwd)?.has(path)) return;
  const pending = asked.get(cwd) ?? new Set<string>();
  asked.set(cwd, pending);
  if (pending.has(path)) return;
  pending.add(path);
  const batch = queued.get(cwd) ?? new Set<string>();
  queued.set(cwd, batch);
  batch.add(path);
  if (flushing) return;
  flushing = true;
  // Effects of one commit all run before a timer: one request for every candidate a render produced.
  setTimeout(flush, 0);
}

/**
 * True once the server has said `path` exists (relative to `cwd` when relative); false while
 * unknown or missing. With `check` false (a reply still streaming) nothing is sent, but an answer
 * already known is still used.
 */
export function usePathExists(path: string | null, cwd: string | null | undefined, check: boolean): boolean {
  const key = cwd ?? "";
  const exists = useSyncExternalStore(
    subscribe,
    () => (path ? (known.get(key)?.get(path) ?? false) : false),
    () => false,
  );
  useEffect(() => {
    if (check && path) ask(key, path);
  }, [check, key, path]);
  return exists;
}
