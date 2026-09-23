import assert from "node:assert/strict";
import test from "node:test";
import { orchestratorDocuments, orchestratorItems, orchestratorMessages, orchestratorTicks, orchestratorWatches } from "../src/db/schema.ts";
import {
  MAX_MEMORY_BYTES,
  MAX_TICK_REPORTS,
  OrchestratorStoreError,
  capMemory,
  createMemoryOrchestratorStore,
  newId,
  parseItemPatch,
  parseWatchPatch,
} from "../src/lib/orchestrator/store.ts";
import { createPgOrchestratorStore } from "../src/orchestrator/pg-store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

function message(id, role = "user", text = id) {
  return { id, role, parts: [{ type: "text", text }], metadata: { at: 1 } };
}

function itemInput(overrides = {}) {
  return {
    list: "needs_you",
    kind: "pr_checks_failing",
    title: "Checks failing on #42",
    body: "CI is red.",
    links: { pull: { repo: "o/r", number: 42, url: "https://github.com/o/r/pull/42" } },
    actions: [{ type: "open_url", url: "https://github.com/o/r/pull/42" }],
    fingerprint: "pr_checks_failing:o/r#42",
    ...overrides,
  };
}

function tick(id, extra = {}) {
  return {
    id, reason: "schedule", startedAt: 1, finishedAt: 2, modelInvoked: false, changes: 0,
    itemsCreated: [], itemsUpdated: [], itemsResolved: [], log: [], error: null, usage: null, ...extra,
  };
}

function snapshot(at = 1000) {
  return {
    at,
    sessions: { s1: { activity: "idle", lastActiveAt: at, title: "Fix", projectId: "p1" } },
    pulls: {},
    worktrees: { w1: { branch: "feat", merged: false, dirty: true, parentId: "p1" } },
    missingProjects: ["p9"],
  };
}

async function rejectsWith(promise, status, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof OrchestratorStoreError, `expected an OrchestratorStoreError, got ${err}`);
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Behaviour shared by both implementations
// ---------------------------------------------------------------------------------------------

/**
 * `open(t)` resolves to a fresh store; `reopen(t)` to a second store over the same data when the
 * implementation persists (null for the in-memory one), so round trips are checked from the database.
 */
