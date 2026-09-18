/**
 * Reduced transcripts kept across session switches. The pane for a session is remounted on every
 * switch; without this, each switch refetched and re-reduced the latest page. An entry holds the
 * reduced history plus the seq of the last event it contains, so a returning viewer renders at
 * once and follows the live stream from that cursor (the server replays what was missed, or asks
 * for a fresh page when the gap has aged out of memory).
 */
import { segment, type History } from "./transcript.ts";
import type { EventPage } from "./types.ts";

export type CachedHistory = {
  history: History;
  /** Seq of the newest event the history holds; the stream is opened with `?since=<cursor>`. */
  cursor: number;
};

export type HistoryCache = {
  get(id: string): CachedHistory | undefined;
  /** Replace an entry with the viewer's live copy; a load still in flight for `id` will not overwrite it. */
  set(id: string, entry: CachedHistory): void;
  delete(id: string): void;
  /**
   * The cached entry, else the result of one fetch shared by concurrent callers. `fresh` skips the
   * cache (the stream asked for a new page). Resolves null when the session no longer exists, which
   * also drops the entry. Rejects with the fetch's error.
   */
  load(id: string, options?: { fresh?: boolean }): Promise<CachedHistory | null>;
  /** Warm the cache ahead of a switch; a no-op when the entry exists or a load is in flight. Never rejects. */
  prefetch(id: string): void;
};

/** `fetchPage` resolves null for an unknown session and rejects on other failures. */
export function createHistoryCache(fetchPage: (id: string) => Promise<EventPage | null>): HistoryCache {
  const entries = new Map<string, CachedHistory>();
  const inflight = new Map<string, Promise<CachedHistory | null>>();
  /** Bumped by every load and `set`, so a load that finishes after a newer write leaves the entry alone. */
  const generation = new Map<string, number>();
  const bump = (id: string) => {
    const next = (generation.get(id) ?? 0) + 1;
    generation.set(id, next);
    return next;
  };

  const load: HistoryCache["load"] = (id, { fresh = false } = {}) => {
    if (!fresh) {
      const hit = entries.get(id);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.get(id);
      if (pending) return pending;
    }
    const gen = bump(id);
    const run = fetchPage(id).then((page) => {
      if (!page) {
        entries.delete(id);
        return null;
      }
      const entry: CachedHistory = { history: { turns: segment(page.events), hasMore: page.hasMore }, cursor: page.nextSeq - 1 };
      if (generation.get(id) === gen) entries.set(id, entry);
      return entry;
    }).finally(() => {
      if (inflight.get(id) === run) inflight.delete(id);
    });
    inflight.set(id, run);
    return run;
  };

  return {
    get: (id) => entries.get(id),
    set(id, entry) {
      bump(id);
      entries.set(id, entry);
    },
    delete(id) {
      bump(id);
      entries.delete(id);
    },
    load,
    prefetch(id) {
      if (entries.has(id) || inflight.has(id)) return;
      load(id).catch(() => {});
    },
  };
}
