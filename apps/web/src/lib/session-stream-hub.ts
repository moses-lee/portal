/**
 * One stream for every session view on the page.
 *
 * Each view of a session (`useSessionStream`: a workspace pane, the tracked panel) follows the
 * session's events live. A browser allows six HTTP/1.1 connections per host and Portal runs on
 * plain HTTP, so a stream per view (a split of four panes, three more tabs kept mounted) would use
 * them all and every other request would wait. The hub holds one `EventSource` to
 * `/api/sessions/streams?ids=…&since=…&attach=…` for the union of the subscribed sessions and hands
 * each frame to the session's subscribers; with the list and portal streams the page holds three
 * connections whatever the pane count.
 *
 * A subscription names the last seq its view holds. The stream reopens, once after a debounce
 * (panes come and go together; a view joining an open stream waits longer, so a page's panes
 * subscribing as their history pages load share one reopen), whenever a view subscribes or a
 * session loses its last view, from each session's oldest cursor: the server replays the gap, so
 * nothing is lost across a reopen. The replay serves the view furthest behind; each view is
 * handed only the events past its own cursor, so a view never sees an event twice however often
 * the stream reopens (`appendEvent` drops a held event too, as a second guard). The query's
 * `attach` lists the sessions the stream did not carry before: the server reattaches those
 * agents (a session persisted by an earlier run) and only those, so a reopen for one new pane
 * does not re-announce every other session. A dropped stream is reopened with backoff and
 * reintroduces every session, as the server may have restarted. `EventSource`'s own retry is not
 * used, as the query must carry the current cursors; the hub closes a failed source and opens a
 * new one. With no subscribers no stream is held.
 *
 * The server carries at most `STREAM_IDS_MAX` sessions on one socket. The hub keeps that many,
 * in order of first subscription; a session past the cap waits, its views silent, and joins the
 * stream as others leave.
 */
import { STREAM_IDS_MAX } from "@portal/contracts/types";
import type { SessionMetaEvent, StreamedEvent } from "./types";

export { STREAM_IDS_MAX };
export const SESSION_STREAMS_URL = "/api/sessions/streams";
/** The debounce before a reopen: for the first stream, and after a session leaves it. */
export const REOPEN_DEBOUNCE_MS = 50;
/** The debounce before a reopen for a view joining an open stream (see the header). */
export const JOIN_DEBOUNCE_MS = 250;
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
  joinDebounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
};

type Subscriber = {
  sessionId: string;
  /** The last seq this view holds; only events past it are delivered. */
  cursor: number;
  /** True until a stream has opened with this view's session: it still needs its replay and first `meta`. */
  fresh: boolean;
  handlers: SessionStreamHandlers;
};

/**
 * The stream's URL for these sessions and cursors (ids URL-encoded; a UUID stays as it is), with
 * `attach` naming the sessions whose agent the server should reattach (every one by default).
 */
