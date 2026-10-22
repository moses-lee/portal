/**
 * The file pane's client side (docs/FILES.md, "File pane"): paths as the user typed or an agent
 * wrote them made absolute, shown with the home directory as `~`, the files API's calls (stat, list,
 * text with a size cap, guarded save), and two in-memory registries the workspace reads: which
 * panes hold unsaved edits (closing one asks first) and the line a pane was asked to scroll to.
 * No React, no `@/` imports: the node test runner loads this file directly.
 */
import type { FileListing, FileStat } from "@portal/contracts/files";
import { parseLineSuffix } from "./file-links.ts";

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** `input` without a `file://` scheme (percent-decoded) and without a `:42`, `:42:7` or `#L42` suffix, and that line. */
export function parseFileInput(input: string): { path: string; line: number | null } {
  let raw = input.trim();
  if (/^file:/i.test(raw)) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch {
      raw = raw.replace(/^file:(?:\/\/)?/i, "");
    }
  }
  return parseLineSuffix(raw);
}

/** An absolute path with `.` and `..` segments and repeated or trailing slashes folded away. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/**
 * The absolute path for `input` without asking the server: `~` against `home`, a relative path
 * against `cwd`. Null when it cannot be formed (`~` with no home known, a relative path with no
 * absolute `cwd`). The server's stat is the authority; this is for a path that does not exist.
 */
export function resolveLocally(input: string, cwd: string | null | undefined, home: string | null): string | null {
  const expand = (path: string): string | null => {
    if (path === "~" || path.startsWith("~/")) return home ? `${home}${path.slice(1)}` : null;
    return path;
  };
  const path = expand(input);
  if (path === null) return null;
  if (path.startsWith("/")) return normalizePath(path);
  const base = cwd ? expand(cwd) : null;
  if (!base || !base.startsWith("/")) return null;
  return normalizePath(`${base}/${path}`);
}

/** The directory holding `path`; null at the root. */
export function parentPath(path: string): string | null {
  const normal = normalizePath(path);
  if (normal === "/") return null;
  return normal.slice(0, normal.lastIndexOf("/")) || "/";
}

/** `path` with the home directory written `~` (as the terminal and the project picker show it); unchanged when home is unknown. */
export function displayFilePath(path: string, home: string | null): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `1.2 MB`, `340 KB`, `12 B`: sizes in the listing and the binary view. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

// ---------------------------------------------------------------------------------------------
// The files API (`@portal/contracts/files`)
// ---------------------------------------------------------------------------------------------

function query(path: string, cwd?: string | null, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ path, ...extra });
  if (cwd) params.set("cwd", cwd);
  return params.toString();
}

/** The bytes of `path`; `version` busts the browser's cache when the file changes, `download` asks for an attachment. */
export function rawUrl(path: string, options: { version?: string | null; download?: boolean } = {}): string {
  return `/api/files/raw?${query(path, null, {
    ...(options.download ? { download: "1" } : {}),
    ...(options.version ? { v: options.version } : {}),
  })}`;
}

export type StatResult = { kind: "ok"; stat: FileStat } | { kind: "missing" } | { kind: "error"; message: string };

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function statFile(path: string, cwd?: string | null, signal?: AbortSignal): Promise<StatResult> {
  try {
    const response = await fetch(`/api/files/stat?${query(path, cwd)}`, { signal, cache: "no-store" });
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) return { kind: "error", message: await errorOf(response, `Could not read ${path}.`) };
    return { kind: "ok", stat: (await response.json()) as FileStat };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "error", message: "Could not reach the server." };
  }
}

