import assert from "node:assert/strict";
import test from "node:test";
import { readTurnPage } from "../src/lib/session-pages.ts";
import { createMemorySessionStore } from "../src/lib/session-store.ts";

/** Turns of `sizes[i]` events each: a `user` event followed by updates and a `turn_end`. */
async function seed(sizes) {
  const store = createMemorySessionStore();
  await store.putSession({
    id: "s", agentId: "a", agentName: "A", cwd: "/", projectId: "", createdAt: 0, lastActiveAt: 0, title: null,
    upstreamId: "u", state: { modes: null, configOptions: [], commands: [] },
  });
  let seq = 0;
  const starts = [];
  for (const size of sizes) {
    starts.push(seq);
    await store.appendEvent("s", { seq: seq++, ts: 0, type: "user", text: `turn ${starts.length}` });
    for (let i = 0; i < size - 2; i++) {
      await store.appendEvent("s", { seq: seq++, ts: 0, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } });
    }
    await store.appendEvent("s", { seq: seq++, ts: 0, type: "turn_end", stopReason: "end_turn" });
  }
  return { store, starts, total: seq };
}

test("the latest page starts at a turn boundary and holds at least minEvents", async () => {
  const { store, starts, total } = await seed([10, 10, 10, 10]);
  const page = await readTurnPage(store, "s", { minEvents: 15 });
  assert.equal(page.events[0].seq, starts[2]);
  assert.equal(page.events.at(-1).seq, total - 1);
  assert.equal(page.events.length, 20);
  assert.equal(page.hasMore, true);
});

test("earlier pages end where the previous one began and the first page reports no more", async () => {
  const { store, starts } = await seed([10, 10, 10, 10]);
  const latest = await readTurnPage(store, "s", { minEvents: 15 });
  const older = await readTurnPage(store, "s", { before: latest.events[0].seq, minEvents: 15 });
  assert.equal(older.events[0].seq, starts[0]);
  assert.equal(older.events.at(-1).seq, latest.events[0].seq - 1);
  assert.equal(older.hasMore, false);
  assert.deepEqual(await readTurnPage(store, "s", { before: 0, minEvents: 15 }), { events: [], hasMore: false });
});

test("a turn longer than minEvents is returned whole rather than split", async () => {
  const { store, starts, total } = await seed([5, 400, 5]);
  const page = await readTurnPage(store, "s", { minEvents: 50 });
  assert.equal(page.events[0].seq, starts[1]);
  assert.equal(page.events.length, total - starts[1]);
  assert.equal(page.hasMore, true);
});

test("maxEvents caps a page that finds no turn boundary", async () => {
  const { store } = await seed([1000]);
  const page = await readTurnPage(store, "s", { before: 900, minEvents: 50, maxEvents: 300 });
  assert.equal(page.events.length >= 300, true);
  assert.equal(page.events.at(-1).seq, 899);
  assert.notEqual(page.events[0].type, "user");
  assert.equal(page.hasMore, true);
});

test("a log with no user events at all is served from its start", async () => {
  const store = createMemorySessionStore();
  await store.putSession({ id: "s", agentId: "a", agentName: "A", cwd: "/", projectId: "", createdAt: 0, lastActiveAt: 0, title: null, upstreamId: "u", state: { modes: null, configOptions: [], commands: [] } });
  await store.appendEvent("s", { seq: 0, ts: 0, type: "error", message: "boom" });
  assert.deepEqual(await readTurnPage(store, "s", { minEvents: 10 }), { events: [{ seq: 0, ts: 0, type: "error", message: "boom" }], hasMore: false });
  assert.deepEqual(await readTurnPage(store, "empty", { minEvents: 10 }), { events: [], hasMore: false });
});

test("a store that reports more but returns nothing ends the page instead of looping", async () => {
  const { store } = await seed([3]);
  const flaky = { ...store, readTail: async (id, query) => (query.beforeSeq === 0 || query.beforeSeq === undefined
    ? { events: [], hasMore: true }
    : store.readTail(id, query)) };
  assert.deepEqual(await readTurnPage(flaky, "s", { minEvents: 10 }), { events: [], hasMore: false });
  const page = await readTurnPage(flaky, "s", { before: 2, minEvents: 10 });
  assert.deepEqual(page.events.map(({ seq }) => seq), [0, 1]);
  assert.equal(page.hasMore, false);
});
