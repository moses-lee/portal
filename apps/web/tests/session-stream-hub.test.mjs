import assert from "node:assert/strict";
import test from "node:test";
import { createSessionStreamHub, sessionStreamsUrl, STREAM_IDS_MAX } from "../src/lib/session-stream-hub.ts";

/** Timers under the test's control: `advance(ms)` runs what falls due, in order. */
function clock() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    get pending() { return timers.size; },
  };
}

/** A fake `EventSource`: records its URL, takes listeners, and lets the test push frames. */
function fakeSources() {
  const opened = [];
  const open = (url) => {
    const listeners = new Map();
    const source = {
      url,
      closed: false,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() { source.closed = true; },
      emit(type, data) {
        for (const listener of listeners.get(type) ?? []) listener(data === undefined ? {} : { data: JSON.stringify(data) });
      },
    };
    opened.push(source);
    return source;
  };
  return { opened, open, get last() { return opened.at(-1); } };
}

function recorder() {
  const calls = [];
  return {
    calls,
    handlers: {
      onEvent: (seq, event) => calls.push(["event", seq, event]),
      onMeta: (meta) => calls.push(["meta", meta]),
      onReset: () => calls.push(["reset"]),
      onDeleted: () => calls.push(["deleted"]),
    },
  };
}

/** A hub on fake timers and sources; the join debounce equals the plain one unless a test cares. */
function setup({ joinDebounceMs = 50 } = {}) {
  const timers = clock();
  const sources = fakeSources();
  const hub = createSessionStreamHub({ open: sources.open, schedule: timers.schedule, debounceMs: 50, joinDebounceMs, retryMinMs: 1000, retryMaxMs: 4000 });
  return { timers, sources, hub };
}

/** The `ids`, `since` and `attach` lists of a stream URL. */
function query(url) {
  const params = new URL(url, "http://portal.invalid").searchParams;
  const list = (name) => (params.get(name) ?? "").split(",").filter(Boolean);
  return { ids: list("ids"), since: list("since"), attach: list("attach") };
}

test("the stream URL names every session and its cursor, ids encoded, and the sessions to attach (all by default)", () => {
  assert.equal(sessionStreamsUrl(new Map([["a", -1], ["b", 12]])), "/api/sessions/streams?ids=a,b&since=a:-1,b:12&attach=a,b");
  assert.equal(sessionStreamsUrl(new Map([["a", -1], ["b", 12]]), ["b"]), "/api/sessions/streams?ids=a,b&since=a:-1,b:12&attach=b");
  assert.equal(sessionStreamsUrl(new Map([["a", 1]]), []), "/api/sessions/streams?ids=a&since=a:1&attach=");
  assert.equal(sessionStreamsUrl(new Map([["x/y z", 3]])), "/api/sessions/streams?ids=x%2Fy%20z&since=x%2Fy%20z:3&attach=x%2Fy%20z");
});

test("subscriptions share one stream: opened once after the debounce for the union of sessions, each frame routed to its session's views", () => {
  const { timers, sources, hub } = setup();
  const a = recorder();
  const b = recorder();
  hub.subscribe("a", 4, a.handlers);
  hub.subscribe("b", -1, b.handlers);
  assert.equal(sources.opened.length, 0, "nothing opens before the debounce");
  timers.advance(50);
  assert.equal(sources.opened.length, 1, "one stream for both");
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a,b&since=a:4,b:-1&attach=a,b");

  sources.last.emit("message", { sessionId: "a", seq: 5, type: "user", text: "hi", ts: 7 });
  sources.last.emit("meta", { sessionId: "b", busy: true, queue: [] });
  sources.last.emit("reset", { sessionId: "b" });
  sources.last.emit("message", { sessionId: "c", seq: 1, type: "turn_start", ts: 1 });
  assert.deepEqual(a.calls, [["event", 5, { type: "user", text: "hi", ts: 7 }]]);
  assert.deepEqual(b.calls, [["meta", { busy: true, queue: [] }], ["reset"]]);

  // Malformed frames are ignored.
  for (const listener of ["message", "meta"]) sources.last.emit(listener, "not an object");
  sources.last.emit("message", { seq: 9, type: "turn_end" });
  sources.last.emit("message", { sessionId: "a", type: "turn_end" });
  assert.equal(a.calls.length, 1);
});