export async function listDirectory(path: string, signal?: AbortSignal): Promise<FileListing> {
  const response = await fetch(`/api/files/list?${query(path)}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(await errorOf(response, `Could not list ${path}.`));
  return (await response.json()) as FileListing;
}

/** The file's text, read up to `limit` bytes (the rest is not downloaded); `truncated` when there was more. */
export async function readText(path: string, limit: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(rawUrl(path), { signal, cache: "no-store" });
  if (!response.ok) throw new Error(await errorOf(response, `Could not read ${path}.`));
  if (!response.body) return { text: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  // A cut mid-character decodes to a replacement character at the end, which is fine for a read-only view.
  return { text: new TextDecoder().decode(bytes), truncated };
}

/**
 * Save `text` over the version the editor loaded (decision 12): `saved` with the new version; on a
 * `conflict` the file's current version (null when it is gone). `version` null creates the file and
 * conflicts when one is there.
 */
export type SaveResult = { kind: "saved"; version: string } | { kind: "conflict"; version: string | null } | { kind: "error"; message: string };

export async function saveText(path: string, text: string, version: string | null): Promise<SaveResult> {
  try {
    const response = await fetch(`/api/files/raw?${query(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8", ...(version ? { "If-Match": version } : {}) },
      body: text,
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { version?: string | null } | null;
      return { kind: "conflict", version: body?.version ?? null };
    }
    if (response.status === 413) return { kind: "error", message: "The file is too large to save from here." };
    if (!response.ok) return { kind: "error", message: await errorOf(response, "Could not save. Try again.") };
    const body = (await response.json()) as { version: string };
    return { kind: "saved", version: body.version };
  } catch {
    return { kind: "error", message: "Could not reach the server. Your edits are still here." };
  }
}

let home: Promise<string | null> | null = null;

/** The host's home directory (the server's stat of `~`), asked once per page; null when it cannot say. */
export function homeDirectory(): Promise<string | null> {
  home ??= statFile("~").then(
    (result) => (result.kind === "ok" ? result.stat.path : null),
    () => null,
  );
  // A failure is not remembered: the next call asks again.
  void home.then((value) => {
    if (value === null) home = null;
  });
  return home;
}

// ---------------------------------------------------------------------------------------------
// Unsaved edits, by pane
// ---------------------------------------------------------------------------------------------

/** A pane's unsaved edits: the path, its text (read when needed, it is up to 2 MB), and the version they were made over. */
export type Draft = { path: string; text: () => string; version: () => string | null };

/**
 * The panes with unsaved edits. Set by `FilePane`, read before a close, and kept when the pane
 * unmounts: a layout change (a split, a collapse, a move between tabs' mounting) remounts it, and
 * the new mount takes them back (`paneDraft`). Gone once saved or discarded, or the pane closes.
 */
const dirtyPanes = new Map<string, Draft>();
/** The ids of `dirtyPanes`, a new set on every change (a `useSyncExternalStore` snapshot). */
let dirtySnapshot: ReadonlySet<string> = new Set();
const dirtyListeners = new Set<() => void>();

function dirtyChanged() {
  dirtySnapshot = new Set(dirtyPanes.keys());
  for (const listener of dirtyListeners) listener();
}

/** Record `paneId`'s unsaved edits, or (null) that it has none. */
export function setPaneDirty(paneId: string, draft: Draft | null): void {
  const held = dirtyPanes.get(paneId);
  if (draft === null) {
    if (dirtyPanes.delete(paneId)) dirtyChanged();
    return;
  }
  dirtyPanes.set(paneId, draft);
  if (held?.path !== draft.path) dirtyChanged();
}

/** The unsaved edits `paneId` held for `path` when it last unmounted, read now; null when none. */
export function paneDraft(paneId: string, path: string): { text: string; version: string | null } | null {
  const draft = dirtyPanes.get(paneId);
  return draft?.path === path ? { text: draft.text(), version: draft.version() } : null;
}

/** Drop the edits of panes no longer in the workspace (closed here, after `confirmDiscard`, or on another device). */
export function forgetClosedPanes(open: ReadonlySet<string>): void {
  let changed = false;
  for (const paneId of dirtyPanes.keys()) if (!open.has(paneId)) changed = dirtyPanes.delete(paneId) || changed;
  if (changed) dirtyChanged();
}

/** The panes holding unsaved edits: they stay mounted where they would otherwise unmount (a phone's other panes, a tab out of the mounted few). */
export function dirtyPaneIds(): ReadonlySet<string> {
  return dirtySnapshot;
}

export function subscribeDirty(listener: () => void): () => void {
  dirtyListeners.add(listener);
  return () => dirtyListeners.delete(listener);
}

/**
 * Whether closing (or rebuilding) `paneIds` may go ahead: true when none holds unsaved edits, else
 * the user's answer to "discard them?". Every way a pane of this device closes asks this first.
 */
export function confirmDiscard(paneIds: Iterable<string>): boolean {
  const paths = [...paneIds].flatMap((id) => (dirtyPanes.has(id) ? [dirtyPanes.get(id)!.path] : []));
  if (paths.length === 0) return true;
  const names = paths.map((path) => path.slice(path.lastIndexOf("/") + 1) || path);
  return window.confirm(`Discard unsaved changes to ${names.join(", ")}?`);
}

// ---------------------------------------------------------------------------------------------
// The line a pane scrolls to
// ---------------------------------------------------------------------------------------------

/** Lines asked for by path, until the pane showing that path takes them (it may not be mounted yet). */
const pendingLines = new Map<string, number>();
const lineListeners = new Set<(path: string) => void>();

/** Ask the pane showing `path` to scroll its editor to `line` (now if it is mounted, else when it mounts). */
export function requestLine(path: string, line: number): void {
  pendingLines.set(path, line);
  for (const listener of lineListeners) listener(path);
}

/** The line asked for `path`, once: taking it clears it. */
export function takeLine(path: string): number | null {
  const line = pendingLines.get(path) ?? null;
  pendingLines.delete(path);
  return line;
}

export function subscribeLines(listener: (path: string) => void): () => void {
  lineListeners.add(listener);
  return () => lineListeners.delete(listener);
}
