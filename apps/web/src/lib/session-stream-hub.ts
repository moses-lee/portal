/**
 * One stream for every session view on the page.
 *
 * Each view of a session (`useSessionStream`: a workspace pane, the tracked panel) follows the
 * session's events live. A browser allows six HTTP/1.1 connections per host and Portal runs on
 * plain HTTP, so a stream per view (a split of four panes, three more tabs kept mounted) would use
 * them all and every other request would wait. The hub holds one `EventSource` to
 * `/api/sessions/streams?ids=…&since=…` for the union of the subscribed sessions and hands each
 * frame to the session's subscribers; with the list and portal streams the page holds three
 * connections whatever the pane count.
 *
 * A subscription names the last seq its view holds. The stream reopens, once after a short
 * debounce (panes come and go together), whenever a view subscribes or a session loses its last
 * view, from each session's cursor: the server replays the gap, so nothing is lost across a
 * reopen, and a replay of what a view already holds is dropped by `appendEvent`. A dropped stream
 * is reopened with backoff. `EventSource`'s own retry is not used, as the query must carry the
 * current cursors; the hub closes a failed source and opens a new one. With no subscribers no
 * stream is held.
 */
import type { SessionMetaEvent, StreamedEvent } from "./types";

export const SESSION_STREAMS_URL = "/api/sessions/streams";
export const REOPEN_DEBOUNCE_MS = 50;
export const RETRY_MIN_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

export type SessionStreamHandlers = {
  /** One logged event after the cursor, with its seq; `event.ts` is the server's logged time. */
  onEvent: (seq: number, event: StreamedEvent) => void;
  /** The session's live state: on connect, and whenever it changes. */
  onMeta: (meta: Partial<SessionMetaEvent>) => void;
  /** The server no longer holds the events after the cursor: load a fresh page and subscribe again from it. */
  onReset: () => void;
  /** The session is gone (deleted, or unknown to the server); the subscription has ended. */
  onDeleted: () => void;
};

export type SessionStreamHub = {
  /**
   * Follow `sessionId` from `since` (the last seq the view holds, -1 for none). The replay comes
   * first, then the first `meta`, as a stream of the session's own would send them. Answers the
   * function that ends the subscription; calling it more than once is fine.
   */
  subscribe(sessionId: string, since: number, handlers: SessionStreamHandlers): () => void;
  /** Ends every subscription and closes the stream. The hub takes new subscriptions afterwards. */
  close(): void;
};

/** What the hub uses of `EventSource`; tests hand in a fake. */
export type StreamSource = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

export type SessionStreamHubOptions = {
  /** Opens the stream at `url`; `new EventSource(url)` by default. */
  open?: (url: string) => StreamSource;
  /** Runs `fn` after `ms` and answers its cancel; `setTimeout` by default. */
  schedule?: (fn: () => void, ms: number) => () => void;
  debounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
};

type Subscriber = { sessionId: string; cursor: number; handlers: SessionStreamHandlers };

