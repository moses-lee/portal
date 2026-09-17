import type { SessionStore } from "./session-store.ts";
import type { StoredEvent } from "./types.ts";

export type PageQuery = {
  /** Return events with `seq < before`; omit for the latest page. */
  before?: number;
  /** Grow the page until it holds at least this many events (or the log starts). */
  minEvents: number;
  /** Stop growing past this many events even without a turn boundary. */
  maxEvents?: number;
};

export type Page = { events: StoredEvent[]; hasMore: boolean };

const CHUNK = 200;

/**
 * Read a page that starts at a turn boundary (a `user` event) or at the log's start, so the
 * browser can reduce each page on its own: tool calls, permission prompts, and plans only ever
 * update events from the same turn. The page grows backwards until it holds `minEvents`.
 */
export async function readTurnPage(store: SessionStore, id: string, { before, minEvents, maxEvents = 5000 }: PageQuery): Promise<Page> {
  let events: StoredEvent[] = [];
  let cursor = before;
  for (;;) {
    const { events: chunk, hasMore } = await store.readTail(id, { beforeSeq: cursor, limit: Math.max(minEvents - events.length, CHUNK) });
    // An empty chunk means nothing readable is left, whatever the store says about `hasMore`.
    if (chunk.length === 0) return { events, hasMore: false };
    events = chunk.concat(events);
    // The latest turn start that still leaves at least `minEvents` on the page.
    for (let start = events.length - minEvents; start >= 0; start--) {
      if (events[start].type !== "user") continue;
      const page = events.slice(start);
      return { events: page, hasMore: page[0].seq > 0 };
    }
    if (!hasMore) return { events, hasMore: false };
    if (events.length >= maxEvents) return { events, hasMore: true };
    cursor = events[0].seq;
  }
}