test("the set changing reopens once with the current cursors; the last view of a session leaving drops it; no subscribers, no stream", () => {
  const { timers, sources, hub } = setup();
  const a = recorder();
  const b = recorder();
  const offA = hub.subscribe("a", 4, a.handlers);
  timers.advance(50);
  sources.last.emit("message", { sessionId: "a", seq: 9, type: "turn_end", ts: 1 });
  const first = sources.last;

  const offB = hub.subscribe("b", 2, b.handlers);
  timers.advance(49);
  assert.equal(sources.opened.length, 1, "still debouncing");
  timers.advance(1);
  assert.equal(sources.opened.length, 2);
  assert.ok(first.closed, "the old stream is closed when the new one opens");
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a,b&since=a:9,b:2&attach=b", "a's cursor advanced to the newest seq delivered; only b is new");

  offA();
  timers.advance(50);
  assert.equal(sources.opened.length, 3);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=b&since=b:2&attach=");
  offA();
  timers.advance(50);
  assert.equal(sources.opened.length, 3, "unsubscribing twice does nothing");

  offB();
  timers.advance(50);
  assert.ok(sources.last.closed, "the last view leaving closes the stream");
  assert.equal(sources.opened.length, 3, "nothing reopens for an empty set");
  assert.equal(timers.pending, 0);
});

test("two views of one session: the second reopens (it needs its replay and meta) from the older cursor; one leaving keeps the stream; deleted ends both", () => {
  const { timers, sources, hub } = setup();
  const one = recorder();
  const two = recorder();
  const offOne = hub.subscribe("a", 10, one.handlers);
  timers.advance(50);
  sources.last.emit("message", { sessionId: "a", seq: 12, type: "turn_end", ts: 1 });

  hub.subscribe("a", 3, two.handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 2);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a&since=a:3&attach=", "a is on the stream already: not attached again");
  sources.last.emit("message", { sessionId: "a", seq: 13, type: "turn_start", ts: 2 });
  assert.equal(one.calls.length, 2);
  assert.equal(two.calls.length, 1);

  offOne();
  timers.advance(50);
  assert.equal(sources.opened.length, 2, "another view keeps the session on the stream");
  assert.ok(!sources.last.closed);

  const offThree = hub.subscribe("a", 13, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 3);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a&since=a:13&attach=", "every view's cursor is past 13 now");

  sources.last.emit("deleted", { sessionId: "a" });
  assert.deepEqual(two.calls.at(-1), ["deleted"]);
  assert.deepEqual(one.calls.filter(([kind]) => kind === "deleted"), [], "a view that left is not told");
  assert.ok(sources.last.closed, "no view left: the stream closes");
  offThree();
  timers.advance(50);
  assert.equal(sources.opened.length, 3, "unsubscribing after deleted reopens nothing");
});