function behaviour(label, { open, reopen }) {
  const roundTrip = async (t, store, check) => {
    await check(store);
    const again = await reopen?.(t);
    if (again) await check(again);
  };

  test(`${label}: starts empty`, async (t) => {
    const store = await open(t);
    await store.ready;
    assert.deepEqual(await store.readMessages(), []);
    assert.deepEqual(await store.listItems(), []);
    assert.deepEqual(await store.listWatches(), []);
    assert.equal(await store.readSnapshot(), null);
    assert.deepEqual(await store.listTicks(), []);
    assert.equal(await store.readMemory(), "");
    assert.equal(await store.getItem("nope"), null);
    assert.equal(await store.getWatch("nope"), null);
    assert.equal(await store.findItemByFingerprint("nope"), null);
  });

  test(`${label}: messages append, replace, and round-trip`, async (t) => {
    const store = await open(t);
    await store.appendMessages([message("m1"), message("m2", "assistant")]);
    await store.appendMessages([message("m3")]);
    await roundTrip(t, store, async (s) => {
      assert.deepEqual((await s.readMessages()).map((m) => m.id), ["m1", "m2", "m3"]);
    });
    await store.writeMessages([message("m9", "assistant")]);
    await roundTrip(t, store, async (s) => {
      assert.deepEqual(await s.readMessages(), [message("m9", "assistant")]);
    });
    await store.writeMessages([]);
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.readMessages(), []));
  });

  test(`${label}: createItem fills defaults and items list newest-first`, async (t) => {
    const store = await open(t);
    const before = Date.now();
    const first = await store.createItem(itemInput({ fingerprint: "a" }));
    const second = await store.createItem(itemInput({ fingerprint: "b", list: "ideas" }));
    assert.match(first.id, /^[A-Za-z0-9_-]{8}$/);
    assert.equal(first.status, "open");
    assert.equal(first.snoozedUntil, null);
    assert.ok(first.createdAt >= before && first.createdAt <= Date.now());
    assert.equal(first.updatedAt, first.createdAt);
    assert.deepEqual(first, { ...itemInput({ fingerprint: "a" }), id: first.id, status: "open", snoozedUntil: null, createdAt: first.createdAt, updatedAt: first.updatedAt });
    await roundTrip(t, store, async (s) => {
      assert.deepEqual((await s.listItems()).map((i) => i.id), [second.id, first.id]);
      assert.deepEqual(await s.getItem(first.id), first);
      assert.deepEqual(await s.getItem(second.id), second);
    });
    // A given status and snooze are honoured.
    const snoozed = await store.createItem(itemInput({ fingerprint: "c", status: "snoozed", snoozedUntil: 5_000 }));
    assert.equal(snoozed.status, "snoozed");
    assert.equal(snoozed.snoozedUntil, 5_000);
    await rejectsWith(store.createItem(itemInput({ fingerprint: "d", status: "snoozed" })), 400, /snoozedUntil/);
    assert.equal((await store.listItems()).length, 3, "the rejected item was not stored");
  });

  test(`${label}: updateItem patches, bumps updatedAt, and validates snoozing`, async (t) => {
    const store = await open(t);
    const item = await store.createItem(itemInput());
    const renamed = await store.updateItem(item.id, { title: "New title", list: "ideas" });
    assert.equal(renamed.title, "New title");
    assert.equal(renamed.list, "ideas");
    assert.equal(renamed.id, item.id);
    assert.equal(renamed.createdAt, item.createdAt);
    assert.ok(renamed.updatedAt > item.updatedAt, "updatedAt advances");
    assert.deepEqual(await store.getItem(item.id), renamed);

    await rejectsWith(store.updateItem(item.id, { status: "snoozed" }), 400, /snoozedUntil/);
    await rejectsWith(store.updateItem(item.id, { status: "snoozed", snoozedUntil: null }), 400, /snoozedUntil/);
    assert.deepEqual(await store.getItem(item.id), renamed, "a rejected patch changes nothing");

    const snoozed = await store.updateItem(item.id, { status: "snoozed", snoozedUntil: 10_000 });
    assert.equal(snoozed.status, "snoozed");
    assert.equal(snoozed.snoozedUntil, 10_000);
    // Already snoozed: re-sending the status without a time keeps the existing one.
    const still = await store.updateItem(item.id, { status: "snoozed" });
    assert.equal(still.snoozedUntil, 10_000);
    // Any other status clears the snooze, even if the patch tries to keep it.
    const resolved = await store.updateItem(item.id, { status: "resolved", snoozedUntil: 10_000 });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.snoozedUntil, null);
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.getItem(item.id), resolved));

    await rejectsWith(store.updateItem("missing1", { title: "x" }), 404, /Unknown item "missing1"/);
  });

  test(`${label}: updateItem and updateWatch keep only valid patch fields, so what is stored always loads`, async (t) => {
    const store = await open(t);
    const item = await store.createItem(itemInput());

    // Keys outside ItemPatch are ignored: identity and bookkeeping fields cannot be rewritten through a patch.
    const kept = await store.updateItem(item.id, { title: "T", fingerprint: 42, id: "other000", kind: "custom", createdAt: 1, bogus: true });
    assert.equal(kept.title, "T");
    assert.equal(kept.fingerprint, item.fingerprint);
    assert.equal(kept.id, item.id);
    assert.equal(kept.kind, item.kind);
    assert.equal(kept.createdAt, item.createdAt);
    assert.ok(!("bogus" in kept));

    // Wrong values are 400s that change nothing.
    for (const [patch, pattern] of [
      [{ status: "bogus" }, /"status" must be one of open, snoozed, resolved, dismissed/],
      [{ list: "later" }, /"list" must be one of needs_you, ideas/],
      [{ title: 5 }, /"title" must be a string/],
      [{ body: null }, /"body" must be a string/],
      [{ snoozedUntil: "tomorrow" }, /"snoozedUntil" must be an integer/],
      [{ links: [] }, /"links" must be/],
      [{ links: { projectId: 3 } }, /"links" must be/],
      [{ links: { pull: { repo: "o/r" } } }, /"links" must be/],
      [{ actions: {} }, /"actions" must be/],
      [{ actions: [{ type: "open_url" }] }, /"actions" must be/],
      [{ actions: [{ type: "teleport", url: "x" }] }, /"actions" must be/],
      [{ actions: [{ type: "open_url", url: "x", label: 1 }] }, /"actions" must be/],
      ["title", /item patch must be a JSON object/],
      [null, /item patch must be a JSON object/],
      [["title"], /item patch must be a JSON object/],
    ]) {
      await rejectsWith(store.updateItem(item.id, patch), 400, pattern);
    }
    assert.deepEqual(await store.getItem(item.id), kept, "rejected patches change nothing");

    // Everything ItemPatch allows, at full depth, round-trips.
    const full = await store.updateItem(item.id, {
      list: "ideas", title: "Full", body: "b",
      links: { projectId: "p1", sessionId: "s1", watchId: "w1", pull: { repo: "o/r", number: 1, url: "u" } },
      actions: [{ type: "start_session", projectId: "p1", prompt: "go", agentId: "claude", label: "Start" }, { type: "ask_portal", text: "hi" }, { type: "remove_worktree", projectId: "p1" }],
      status: "snoozed", snoozedUntil: 99,
    });
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.getItem(item.id), full));
    assert.deepEqual(await store.updateItem(item.id, {}), { ...full, updatedAt: (await store.getItem(item.id)).updatedAt }, "an empty patch only bumps updatedAt");

    const watch = await store.createWatch({ intent: "i", notes: "n" });
    const renamed = await store.updateWatch(watch.id, { notes: "N", id: "other000", createdAt: 1, lastCheckedAt: 5, extra: 1 });
    assert.equal(renamed.notes, "N");
    assert.equal(renamed.id, watch.id);
    assert.equal(renamed.createdAt, watch.createdAt);
    assert.equal(renamed.lastCheckedAt, 5);
    assert.ok(!("extra" in renamed));
    for (const [patch, pattern] of [
      [{ status: "paused" }, /"status" must be one of active, done, cancelled/],
      [{ intent: 1 }, /"intent" must be a string/],
      [{ notes: [] }, /"notes" must be a string/],
      [{ lastCheckedAt: "now" }, /"lastCheckedAt" must be an integer/],
      [{ links: { sessionIds: "s1", projectIds: [], pulls: [] } }, /"links" must be/],
      [{ links: { sessionIds: [], projectIds: [1], pulls: [] } }, /"links" must be/],
      [{ links: { sessionIds: [], projectIds: [], pulls: [{ repo: "o/r" }] } }, /"links" must be/],
      [{ links: { sessionIds: [], projectIds: [] } }, /"links" must be/],
      ["x", /watch patch must be a JSON object/],
    ]) {
      await rejectsWith(store.updateWatch(watch.id, patch), 400, pattern);
    }
    assert.deepEqual(await store.getWatch(watch.id), renamed);
    const linked = await store.updateWatch(watch.id, { links: { sessionIds: ["s1"], projectIds: ["p1"], pulls: [{ repo: "o/r", number: 2, url: "u2" }] }, status: "done" });
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.getWatch(watch.id), linked));

    // createItem is held to the same bar: a record the loader would drop is refused rather than written.
    await rejectsWith(store.createItem(itemInput({ list: 5 })), 400, /would not be readable/);
    await rejectsWith(store.createItem(itemInput({ actions: "none" })), 400, /would not be readable/);
    assert.equal((await store.listItems()).length, 1);
  });

  test(`${label}: findItemByFingerprint sees open and snoozed items only`, async (t) => {
    const store = await open(t);
    const fp = "pr_checks_failing:o/r#1";
    const item = await store.createItem(itemInput({ fingerprint: fp }));
    assert.deepEqual(await store.findItemByFingerprint(fp), item);
    assert.equal(await store.findItemByFingerprint("other"), null);

    const snoozed = await store.updateItem(item.id, { status: "snoozed", snoozedUntil: 1 });
    assert.deepEqual(await store.findItemByFingerprint(fp), snoozed);

    await store.updateItem(item.id, { status: "resolved" });
    assert.equal(await store.findItemByFingerprint(fp), null);
    await store.updateItem(item.id, { status: "dismissed" });
    assert.equal(await store.findItemByFingerprint(fp), null);

    // A new open item with the same fingerprint is found while the old one stays dismissed.
    const fresh = await store.createItem(itemInput({ fingerprint: fp }));
    assert.deepEqual(await store.findItemByFingerprint(fp), fresh);
    assert.equal((await store.getItem(item.id)).status, "dismissed");
  });

  test(`${label}: createWatch fills defaults; updateWatch patches and 404s`, async (t) => {
    const store = await open(t);
    const watch = await store.createWatch({ intent: "Review PRs 1-3", notes: "Plan: ..." });
    assert.match(watch.id, /^[A-Za-z0-9_-]{8}$/);
    assert.deepEqual(watch, {
      id: watch.id, intent: "Review PRs 1-3", notes: "Plan: ...", status: "active",
      links: { sessionIds: [], projectIds: [], pulls: [] },
      createdAt: watch.createdAt, updatedAt: watch.createdAt, lastCheckedAt: null,
    });
    const linked = await store.createWatch({ intent: "b", notes: "", links: { sessionIds: ["s1"], projectIds: [], pulls: [{ repo: "o/r", number: 1, url: "u" }] } });
    assert.deepEqual(linked.links, { sessionIds: ["s1"], projectIds: [], pulls: [{ repo: "o/r", number: 1, url: "u" }] });

    const updated = await store.updateWatch(watch.id, { notes: "Done with 1", lastCheckedAt: 123, status: "done" });
    assert.equal(updated.notes, "Done with 1");
    assert.equal(updated.lastCheckedAt, 123);
    assert.equal(updated.status, "done");
    assert.ok(updated.updatedAt > watch.updatedAt);
    await roundTrip(t, store, async (s) => {
      assert.deepEqual((await s.listWatches()).map((w) => w.id), [linked.id, watch.id]);
      assert.deepEqual(await s.getWatch(watch.id), updated);
    });
    await rejectsWith(store.updateWatch("missing1", { notes: "x" }), 404, /Unknown watch "missing1"/);
  });

  test(`${label}: snapshot round-trips`, async (t) => {
    const store = await open(t);
    await store.writeSnapshot(snapshot(1000));
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.readSnapshot(), snapshot(1000)));
    await store.writeSnapshot(snapshot(2000));
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.readSnapshot(), snapshot(2000)));
  });

  test(`${label}: ticks append newest-last and keep only the latest ${MAX_TICK_REPORTS}`, async (t) => {
    const store = await open(t);
    await store.appendTick(tick("t1"));
    await store.appendTick(tick("t2", { modelInvoked: true, error: "boom" }));
    await roundTrip(t, store, async (s) => {
      assert.deepEqual(await s.listTicks(), [tick("t1"), tick("t2", { modelInvoked: true, error: "boom" })]);
    });
    for (let i = 3; i <= MAX_TICK_REPORTS + 5; i++) await store.appendTick(tick(`t${i}`));
    await roundTrip(t, store, async (s) => {
      const ticks = await s.listTicks();
      assert.equal(ticks.length, MAX_TICK_REPORTS);
      assert.equal(ticks[0].id, "t6");
      assert.equal(ticks.at(-1).id, `t${MAX_TICK_REPORTS + 5}`);
    });
  });

  test(`${label}: memory round-trips and is capped at 32 KiB without throwing`, async (t) => {
    const store = await open(t);
    await store.writeMemory("# Notes\n\n- prefers pnpm\n");
    await roundTrip(t, store, async (s) => assert.equal(await s.readMemory(), "# Notes\n\n- prefers pnpm\n"));

    const big = "x".repeat(MAX_MEMORY_BYTES + 1000);
    await store.writeMemory(big);
    await roundTrip(t, store, async (s) => {
      const text = await s.readMemory();
      assert.equal(Buffer.byteLength(text), MAX_MEMORY_BYTES);
      assert.ok(text.startsWith("xxxx"));
      assert.match(text, /truncated[^]*32 KiB/);
    });
    // Exactly at the limit is untouched.
    const exact = "y".repeat(MAX_MEMORY_BYTES);
    await store.writeMemory(exact);
    assert.equal(await store.readMemory(), exact);
    await store.writeMemory("");
    await roundTrip(t, store, async (s) => assert.equal(await s.readMemory(), ""));
  });

  test(`${label}: concurrent creates and updates are all kept`, async (t) => {
    const store = await open(t);
    const created = await Promise.all(Array.from({ length: 10 }, (_, i) => store.createItem(itemInput({ fingerprint: `fp${i}` }))));
    assert.equal(new Set(created.map((i) => i.id)).size, 10, "ids are unique");
    await Promise.all(created.map((item, i) => store.updateItem(item.id, { title: `T${i}` })));
    await Promise.all([store.appendMessages([message("a")]), store.appendMessages([message("b")]), store.writeMemory("m")]);
    await roundTrip(t, store, async (s) => {
      const items = await s.listItems();
      assert.equal(items.length, 10);
      assert.deepEqual(new Set(items.map((i) => i.title)), new Set(created.map((_, i) => `T${i}`)));
      assert.deepEqual((await s.readMessages()).map((m) => m.id), ["a", "b"]);
      assert.equal(await s.readMemory(), "m");
    });
  });
}

