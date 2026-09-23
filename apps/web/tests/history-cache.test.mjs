import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryCache } from "../src/lib/history-cache.ts";

const page = (turnStart, count) => ({
  events: [
    { seq: turnStart, ts: 0, type: "user", text: `turn at ${turnStart}` },
    ...Array.from({ length: count - 1 }, (_, i) => ({ seq: turnStart + 1 + i, ts: 0, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } })),
  ],
  hasMore: turnStart > 0,
  nextSeq: turnStart + count,
});

/** A fetcher whose calls are counted and whose responses can be held back. */
function fetcher(responses) {
  const calls = [];
  const fetchPage = (id) => {
    calls.push(id);
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === "function") return next();
    return Promise.resolve(next);
  };
  return { fetchPage, calls };
}

test("load reduces the page, caches it, and serves the next load from memory", async () => {
  const { fetchPage, calls } = fetcher([page(10, 5)]);
  const cache = createHistoryCache(fetchPage);
  const entry = await cache.load("s");
  assert.equal(entry.cursor, 14);
  assert.equal(entry.history.hasMore, true);
  assert.deepEqual(entry.history.turns.map((t) => t.key), [10]);
  assert.deepEqual(entry.history.turns[0].blocks.map((b) => b.kind), ["user", "assistant"]);
  assert.equal(await cache.load("s"), entry);
  assert.equal(cache.get("s"), entry);
  assert.deepEqual(calls, ["s"]);
});

test("concurrent loads and prefetches share one fetch", async () => {
  let release;
  const { fetchPage, calls } = fetcher([() => new Promise((r) => { release = r; })]);
  const cache = createHistoryCache(fetchPage);
  cache.prefetch("s");
  cache.prefetch("s");
  const a = cache.load("s");
  const b = cache.load("s");
  release(page(0, 3));
  assert.equal(await a, await b);
  assert.deepEqual(calls, ["s"]);
  cache.prefetch("s");
  assert.deepEqual(calls, ["s"]);
});

test("a fresh load bypasses the cache and replaces the entry", async () => {
  const { fetchPage, calls } = fetcher([page(0, 3), page(3, 4)]);
  const cache = createHistoryCache(fetchPage);
  const first = await cache.load("s");
  const second = await cache.load("s", { fresh: true });
  assert.notEqual(first, second);
  assert.equal(second.cursor, 6);
  assert.equal(cache.get("s"), second);
  assert.deepEqual(calls, ["s", "s"]);
});

test("a load that finishes after a newer set or delete leaves the cache alone", async () => {
  let release;
  const { fetchPage } = fetcher([() => new Promise((r) => { release = r; }), page(0, 3)]);
  const cache = createHistoryCache(fetchPage);
  const stale = cache.load("s");
  const live = { history: { turns: [], hasMore: false }, cursor: 99 };
  cache.set("s", live);
  release(page(0, 3));
  await stale;
  assert.equal(cache.get("s"), live);
  const stale2 = cache.load("s", { fresh: true });
  cache.delete("s");
  await stale2;
  assert.equal(cache.get("s"), undefined);
});

test("an unknown session resolves null and drops any entry; failures reject but prefetch swallows them", async () => {
  const { fetchPage } = fetcher([page(0, 2), null, new Error("boom"), new Error("boom")]);
  const cache = createHistoryCache(fetchPage);
  await cache.load("s");
  assert.equal(await cache.load("s", { fresh: true }), null);
  assert.equal(cache.get("s"), undefined);
  await assert.rejects(cache.load("s"), /boom/);
  cache.prefetch("s");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cache.get("s"), undefined);
});