test("a replay reaches only the views behind it: each view gets the events past its own cursor, once", () => {
  const { timers, sources, hub } = setup();
  const pane = recorder();
  const panel = recorder();
  hub.subscribe("a", 500, pane.handlers);
  timers.advance(50);
  // The tracked panel opens the same session from an older cache entry: the stream reopens from 498.
  hub.subscribe("a", 498, panel.handlers);
  timers.advance(50);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a&since=a:498&attach=");
  for (const seq of [499, 500]) sources.last.emit("message", { sessionId: "a", seq, type: "turn_start", ts: seq });
  assert.deepEqual(pane.calls, [], "the pane holds 499 and 500 already");
  assert.deepEqual(panel.calls.map(([, seq]) => seq), [499, 500]);
  sources.last.emit("meta", { sessionId: "a", busy: false, queue: [] });
  assert.deepEqual(pane.calls, [["meta", { busy: false, queue: [] }]], "meta reaches every view");
  sources.last.emit("message", { sessionId: "a", seq: 501, type: "turn_end", ts: 501 });
  assert.deepEqual(pane.calls.at(-1), ["event", 501, { type: "turn_end", ts: 501 }]);
  assert.deepEqual(panel.calls.at(-1), ["event", 501, { type: "turn_end", ts: 501 }]);
  sources.last.emit("message", { sessionId: "a", seq: 501, type: "turn_end", ts: 501 });
  assert.equal(pane.calls.length, 2, "a seq delivered once is not delivered again");
  assert.equal(panel.calls.length, 4);

  // Both views are at 501: the next reopen starts there.
  hub.subscribe("b", -1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a,b&since=a:501,b:-1&attach=b");
});

test("attach names the sessions new to the stream: not one already on it, a session that left and returns, and every session after a dropped stream", () => {
  const { timers, sources, hub } = setup();
  const offA = hub.subscribe("a", 1, recorder().handlers);
  timers.advance(50);
  assert.deepEqual(query(sources.last.url).attach, ["a"]);

  const offB1 = hub.subscribe("b", 1, recorder().handlers);
  timers.advance(50);
  assert.deepEqual(query(sources.last.url), { ids: ["a", "b"], since: ["a:1", "b:1"], attach: ["b"] });

  hub.subscribe("a", 1, recorder().handlers);
  timers.advance(50);
  assert.deepEqual(query(sources.last.url).attach, [], "a second view of a session on the stream attaches nothing");

  offA();
  timers.advance(50);
  assert.deepEqual(query(sources.last.url).attach, [], "a session another view keeps needs no reopen");
  assert.equal(sources.opened.length, 3);

  // c comes and goes while a reopen is pending: the reopen finds nothing changed and keeps the stream.
  hub.subscribe("c", 1, recorder().handlers)();
  timers.advance(50);
  assert.equal(sources.opened.length, 3, "nothing to reopen for");

  // A session dropped from the stream (its last view left) is introduced again when it returns.
  const offB2 = hub.subscribe("b", 5, recorder().handlers);
  timers.advance(50);
  assert.deepEqual(query(sources.last.url).attach, [], "b is on the stream already");
  offB1();
  timers.advance(50);
  assert.equal(sources.opened.length, 4, "the other view keeps b on the stream");
  offB2();
  timers.advance(50);
  assert.deepEqual(query(sources.last.url).ids, ["a"]);
  hub.subscribe("b", 5, recorder().handlers);
  timers.advance(50);
  assert.deepEqual(query(sources.last.url), { ids: ["a", "b"], since: ["a:1", "b:5"], attach: ["b"] });

  // The stream drops: the server may have restarted, so the retry attaches every session.
  sources.last.emit("error");
  timers.advance(1000);
  assert.deepEqual(query(sources.last.url).attach, ["a", "b"]);
  sources.last.emit("deleted", { sessionId: "a" });
  hub.subscribe("d", -1, recorder().handlers);
  timers.advance(50);
  assert.deepEqual(query(sources.last.url), { ids: ["b", "d"], since: ["b:5", "d:-1"], attach: ["d"] });
});

test("a view joining an open stream waits the join debounce, so a page's panes share one reopen; a reopen due sooner stands", () => {
  const { timers, sources, hub } = setup({ joinDebounceMs: 250 });
  const offA = hub.subscribe("a", 1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 1, "the first stream opens after the short debounce");

  hub.subscribe("b", 1, recorder().handlers);
  timers.advance(100);
  hub.subscribe("c", 1, recorder().handlers);
  timers.advance(149);
  assert.equal(sources.opened.length, 1, "joins wait");
  timers.advance(1);
  assert.equal(sources.opened.length, 2, "one reopen for both at 250 ms after the first join");
  assert.deepEqual(query(sources.last.url), { ids: ["a", "b", "c"], since: ["a:1", "b:1", "c:1"], attach: ["b", "c"] });

  // A session leaving brings the reopen forward; a join after it does not push it back.
  hub.subscribe("d", 1, recorder().handlers);
  timers.advance(100);
  offA();
  hub.subscribe("e", 1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 3);
  assert.deepEqual(query(sources.last.url), { ids: ["b", "c", "d", "e"], since: ["b:1", "c:1", "d:1", "e:1"], attach: ["d", "e"] });
  timers.advance(1000);
  assert.equal(sources.opened.length, 3, "the longer reopen was folded into the sooner one");

  // With the stream down (a retry pending) a subscription reconnects after the short debounce.
  sources.last.emit("error");
  hub.subscribe("f", 1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 4);
  assert.equal(timers.pending, 0, "the retry was dropped");
});

test(`at most ${STREAM_IDS_MAX} sessions ride the stream, oldest subscriptions first; the rest wait and join as others leave`, () => {
  assert.equal(STREAM_IDS_MAX, 32, "mirrors the server's cap");
  const { timers, sources, hub } = setup();
  const ids = Array.from({ length: STREAM_IDS_MAX + 1 }, (_, i) => `s${i}`);
  const offs = ids.slice(0, STREAM_IDS_MAX).map((id) => hub.subscribe(id, 1, recorder().handlers));
  timers.advance(50);
  assert.equal(query(sources.last.url).ids.length, STREAM_IDS_MAX);

  const waiting = recorder();
  const offWaiting = hub.subscribe(ids[STREAM_IDS_MAX], 1, waiting.handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 1, "a session past the cap reopens nothing");
  assert.ok(!sources.last.closed);
  hub.subscribe(ids[1], 1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 2, "a second view of a carried session reopens as usual");
  assert.equal(query(sources.last.url).ids.length, STREAM_IDS_MAX);
  assert.ok(!query(sources.last.url).ids.includes(ids[STREAM_IDS_MAX]), "the waiting session is still off the stream");

  offs[0]();
  timers.advance(50);
  assert.equal(sources.opened.length, 3);
  assert.deepEqual(query(sources.last.url).ids, ids.slice(1), "the first session left; the waiting one joins at the end");
  assert.deepEqual(query(sources.last.url).attach, [ids[STREAM_IDS_MAX]], "and is attached as a new session");
  sources.last.emit("message", { sessionId: ids[STREAM_IDS_MAX], seq: 2, type: "turn_start", ts: 1 });
  assert.equal(waiting.calls.length, 1);

  offWaiting();
  timers.advance(50);
  assert.deepEqual(query(sources.last.url).ids, ids.slice(1, STREAM_IDS_MAX));
});

test("a deleted session leaves the others on the stream, and a reopen omits it", () => {
  const { timers, sources, hub } = setup();
  const a = recorder();
  const b = recorder();
  hub.subscribe("a", 1, a.handlers);
  hub.subscribe("b", 1, b.handlers);
  timers.advance(50);
  sources.last.emit("deleted", { sessionId: "a" });
  assert.deepEqual(a.calls, [["deleted"]]);
  assert.deepEqual(b.calls, []);
  assert.ok(!sources.last.closed);
  sources.last.emit("message", { sessionId: "b", seq: 2, type: "turn_end", ts: 1 });
  assert.equal(b.calls.length, 1);
  hub.subscribe("c", -1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=b,c&since=b:2,c:-1&attach=c");
});

test("a dropped stream is reopened with backoff from the cursors reached, the backoff resets once a stream opens, and nothing retries without subscribers", () => {
  const { timers, sources, hub } = setup();
  const a = recorder();
  const off = hub.subscribe("a", 0, a.handlers);
  timers.advance(50);
  sources.last.emit("open");
  sources.last.emit("message", { sessionId: "a", seq: 3, type: "turn_end", ts: 1 });

  sources.last.emit("error");
  assert.ok(sources.last.closed, "a failed source is closed rather than left to the browser's retry");
  timers.advance(999);
  assert.equal(sources.opened.length, 1);
  timers.advance(1);
  assert.equal(sources.opened.length, 2);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a&since=a:3&attach=a");
  sources.last.emit("error");
  timers.advance(2000);
  assert.equal(sources.opened.length, 3, "second retry after 2 s");
  sources.last.emit("error");
  timers.advance(4000);
  assert.equal(sources.opened.length, 4, "third after 4 s");
  sources.last.emit("error");
  timers.advance(4000);
  assert.equal(sources.opened.length, 5, "capped at 4 s");
  sources.last.emit("open");
  sources.last.emit("error");
  timers.advance(1000);
  assert.equal(sources.opened.length, 6, "back to 1 s after a stream opened");

  // A stale source's events are ignored once it has been replaced.
  sources.opened[0].emit("message", { sessionId: "a", seq: 4, type: "turn_start", ts: 1 });
  sources.opened[0].emit("error");
  assert.equal(a.calls.length, 1);
  assert.equal(timers.pending, 0);

  // A set change while a retry is pending reconnects at once and drops the retry.
  sources.last.emit("error");
  hub.subscribe("b", -1, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 7);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=a,b&since=a:3,b:-1&attach=a,b");
  timers.advance(10_000);
  assert.equal(sources.opened.length, 7, "the pending retry was cancelled");

  off();
  hub.close();
  assert.ok(sources.last.closed);
  sources.last.emit("error");
  timers.advance(10_000);
  assert.equal(sources.opened.length, 7, "no subscribers, no retry");
});

test("close ends every subscription and the stream; the hub takes new subscriptions afterwards", () => {
  const { timers, sources, hub } = setup();
  const a = recorder();
  hub.subscribe("a", 0, a.handlers);
  timers.advance(50);
  hub.close();
  assert.ok(sources.last.closed);
  sources.last.emit("message", { sessionId: "a", seq: 1, type: "turn_start", ts: 1 });
  assert.deepEqual(a.calls, []);

  hub.subscribe("b", 5, recorder().handlers);
  timers.advance(50);
  assert.equal(sources.opened.length, 2);
  assert.equal(sources.last.url, "/api/sessions/streams?ids=b&since=b:5&attach=b");
});
