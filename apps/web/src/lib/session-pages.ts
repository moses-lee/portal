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

/** `update` events whose content can be concatenated: adjacent ones of the same kind merge into one. */
type TextChunkEvent = StoredEvent & {
  type: "update";
  update: { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk"; content: { type: "text"; text: string } };
};

function isTextChunk(event: StoredEvent): event is TextChunkEvent {
  if (event.type !== "update") return false;
  const { sessionUpdate, content } = event.update as { sessionUpdate: string; content?: { type?: string; text?: unknown } };
  return (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk")
    && content?.type === "text" && typeof content.text === "string";
}

/**
 * Merge each run of adjacent text chunks of the same kind into one event, keeping the first
 * chunk's seq and timestamp. Agents stream a few characters per chunk, so a page of raw events is
 * mostly envelope; viewers concatenate adjacent chunks anyway. Cursors are unaffected: a page
 * always starts with a `user` event, and the stream tail is followed from `nextSeq`, not from the
 * seq of the page's last event.
 */
export function coalesceTextChunks(events: StoredEvent[]): StoredEvent[] {
  const merged: StoredEvent[] = [];
  let run: TextChunkEvent | null = null;
  let text = "";
  const flush = () => {
    if (!run) return;
    merged.push({ ...run, update: { ...run.update, content: { ...run.update.content, text } } });
    run = null;
  };
  for (const event of events) {
    if (isTextChunk(event)) {
      if (run && run.update.sessionUpdate === event.update.sessionUpdate) {
        text += event.update.content.text;
        continue;
      }
      flush();
      run = event;
      text = event.update.content.text;
      continue;
    }
    flush();
    merged.push(event);
  }
  flush();
  return merged;
}