/** The stream's URL for these sessions and cursors (ids URL-encoded; a UUID stays as it is). */
export function sessionStreamsUrl(cursors: ReadonlyMap<string, number>): string {
  const ids = [...cursors.keys()].map(encodeURIComponent);
  const since = [...cursors].map(([id, cursor]) => `${encodeURIComponent(id)}:${cursor}`);
  return `${SESSION_STREAMS_URL}?ids=${ids.join(",")}&since=${since.join(",")}`;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export function createSessionStreamHub({
  open = (url) => new EventSource(url),
  schedule = defaultSchedule,
  debounceMs = REOPEN_DEBOUNCE_MS,
  retryMinMs = RETRY_MIN_MS,
  retryMaxMs = RETRY_MAX_MS,
}: SessionStreamHubOptions = {}): SessionStreamHub {
  const subscribers = new Set<Subscriber>();
  let source: StreamSource | null = null;
  let cancelReopen: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryMs = retryMinMs;

  /** A snapshot, so a handler that unsubscribes (or subscribes) while frames are delivered is safe. */
  const viewsOf = (sessionId: string) => [...subscribers].filter((sub) => sub.sessionId === sessionId);
  /** Each subscribed session with the oldest cursor among its views, so every view gets its gap replayed. */
  const wanted = () => {
    const cursors = new Map<string, number>();
    for (const { sessionId, cursor } of subscribers) {
      const held = cursors.get(sessionId);
      cursors.set(sessionId, held === undefined ? cursor : Math.min(held, cursor));
    }
    return cursors;
  };
  const closeSource = () => {
    source?.close();
    source = null;
  };
  /** The frame's JSON object with its `sessionId`, or null for anything else. */
  const parse = (event: Event): (Record<string, unknown> & { sessionId: string }) | null => {
    try {
      const data = JSON.parse((event as MessageEvent<string>).data) as unknown;
      if (!data || typeof data !== "object" || typeof (data as { sessionId?: unknown }).sessionId !== "string") return null;
      return data as Record<string, unknown> & { sessionId: string };
    } catch {
      return null;
    }
  };

  const connect = () => {
    cancelRetry?.();
    cancelRetry = null;
    closeSource();
    const cursors = wanted();
    if (cursors.size === 0) return;
    const mine = open(sessionStreamsUrl(cursors));
    source = mine;
    const live = () => source === mine;
    mine.addEventListener("open", () => {
      if (live()) retryMs = retryMinMs;
    });
    mine.addEventListener("message", (e) => {
      const data = live() ? parse(e) : null;
      if (!data) return;
      const { sessionId, seq, ...event } = data;
      if (typeof seq !== "number") return;
      for (const sub of viewsOf(sessionId)) {
        sub.cursor = Math.max(sub.cursor, seq);
        sub.handlers.onEvent(seq, event as StreamedEvent);
      }
    });
    mine.addEventListener("meta", (e) => {
      const data = live() ? parse(e) : null;
      if (!data) return;
      const { sessionId, ...meta } = data;
      for (const sub of viewsOf(sessionId)) sub.handlers.onMeta(meta as Partial<SessionMetaEvent>);
    });
    mine.addEventListener("reset", (e) => {
      const data = live() ? parse(e) : null;
      if (!data) return;
      for (const sub of viewsOf(data.sessionId)) sub.handlers.onReset();
    });
    mine.addEventListener("deleted", (e) => {
      const data = live() ? parse(e) : null;
      if (!data) return;
      // The server has dropped the session from the stream already; its views end here.
      const gone = viewsOf(data.sessionId);
      for (const sub of gone) subscribers.delete(sub);
      for (const sub of gone) sub.handlers.onDeleted();
      if (subscribers.size === 0) closeSource();
    });
    mine.addEventListener("error", () => {
      if (!live()) return;
      closeSource();
      if (subscribers.size === 0) return;
      cancelRetry = schedule(() => {
        cancelRetry = null;
        connect();
      }, retryMs);
      retryMs = Math.min(retryMaxMs, retryMs * 2);
    });
  };
  const requestReopen = () => {
    if (cancelReopen) return;
    cancelReopen = schedule(() => {
      cancelReopen = null;
      connect();
    }, debounceMs);
  };

  return {
    subscribe(sessionId, since, handlers) {
      const sub: Subscriber = { sessionId, cursor: since, handlers };
      subscribers.add(sub);
      // A new view needs its replay and first `meta`, which the server sends on connect: the
      // stream reopens even when another view already has the session on it.
      requestReopen();
      return () => {
        if (!subscribers.delete(sub)) return;
        // Another view keeps the session on the stream; the last one leaving drops it from the query.
        if (viewsOf(sessionId).length === 0) requestReopen();
      };
    },
    close() {
      cancelReopen?.();
      cancelReopen = null;
      cancelRetry?.();
      cancelRetry = null;
      subscribers.clear();
      closeSource();
    },
  };
}
