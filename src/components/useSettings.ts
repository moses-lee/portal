"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { applySettingsPatch } from "@/lib/settings";
import type { Settings, SettingsPatch } from "@/lib/settings";

export type UseSettings = {
  /** Merged settings from `GET /api/settings`; null until loaded. */
  settings: Settings | null;
  /** True until the first fetch settles. */
  loading: boolean;
  /** Message from the last failed load; cleared by a successful one. */
  error: string | null;
  /**
   * Optimistically apply `patch` locally, `PATCH /api/settings`, replace with the server's answer.
   * On failure revert and rethrow an Error with a user-facing message so a field can show it.
   */
  update(patch: SettingsPatch): Promise<Settings>;
  /** Refetch. Never rejects; failures land in `error`. */
  refresh(): Promise<void>;
};

const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";

async function readError(r: Response, fallback: string) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error || fallback);
}

/*
 * One store for the whole page: the settings dialog edits the same object the source control
 * panel's actions read, and every mounter shares a single fetch instead of racing its own.
 */
type Snapshot = Pick<UseSettings, "settings" | "loading" | "error">;

const initialSnapshot: Snapshot = { settings: null, loading: true, error: null };
let snapshot: Snapshot = initialSnapshot;
const listeners = new Set<() => void>();
/** The load mounters are waiting on, so a second mount joins it instead of starting another. */
let inFlight: Promise<void> | null = null;
/** Counter of loads; only the newest one's response is applied. */
let requests = 0;

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => initialSnapshot;

async function load(): Promise<void> {
  const request = ++requests;
  let next: Settings | null = null;
  let message: string | null = null;
  try {
    const r = await fetch("/api/settings");
    if (!r.ok) throw await readError(r, "Could not load settings. Reload the page to retry.");
    next = ((await r.json()) as { settings: Settings }).settings;
  } catch (e) {
    message = e instanceof Error && e.message !== "Failed to fetch" ? e.message : NETWORK_ERROR;
  }
  // A newer load already answered; let it win.
  if (request !== requests) return;
  publish({ settings: next ?? snapshot.settings, error: message, loading: false });
}

function startLoad(): Promise<void> {
  const promise = load().finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/** Load once for everyone; a mount after a failed load retries. */
function ensureLoaded() {
  if (snapshot.settings === null && !inFlight) void startLoad();
}

const refresh = () => startLoad();

async function update(patch: SettingsPatch): Promise<Settings> {
  const previous = snapshot.settings;
  if (previous) publish({ settings: applySettingsPatch(previous, patch) });
  let r: Response;
  try {
    r = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    publish({ settings: previous });
    throw new Error(NETWORK_ERROR);
  }
  if (!r.ok) {
    publish({ settings: previous });
    throw await readError(r, "Could not save settings. Try again.");
  }
  const { settings: saved } = (await r.json()) as { settings: Settings };
  publish({ settings: saved });
  return saved;
}

export function useSettings(): UseSettings {
  const { settings, loading, error } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureLoaded();
  }, []);
  return { settings, loading, error, update, refresh };
}

/*
 * Opening the settings dialog from anywhere. The dialog is mounted once by the app shell; pages
 * that are not its parent (the Talk to Portal page's "Add API key", say) ask for it with a window
 * event instead of threading a callback through the tree.
 */

/** Sections of the settings dialog a caller can ask to land on. */
export type SettingsSection = "gitActions" | "orchestrator";
const settingsSections: readonly SettingsSection[] = ["gitActions", "orchestrator"];

export type OpenSettingsDetail = { section?: SettingsSection };

/** Dispatched on `window` as a `CustomEvent<OpenSettingsDetail>` to open the settings dialog. */
export const OPEN_SETTINGS_EVENT = "portal:open-settings";

/** Opens the settings dialog wherever it is mounted, scrolled to `section` when given. */
export function openSettings(section?: SettingsSection) {
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { section } }));
}

/** For the dialog's host: calls `onOpen` with the requested section (null when none) whenever OPEN_SETTINGS_EVENT fires. */
export function useOpenSettingsRequests(onOpen: (section: SettingsSection | null) => void) {
  // Kept in a ref so the listener is registered once and still calls the newest callback.
  const handler = useRef(onOpen);
  useEffect(() => {
    handler.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    const listen = (event: Event) => {
      const section = (event as CustomEvent<OpenSettingsDetail | undefined>).detail?.section;
      handler.current(section && settingsSections.includes(section) ? section : null);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, listen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listen);
  }, []);
}