export function sessionStreamsUrl(cursors: ReadonlyMap<string, number>, attach: Iterable<string> = cursors.keys()): string {
  const ids = [...cursors.keys()].map(encodeURIComponent);
  const since = [...cursors].map(([id, cursor]) => `${encodeURIComponent(id)}:${cursor}`);
  const attached = [...attach].map(encodeURIComponent);
  return `${SESSION_STREAMS_URL}?ids=${ids.join(",")}&since=${since.join(",")}&attach=${attached.join(",")}`;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export function createSessionStreamHub({
  open = (url) => new EventSource(url),
  schedule = defaultSchedule,
  debounceMs = REOPEN_DEBOUNCE_MS,
  joinDebounceMs = JOIN_DEBOUNCE_MS,
  retryMinMs = RETRY_MIN_MS,
  retryMaxMs = RETRY_MAX_MS,
}: SessionStreamHubOptions = {}): SessionStreamHub {
  const subscribers = new Set<Subscriber>();
  let source: StreamSource | null = null;
  /** The sessions the open stream carries (those the server has introduced to it); empty with no stream. */
  let streamed = new Set<string>();
  let cancelReopen: (() => void) | null = null;
  let reopenMs = Infinity;
  let cancelRetry: (() => void) | null = null;
  let retryMs = retryMinMs;

  /** A snapshot, so a handler that unsubscribes (or subscribes) while frames are delivered is safe. */
  const viewsOf = (sessionId: string) => [...subscribers].filter((sub) => sub.sessionId === sessionId);
  /**
   * The sessions the stream should carry, in order of first subscription and at most
   * `STREAM_IDS_MAX` (the rest wait), each with the oldest cursor among its views so every view
   * gets its gap replayed.
   */
  const wanted = () => {
    const cursors = new Map<string, number>();
    for (const { sessionId, cursor } of subscribers) {
      const held = cursors.get(sessionId);
      if (held !== undefined) cursors.set(sessionId, Math.min(held, cursor));
      else if (cursors.size < STREAM_IDS_MAX) cursors.set(sessionId, cursor);
    }
    return cursors;
  };
  const closeSource = () => {
    source?.close();
    source = null;
    streamed = new Set();
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
    const cursors = wanted();
    if (cursors.size === 0) {
      closeSource();
      return;
    }
    const views = [...subscribers].filter((sub) => cursors.has(sub.sessionId));
    // The open stream already carries these sessions and every view has had its replay: nothing to do.
    const carried = source !== null && cursors.size === streamed.size && [...cursors.keys()].every((id) => streamed.has(id));
    if (carried && views.every((sub) => !sub.fresh)) return;
    const attach = [...cursors.keys()].filter((id) => !streamed.has(id));
    closeSource();
    streamed = new Set(cursors.keys());
    for (const sub of views) sub.fresh = false;
    const mine = open(sessionStreamsUrl(cursors, attach));
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
        // The replay serves the view furthest behind; the others already hold its start.
        if (seq <= sub.cursor) continue;
        sub.handlers.onEvent(seq, event as StreamedEvent);
        sub.cursor = seq;
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
      streamed.delete(data.sessionId);
      const gone = viewsOf(data.sessionId);
      for (const sub of gone) subscribers.delete(sub);
      for (const sub of gone) sub.handlers.onDeleted();
      if (subscribers.size === 0) closeSource();
    });
    mine.addEventListener("error", () => {
      if (!live()) return;
      // The server may have restarted: the retry introduces every session again.
      closeSource();
      if (subscribers.size === 0) return;
      cancelRetry = schedule(() => {
        cancelRetry = null;
        connect();
      }, retryMs);
      retryMs = Math.min(retryMaxMs, retryMs * 2);
    });
  };
  /** Reopen after `ms`; a reopen already due sooner stands. */
  const requestReopen = (ms: number) => {
    if (cancelReopen && reopenMs <= ms) return;
    cancelReopen?.();
    reopenMs = ms;
    cancelReopen = schedule(() => {
      cancelReopen = null;
      reopenMs = Infinity;
      connect();
    }, ms);
  };

  return {
    subscribe(sessionId, since, handlers) {
      const sub: Subscriber = { sessionId, cursor: since, fresh: true, handlers };
      subscribers.add(sub);
      // A new view needs its replay and first `meta`, which the server sends on connect: the
      // stream reopens even when another view already has the session on it.
      requestReopen(source ? joinDebounceMs : debounceMs);
      return () => {
        if (!subscribers.delete(sub)) return;
        // Another view keeps the session on the stream; the last one leaving drops it from the query.
        if (viewsOf(sessionId).length === 0) requestReopen(debounceMs);
      };
    },
    close() {
      cancelReopen?.();
      cancelReopen = null;
      reopenMs = Infinity;
      cancelRetry?.();
      cancelRetry = null;
      subscribers.clear();
      closeSource();
    },
  };
}
