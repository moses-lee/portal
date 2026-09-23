import assert from "node:assert/strict";
import test from "node:test";
import { coalesceTextChunks, readTurnPage } from "../src/lib/session-pages.ts";
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

const chunk = (seq, kind, text) => ({ seq, ts: seq * 10, type: "update", update: { sessionUpdate: kind, content: { type: "text", text } } });

test("adjacent text chunks of one kind merge into one event that keeps the first seq", () => {
  const events = [
    { seq: 0, ts: 0, type: "user", text: "hi" },
    chunk(1, "agent_thought_chunk", "th"), chunk(2, "agent_thought_chunk", "ink"),
    chunk(3, "agent_message_chunk", "Hel"), chunk(4, "agent_message_chunk", "lo"), chunk(5, "agent_message_chunk", "!"),
    { seq: 6, ts: 60, type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t", title: "ls", status: "completed" } },
    chunk(7, "agent_message_chunk", "done"),
    { seq: 8, ts: 80, type: "turn_end", stopReason: "end_turn" },
  ];
  const merged = coalesceTextChunks(events);
  assert.deepEqual(merged.map((e) => e.seq), [0, 1, 3, 6, 7, 8]);
  assert.deepEqual(merged[1], chunk(1, "agent_thought_chunk", "think"));
  assert.deepEqual(merged[2], chunk(3, "agent_message_chunk", "Hello!"));
  assert.deepEqual(merged[4], chunk(7, "agent_message_chunk", "done"));
  assert.deepEqual(merged[3], events[6]);
  // The input is left alone.
  assert.equal(events[3].update.content.text, "Hel");
});

test("non-text chunks and other updates are passed through untouched", () => {
  const image = { seq: 1, ts: 0, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…", mimeType: "image/png" } } };
  const events = [chunk(0, "agent_message_chunk", "a"), image, chunk(2, "agent_message_chunk", "b")];
  assert.deepEqual(coalesceTextChunks(events), events);
  assert.deepEqual(coalesceTextChunks([]), []);
});
