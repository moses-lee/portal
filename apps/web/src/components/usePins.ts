"use client";

import { useCallback, useSyncExternalStore } from "react";
import { EMPTY_PINS, parsePins, prunePins, togglePin, type PinMap } from "@/lib/pins";

// Project pins live on the server now (`Project.pinnedAt`); `useProjects` moves the old local ones there.
const SESSIONS_KEY = "portal.pins.sessions";

// The parsed map, cached so `useSyncExternalStore` sees a stable snapshot between writes.
let cache: PinMap | null = null;
const listeners = new Set<() => void>();

function read(): PinMap {
  if (cache) return cache;
  let pins = EMPTY_PINS;
  try {
    pins = parsePins(localStorage.getItem(SESSIONS_KEY));
  } catch {
    // Storage is unavailable (private mode, blocked site data): nothing is pinned.
  }
  cache = pins;
  return pins;
}

function write(pins: PinMap) {
  cache = pins;
  try {
    if (Object.keys(pins).length === 0) localStorage.removeItem(SESSIONS_KEY);
    else localStorage.setItem(SESSIONS_KEY, JSON.stringify(pins));
  } catch {
    // Pins still hold for this page load.
  }
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab of this browser changed its pins: drop the cache so the next read reparses.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SESSIONS_KEY) {
      cache = null;
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export type UseSessionPins = {
  /** Session id → epoch ms pinned. */
  sessionPins: PinMap;
  toggleSessionPin: (id: string) => void;
  /** Forget pins for sessions that no longer exist. */
  prune: (sessionIds: Iterable<string>) => void;
};

/** Pinned sessions, a per-browser preference kept in localStorage. Empty during server rendering. */
export function useSessionPins(): UseSessionPins {
  const sessionPins = useSyncExternalStore(subscribe, read, () => EMPTY_PINS);
  const toggleSessionPin = useCallback((id: string) => write(togglePin(read(), id)), []);
  const prune = useCallback((sessionIds: Iterable<string>) => {
    const sessions = read();
    const pruned = prunePins(sessions, sessionIds);
    if (pruned !== sessions) write(pruned);
  }, []);
  return { sessionPins, toggleSessionPin, prune };
}
