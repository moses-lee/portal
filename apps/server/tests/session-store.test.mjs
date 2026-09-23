import assert from "node:assert/strict";
import test from "node:test";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { createMemorySessionStore } from "../src/sessions/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

function record(id, extra = {}) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1",
    createdAt: 1, lastActiveAt: 1, title: null, upstreamId: `up-${id}`,
    state: { modes: null, configOptions: [], commands: [] },
    ...extra,
  };
}

function event(seq, type = "update", extra = {}) {
  return { seq, ts: 1000 + seq, type, ...(type === "update" ? { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `chunk ${seq} ${"é".repeat(seq % 7)}` } } } : {}), ...extra };
}

async function fill(store, id, count) {
  for (let seq = 0; seq < count; seq++) await store.appendEvent(id, event(seq, seq % 10 === 0 ? "user" : "update", seq % 10 === 0 ? { text: `prompt ${seq}` } : {}));
}

const backends = [
  ["memory", async () => ({ store: createMemorySessionStore() })],
  ["postgres", async (t) => { const handle = await temporaryDatabase(t); return { store: createPgSessionStore({ db: handle.db }), handle }; }],
];

for (const [name, make] of backends) {
  // Same contract the web package checks for its file store, so a backend swap cannot change behaviour.
  test(`${name} store: metadata round-trips and tail pages walk the log backwards`, async (t) => {
    const { store } = await make(t);
    await store.ready;
    assert.deepEqual(await store.listSessions(), []);
    await store.putSession(record("a"));
    await store.putSession(record("b", { title: "Second" }));
    await store.putSession(record("a", { title: "First", lastActiveAt: 5 }));
    assert.deepEqual((await store.listSessions()).map(({ id, title }) => ({ id, title })), [{ id: "a", title: "First" }, { id: "b", title: "Second" }]);
    assert.equal((await store.getSession("a")).lastActiveAt, 5);
    assert.equal(await store.getSession("zzz"), undefined);

    assert.equal(await store.eventCount("a"), 0);
    assert.deepEqual(await store.readTail("a", { limit: 10 }), { events: [], hasMore: false });
    await fill(store, "a", 25);
    assert.equal(await store.eventCount("a"), 25);
    await assert.rejects(store.appendEvent("a", event(7)), /out-of-order/i);

    const latest = await store.readTail("a", { limit: 10 });
    assert.deepEqual(latest.events.map(({ seq }) => seq), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    assert.equal(latest.hasMore, true);
    assert.deepEqual(latest.events[9], event(24));
    const middle = await store.readTail("a", { beforeSeq: 15, limit: 10 });
    assert.deepEqual(middle.events.map(({ seq }) => seq), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    assert.equal(middle.hasMore, true);
    const first = await store.readTail("a", { beforeSeq: 5, limit: 10 });
    assert.deepEqual(first.events.map(({ seq }) => seq), [0, 1, 2, 3, 4]);
    assert.equal(first.hasMore, false);
    assert.deepEqual(first.events[0], event(0, "user", { text: "prompt 0" }));
    assert.deepEqual(await store.readTail("a", { beforeSeq: 0, limit: 10 }), { events: [], hasMore: false });
    assert.deepEqual((await store.readTail("a", { beforeSeq: 99, limit: 3 })).events.map(({ seq }) => seq), [22, 23, 24]);
    assert.deepEqual((await store.readTail("a", { beforeSeq: 3, limit: 99 })).events.map(({ seq }) => seq), [0, 1, 2]);
    assert.deepEqual(await store.readTail("a", { limit: 0 }), { events: [], hasMore: true });
    assert.deepEqual(await store.readTail("b", { limit: 5 }), { events: [], hasMore: false });

    await store.deleteSession("a");
    assert.deepEqual((await store.listSessions()).map(({ id }) => id), ["b"]);
    assert.equal(await store.eventCount("a"), 0);
    await store.deleteSession("missing");
    await store.dispose();
  });

  test(`${name} store: appending to an unknown session fails and a gap is tolerated`, async (t) => {
    const { store } = await make(t);
    await assert.rejects(store.appendEvent("nope", event(0)), /no such session/i);
    await store.putSession(record("a"));
    await store.appendEvent("a", event(0));
    // A write that failed upstream leaves a hole; the next seq must still be accepted.
    await store.appendEvent("a", event(2));
    assert.equal(await store.eventCount("a"), 3);
    assert.deepEqual((await store.readTail("a", { limit: 10 })).events.map(({ seq }) => seq), [0, 2]);
    await store.dispose();
  });
}

test("postgres store: concurrent appends land in order and appends after dispose are rejected", async (t) => {
  const handle = await temporaryDatabase(t);
  const store = createPgSessionStore({ db: handle.db });
  await store.putSession(record("a"));
  await Promise.all(Array.from({ length: 30 }, (_, seq) => store.appendEvent("a", event(seq))));
  assert.equal(await store.eventCount("a"), 30);
  assert.deepEqual((await store.readTail("a", { limit: 5 })).events.map(({ seq }) => seq), [25, 26, 27, 28, 29]);
  await store.dispose();
  await assert.rejects(store.appendEvent("a", event(30)), /disposed/i);
  await assert.rejects(store.putSession(record("c")), /disposed/i);
});

test("postgres store: events are stored as real jsonb, and deleting a session cascades to its log", async (t) => {
  const handle = await temporaryDatabase(t);
  const store = createPgSessionStore({ db: handle.db });
  await store.putSession(record("a", { state: { modes: null, configOptions: [{ id: "x" }], commands: [] } }));
  await store.appendEvent("a", event(0));
  const [{ body_type, state_type }] = await handle.sql`select jsonb_typeof(body) as body_type, (select jsonb_typeof(state) from sessions where id = 'a') as state_type from session_events where session_id = 'a'`;
  assert.equal(body_type, "object");
  assert.equal(state_type, "object");
  await store.deleteSession("a");
  const [{ n }] = await handle.sql`select count(*)::int as n from session_events`;
  assert.equal(n, 0);
});
