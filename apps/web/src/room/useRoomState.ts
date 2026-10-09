"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { RoomEnvironment, RoomState } from "@portal/contracts/room";
import { usePortalEvents } from "@/components/portal/PortalLive";
import { nextMinute, roomCoordinates, sunClock, type SunClock } from "./sun";

/**
 * The room's state for the whole visit: `GET /api/room` once per page load, then the portal
 * stream's `room` events (sent on connect and on every change). Kept at module level so the room
 * and the Settings dialog share it and remounting does not refetch. A failed request is forgotten,
 * so the next component to subscribe (the Settings dialog opening) asks again; until a state
 * arrives, `useRoomFailed` says the last request failed.
 */
let cached: RoomState | null = null;
let loading: Promise<void> | null = null;
let failed = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function publish(state: RoomState) {
  cached = state;
  failed = false;
  notify();
}

function fail() {
  loading = null;
  if (cached || failed) return;
  failed = true;
  notify();
}

/** Adopt a state the page got some other way (the Settings dialog's Refresh answers one). */
export function publishRoomState(state: RoomState) {
  publish(state);
}

function loadOnce() {
  if (cached) return Promise.resolve();
  loading ??= fetch("/api/room")
    .then(async (response) => {
      if (!response.ok) return fail();
      const state = (await response.json()) as RoomState;
      // The stream's copy, when it got here first, is the fresher one.
      if (!cached) publish(state);
    })
    .catch(() => {
      // The room falls back to the browser's time zone and a clear sky; the stream may still deliver.
      fail();
    });
  return loading;
}

function subscribeRoom(listener: () => void) {
  listeners.add(listener);
  void loadOnce();
  return () => {
    listeners.delete(listener);
  };
}

const readRoom = () => cached;
const serverRoom = () => null;
const readFailed = () => failed;
const serverFailed = () => false;

export function useRoomState(): RoomState | null {
  const state = useSyncExternalStore(subscribeRoom, readRoom, serverRoom);
  usePortalEvents((event) => {
    if (event.type === "room") publish(event.state);
  });
  return state;
}

/** Whether the room's state could not be loaded (and none has arrived since). */
export function useRoomFailed(): boolean {
  return useSyncExternalStore(subscribeRoom, readFailed, serverFailed);
}

// ---------------------------------------------------------------------------------------------
// The sun clock
// ---------------------------------------------------------------------------------------------

/** The current minute (epoch ms, floored), ticking on minute boundaries and when the tab is shown again. */
function subscribeMinute(listener: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const now = Date.now();
    timer = setTimeout(
      () => {
        listener();
        schedule();
      },
      Math.max(1000, nextMinute(now) - now + 50),
    );
  };
  const onVisibility = () => {
    if (document.hidden) return;
    clearTimeout(timer);
    listener();
    schedule();
  };
  schedule();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
const serverMinute = () => null;

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/**
 * The sun and moon for the room, once a minute from the client clock: over the environment's
 * coordinates, else the browser time zone's rough location. Null during server rendering.
 */
export function useSunClock(environment: RoomEnvironment | null): SunClock | null {
  const minute = useSyncExternalStore(subscribeMinute, currentMinute, serverMinute);
  const latitude = environment?.latitude ?? null;
  const longitude = environment?.longitude ?? null;
  return useMemo(() => {
    if (minute === null) return null;
    return sunClock(minute, roomCoordinates({ latitude, longitude }, browserTimeZone()));
  }, [minute, latitude, longitude]);
}