behaviour("memory store", { open: async () => createMemoryOrchestratorStore(), reopen: null });

// Each Postgres test records its database so `reopen` can build a second store over the same rows.
const databases = new WeakMap();
behaviour("postgres store", {
  async open(t) {
    const handle = await temporaryDatabase(t);
    databases.set(t, handle);
    return createPgOrchestratorStore({ db: handle.db });
  },
  async reopen(t) {
    const handle = databases.get(t);
    assert.ok(handle, "reopen() called before open()");
    return createPgOrchestratorStore({ db: handle.db });
  },
});

// ---------------------------------------------------------------------------------------------
// Postgres specifics
// ---------------------------------------------------------------------------------------------

test("postgres store: one row per record; memory and snapshot are documents; ticks are trimmed in the table", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgOrchestratorStore({ db });
  await store.appendMessages([message("m1"), message("m2", "assistant")]);
  const item = await store.createItem(itemInput());
  await store.updateItem(item.id, { title: "Renamed" });
  const watch = await store.createWatch({ intent: "i", notes: "n" });
  await store.writeMemory("# Notes");
  await store.writeSnapshot(snapshot());
  for (let i = 1; i <= MAX_TICK_REPORTS + 3; i++) await store.appendTick(tick(`t${i}`));

  assert.deepEqual((await db.select().from(orchestratorMessages)).map((row) => row.id), ["m1", "m2"]);
  const [itemRow] = await db.select().from(orchestratorItems);
  assert.equal(itemRow.id, item.id);
  assert.equal(itemRow.fingerprint, item.fingerprint);
  assert.equal(itemRow.body.title, "Renamed", "an update rewrites the row, not a new one");
  assert.equal(itemRow.updatedAt, itemRow.body.updatedAt);
  assert.deepEqual((await db.select().from(orchestratorWatches)).map((row) => row.id), [watch.id]);
  const documents = Object.fromEntries((await db.select().from(orchestratorDocuments)).map((row) => [row.key, row.body]));
  assert.deepEqual(documents, { memory: { text: "# Notes" }, snapshot: snapshot() });
  const tickRows = await db.select().from(orchestratorTicks);
  assert.equal(tickRows.length, MAX_TICK_REPORTS);
  assert.deepEqual(new Set(tickRows.map((row) => row.id)).has("t3"), false);
});

