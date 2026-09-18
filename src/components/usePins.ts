"use client";

import { useCallback, useSyncExternalStore } from "react";
import { EMPTY_PINS, parsePins, prunePins, togglePin, type PinMap } from "@/lib/pins";

const PROJECTS_KEY = "portal.pins.projects";
const SESSIONS_KEY = "portal.pins.sessions";

// One cached, parsed map per key so `useSyncExternalStore` sees a stable snapshot between writes.
const cache = new Map<string, PinMap>();
const listeners = new Set<() => void>();

function read(key: string): PinMap {
  const cached = cache.get(key);
  if (cached) return cached;
  let pins = EMPTY_PINS;
  try {
    pins = parsePins(localStorage.getItem(key));
  } catch {
    // Storage is unavailable (private mode, blocked site data): nothing is pinned.
  }
  cache.set(key, pins);
  return pins;
}

function write(key: string, pins: PinMap) {
  cache.set(key, pins);
  try {
    if (Object.keys(pins).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(pins));
  } catch {
    // Pins still hold for this page load.
  }
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab of this browser changed its pins: drop the cache so the next read reparses.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PROJECTS_KEY || e.key === SESSIONS_KEY) {
      cache.clear();
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export type UsePins = {
  /** Project id → epoch ms pinned. */
  projectPins: PinMap;
  /** Session id → epoch ms pinned. */
  sessionPins: PinMap;
  toggleProjectPin: (id: string) => void;
  toggleSessionPin: (id: string) => void;
  /** Forget pins for projects and sessions that no longer exist. */
  prune: (projectIds: Iterable<string>, sessionIds: Iterable<string>) => void;
};

/** Pinned projects and sessions, a per-browser preference kept in localStorage. Empty during server rendering. */
export function usePins(): UsePins {
  const projectPins = useSyncExternalStore(subscribe, () => read(PROJECTS_KEY), () => EMPTY_PINS);
  const sessionPins = useSyncExternalStore(subscribe, () => read(SESSIONS_KEY), () => EMPTY_PINS);
  const toggleProjectPin = useCallback((id: string) => write(PROJECTS_KEY, togglePin(read(PROJECTS_KEY), id)), []);
  const toggleSessionPin = useCallback((id: string) => write(SESSIONS_KEY, togglePin(read(SESSIONS_KEY), id)), []);
  const prune = useCallback((projectIds: Iterable<string>, sessionIds: Iterable<string>) => {
    const projects = read(PROJECTS_KEY);
    const pruned = prunePins(projects, projectIds);
    if (pruned !== projects) write(PROJECTS_KEY, pruned);
    const sessions = read(SESSIONS_KEY);
    const prunedSessions = prunePins(sessions, sessionIds);
    if (prunedSessions !== sessions) write(SESSIONS_KEY, prunedSessions);
  }, []);
  return { projectPins, sessionPins, toggleProjectPin, toggleSessionPin, prune };
}
