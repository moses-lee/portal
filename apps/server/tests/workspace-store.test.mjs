import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_WORKSPACE, applyWorkspaceOp } from "@portal/shared/workspace";
import { WORKSPACE_KEY, createMemoryWorkspaceStore, createPgWorkspaceStore, parseWorkspace } from "../src/workspace/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

/** Deterministic ids for the reducer: t1, t2, ... */
function counter(prefix = "id") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const open = (sessionId, ids) => (current) => applyWorkspaceOp(current, { op: "open", sessionId }, ids, 1_700_000_000_000).workspace;

const backends = [
  ["memory", async () => {
    const warnings = [];
    const store = createMemoryWorkspaceStore(null, { warn: (message) => warnings.push(message) });
    return { store, warnings, writes: () => store.writes };
  }],
  ["postgres", async (t) => {
    const handle = await temporaryDatabase(t);
    const warnings = [];
    const store = createPgWorkspaceStore(handle.db, { warn: (message) => warnings.push(message) });
    const writes = async () => {
      const [row] = await handle.sql`select body from settings where key = ${WORKSPACE_KEY}`;
      return row ? row.body.version : 0;
    };
    return { store, warnings, writes, handle };
  }],
];

for (const [name, make] of backends) {
  test(`${name} store: reads empty, bumps version on every write, skips a write when the mutation answers null`, async (t) => {
    const { store, writes } = await make(t);
    assert.deepEqual(await store.read(), EMPTY_WORKSPACE);
    const ids = counter();

    const first = await store.mutate(open("s1", ids));
    assert.equal(first.version, 1);
    assert.equal(first.tabs.length, 1);
    assert.deepEqual(await store.read(), first, "what mutate answers is what is stored");

    const same = await store.mutate(() => null);
    assert.deepEqual(same, first, "null leaves the stored workspace alone");
    assert.equal(await writes(), 1, "and writes nothing");

    const second = await store.mutate(open("s2", ids));
    assert.equal(second.version, 2);
    assert.deepEqual(second.tabs.map((tab) => tab.root.sessionId), ["s1", "s2"]);
    assert.equal(await writes(), 2);
  });

  test(`${name} store: concurrent mutations run one after the other, each over the one before`, async (t) => {
    const { store } = await make(t);
    const ids = counter();
    const seen = [];
    const spy = (sessionId) => (current) => {
      seen.push(current.version);
      return open(sessionId, ids)(current);
    };
    const results = await Promise.all([store.mutate(spy("s1")), store.mutate(spy("s2")), store.mutate(spy("s3"))]);
    assert.deepEqual(seen, [0, 1, 2], "each mutation read the previous one's result");
    assert.deepEqual(results.map((ws) => ws.version), [1, 2, 3]);
    const stored = await store.read();
    assert.equal(stored.version, 3);
    assert.deepEqual(stored.tabs.map((tab) => tab.root.sessionId), ["s1", "s2", "s3"], "no open was lost to a stale read");
  });

  test(`${name} store: a throwing mutation writes nothing and does not block the next one`, async (t) => {
    const { store, writes } = await make(t);
    const ids = counter();
    await store.mutate(open("s1", ids));
    await assert.rejects(store.mutate(() => { throw new Error("boom"); }), /boom/);
    assert.equal(await writes(), 1);
    const next = await store.mutate(open("s2", ids));
    assert.equal(next.version, 2);
    assert.equal(next.tabs.length, 2);
  });
}

test("a corrupt or foreign row reads as the empty workspace, with a warning, and the next write starts from it", async () => {
  const warnings = [];
  const corrupt = { tabs: [{ id: "t1", title: null, titleSource: null, createdAt: 1, root: { kind: "pane", id: "t1", sessionId: "s1" } }], version: 7 };
  const store = createMemoryWorkspaceStore(corrupt, { warn: (message) => warnings.push(message) });
  assert.deepEqual(await store.read(), EMPTY_WORKSPACE);
  assert.match(warnings[0], /Stored workspace is invalid and was reset: Duplicate id t1/);
  const next = await store.mutate(open("s1", counter()));
  assert.equal(next.version, 1, "the version restarts from the empty workspace, not the corrupt row's");
  assert.deepEqual(createMemoryWorkspaceStore("garbage", { warn: () => {} }).stored(), "garbage");
  assert.deepEqual(await createMemoryWorkspaceStore("garbage", { warn: () => {} }).read(), EMPTY_WORKSPACE);
});

test("parseWorkspace passes a valid workspace through and resets anything else", () => {
  const valid = { tabs: [{ id: "t1", title: "Review", titleSource: "user", createdAt: 1, root: { kind: "pane", id: "p1", sessionId: "s1" } }], version: 3 };
  assert.deepEqual(parseWorkspace(valid), valid);
  assert.deepEqual(parseWorkspace(null), EMPTY_WORKSPACE);
  assert.deepEqual(parseWorkspace(undefined), EMPTY_WORKSPACE);
  const warnings = [];
  assert.deepEqual(parseWorkspace({ tabs: "no", version: 1 }, (message) => warnings.push(message)), EMPTY_WORKSPACE);
  assert.equal(warnings.length, 1);
});

test("the postgres store keeps the row under the workspace key beside the other settings rows", async (t) => {
  const { store, handle } = await backends[1][1](t);
  await handle.sql`insert into settings (key, body, updated_at) values ('overrides', '{"x":1}'::jsonb, 1)`;
  await store.mutate(open("s1", counter()));
  const rows = await handle.sql`select key, body from settings order by key`;
  assert.deepEqual(rows.map((row) => row.key), ["overrides", WORKSPACE_KEY]);
  assert.equal(rows[1].body.version, 1);
  assert.deepEqual(await createPgWorkspaceStore(handle.db).read(), await store.read(), "a second store over the same database reads the same row");
});