test("postgres store: writeMessages replaces the thread in one transaction", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgOrchestratorStore({ db });
  await store.appendMessages([message("m1"), message("m2")]);
  // A message without an id breaks the NOT NULL column, so the insert fails after the delete ran; the delete must roll back.
  await assert.rejects(store.writeMessages([message("ok"), { ...message("bad"), id: null }]));
  assert.deepEqual((await store.readMessages()).map((m) => m.id), ["m1", "m2"]);
  // The queue survives the failure.
  await store.appendMessages([message("m3")]);
  assert.deepEqual((await store.readMessages()).map((m) => m.id), ["m1", "m2", "m3"]);
});

test("postgres store: NUL characters are stripped from every record instead of failing the write", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgOrchestratorStore({ db });
  const nul = (text) => `${text}\u0000!`;
  await store.appendMessages([message("m1", "assistant", nul("tool said"))]);
  await store.writeMessages([message("m1", "assistant", nul("tool said")), message("m2", "user", nul("again"))]);
  const item = await store.createItem(itemInput({ title: nul("Checks"), body: nul("CI") }));
  assert.equal(item.title, "Checks!", "the caller gets the stored record back");
  await store.updateItem(item.id, { body: nul("still red") });
  const watch = await store.createWatch({ intent: nul("watch"), notes: "n" });
  await store.updateWatch(watch.id, { notes: nul("checked") });
  await store.appendTick(tick("t1", { log: [nul("ran cat")] }));
  await store.writeSnapshot({ ...snapshot(), missingProjects: [nul("p9")] });
  await store.writeMemory(nul("# Notes"));

  const again = createPgOrchestratorStore({ db });
  assert.deepEqual((await again.readMessages()).map((m) => m.parts[0].text), ["tool said!", "again!"]);
  const [stored] = await again.listItems();
  assert.deepEqual([stored.title, stored.body], ["Checks!", "still red!"]);
  const [storedWatch] = await again.listWatches();
  assert.deepEqual([storedWatch.intent, storedWatch.notes], ["watch!", "checked!"]);
  assert.deepEqual((await again.listTicks())[0].log, ["ran cat!"]);
  assert.deepEqual((await again.readSnapshot()).missingProjects, ["p9!"]);
  assert.equal(await again.readMemory(), "# Notes!");
});

test("postgres store: items created in the same millisecond still list newest-first", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgOrchestratorStore({ db });
  const created = [];
  for (let i = 0; i < 5; i++) created.push(await store.createItem(itemInput({ fingerprint: `fp${i}` })));
  assert.deepEqual((await store.listItems()).map((item) => item.id), created.map((item) => item.id).reverse());
  const other = createPgOrchestratorStore({ db });
  assert.deepEqual((await other.findItemByFingerprint("fp4")).id, created[4].id);
});

test("parseItemPatch and parseWatchPatch validate request bodies without a store", () => {
  assert.deepEqual(parseItemPatch({ title: "t", fingerprint: "nope", snoozedUntil: null, status: "open" }), { title: "t", snoozedUntil: null, status: "open" });
  assert.deepEqual(parseItemPatch({}), {});
  assert.deepEqual(parseItemPatch({ title: undefined }), {}, "undefined is absent");
  assert.throws(() => parseItemPatch({ status: 1 }), (err) => err instanceof OrchestratorStoreError && err.status === 400 && /"status"/.test(err.message));
  assert.throws(() => parseItemPatch("x"), (err) => err instanceof OrchestratorStoreError && err.status === 400);
  assert.deepEqual(parseWatchPatch({ status: "done", lastCheckedAt: 5, other: 1 }), { status: "done", lastCheckedAt: 5 });
  assert.throws(() => parseWatchPatch([]), (err) => err instanceof OrchestratorStoreError && err.status === 400);
  assert.throws(() => parseWatchPatch({ links: null }), (err) => err instanceof OrchestratorStoreError && /"links"/.test(err.message));
  // The time columns are bigint: a fractional or unsafe number is a 400 here, not a database error later.
  for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 2, Infinity, NaN]) {
    assert.throws(() => parseItemPatch({ snoozedUntil: bad }), (err) => err instanceof OrchestratorStoreError && err.status === 400 && /"snoozedUntil"/.test(err.message));
    assert.throws(() => parseWatchPatch({ lastCheckedAt: bad }), (err) => err instanceof OrchestratorStoreError && err.status === 400 && /"lastCheckedAt"/.test(err.message));
  }
});

test("newId is 8 URL-safe characters and re-rolls collisions", () => {
  for (let i = 0; i < 200; i++) assert.match(newId(), /^[A-Za-z0-9_-]{8}$/);
  const seen = new Set();
  let rolls = 0;
  const id = newId((candidate) => {
    rolls++;
    if (rolls <= 3) {
      seen.add(candidate);
      return true; // Pretend the first three are taken.
    }
    return false;
  });
  assert.equal(rolls, 4);
  assert.ok(!seen.has(id));
});

test("capMemory keeps short text, truncates long text on a character boundary", () => {
  assert.equal(capMemory("short"), "short");
  const emoji = "😀".repeat(MAX_MEMORY_BYTES); // 4 bytes each
  const capped = capMemory(emoji);
  assert.ok(Buffer.byteLength(capped) <= MAX_MEMORY_BYTES);
  assert.ok(!capped.includes("�"), "no torn character");
  assert.ok(capped.endsWith("32 KiB.]"));
});
