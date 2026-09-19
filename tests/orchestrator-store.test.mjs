import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_MEMORY_BYTES,
  MAX_TICK_REPORTS,
  OrchestratorStoreError,
  capMemory,
  createMemoryOrchestratorStore,
  createOrchestratorStore,
  defaultOrchestratorDir,
  newId,
  parseItemPatch,
  parseWatchPatch,
} from "../src/lib/orchestrator/store.ts";

const FILES = ["conversation.json", "items.json", "watches.json", "snapshot.json", "ticks.json", "memory.md"];

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-orchestrator-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The store's directory (like a fresh PORTAL_HOME) does not exist yet.
  const dir = path.join(root, "portal-home", "orchestrator");
  return { root, dir, open: () => createOrchestratorStore({ dir }) };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

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
 * `open(t)` returns a fresh store; `reopen(t)` returns a second store over the same data when the
 * implementation persists (null for the in-memory one), so round trips can be checked from disk.
 */
function behaviour(label, { open, reopen }) {
  const roundTrip = async (t, store, check) => {
    await check(store);
    const again = reopen?.(t);
    if (again) await check(again);
  };

  test(`${label}: starts empty`, async (t) => {
    const store = open(t);
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
    const store = open(t);
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
    const store = open(t);
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
    const store = open(t);
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
    const store = open(t);
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
      [{ snoozedUntil: "tomorrow" }, /"snoozedUntil" must be a number/],
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
      [{ lastCheckedAt: "now" }, /"lastCheckedAt" must be a number/],
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
    const store = open(t);
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
    const store = open(t);
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
    const store = open(t);
    await store.writeSnapshot(snapshot(1000));
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.readSnapshot(), snapshot(1000)));
    await store.writeSnapshot(snapshot(2000));
    await roundTrip(t, store, async (s) => assert.deepEqual(await s.readSnapshot(), snapshot(2000)));
  });

  test(`${label}: ticks append newest-last and keep only the latest ${MAX_TICK_REPORTS}`, async (t) => {
    const store = open(t);
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
    const store = open(t);
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
    const store = open(t);
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

behaviour("memory store", { open: () => createMemoryOrchestratorStore(), reopen: null });

// Each file-store test records its directory so `reopen` can read the same files back from disk.
const fileDirs = new WeakMap();
behaviour("file store", {
  open(t) {
    const { dir, open } = setup(t);
    fileDirs.set(t, dir);
    return open();
  },
  reopen(t) {
    const dir = fileDirs.get(t);
    assert.ok(dir, "reopen() called before open()");
    return createOrchestratorStore({ dir });
  },
});

// ---------------------------------------------------------------------------------------------
// File-store specifics
// ---------------------------------------------------------------------------------------------

test("defaultOrchestratorDir honours PORTAL_HOME", () => {
  const previous = process.env.PORTAL_HOME;
  try {
    delete process.env.PORTAL_HOME;
    assert.equal(defaultOrchestratorDir(), path.join(os.homedir(), ".portal", "orchestrator"));
    process.env.PORTAL_HOME = "/custom/portal";
    assert.equal(defaultOrchestratorDir(), path.join("/custom/portal", "orchestrator"));
  } finally {
    if (previous === undefined) delete process.env.PORTAL_HOME; else process.env.PORTAL_HOME = previous;
  }
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

test("reading never creates the directory; the first write does, with private modes and no temp files", async (t) => {
  const { dir, open } = setup(t);
  const store = open();
  await store.ready;
  assert.deepEqual(await store.listItems(), []);
  assert.ok(!existsSync(dir), "reading does not create the directory");

  await store.createItem(itemInput());
  assert.ok(existsSync(dir));
  assert.equal(statSync(dir).mode & 0o077, 0, "directory is private to the user");
  assert.deepEqual(readdirSync(dir), ["items.json"], "only the file that changed exists, and no temp files");
  assert.equal(statSync(path.join(dir, "items.json")).mode & 0o077, 0, "file is private to the user");

  await store.writeMemory("hi");
  await store.writeSnapshot(snapshot());
  await store.appendTick(tick("t1"));
  await store.createWatch({ intent: "i", notes: "n" });
  await store.appendMessages([message("m")]);
  assert.deepEqual(readdirSync(dir).sort(), [...FILES].sort());
  for (const name of FILES) assert.equal(statSync(path.join(dir, name)).mode & 0o077, 0, `${name} is private`);
  assert.equal(readFileSync(path.join(dir, "memory.md"), "utf8"), "hi", "memory is plain text");
  assert.ok(Array.isArray(readJson(path.join(dir, "items.json"))));
  assert.ok(readFileSync(path.join(dir, "items.json"), "utf8").endsWith("\n"), "JSON files end with a newline");
});

test("a corrupt file is treated as empty, warns, and is backed up on the first write to it", async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "items.json"), "{ not json");
  writeFileSync(path.join(dir, "watches.json"), JSON.stringify({ not: "an array" }));
  writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({ at: "not a number" }));
  writeFileSync(path.join(dir, "memory.md"), "kept");
  const warn = t.mock.method(console, "warn", () => {});
  const store = open();
  await store.ready;
  assert.deepEqual(await store.listItems(), []);
  assert.deepEqual(await store.listWatches(), []);
  assert.equal(await store.readSnapshot(), null);
  assert.equal(await store.readMemory(), "kept", "other files are unaffected");
  assert.equal(warn.mock.callCount(), 3);
  assert.equal(readFileSync(path.join(dir, "items.json"), "utf8"), "{ not json", "nothing is written until a change");

  const item = await store.createItem(itemInput());
  const names = readdirSync(dir).sort();
  const backup = names.find((name) => name.startsWith("items.json.corrupt-"));
  assert.ok(backup, `expected an items.json.corrupt- backup in ${names}`);
  assert.equal(readFileSync(path.join(dir, backup), "utf8"), "{ not json");
  assert.deepEqual(readJson(path.join(dir, "items.json")), [item]);
  assert.ok(!names.some((name) => name.startsWith("watches.json.corrupt-")), "untouched corrupt files stay put");
  assert.ok(!names.some((name) => name.includes(".tmp-")), "no temp files");

  // A second write to the same file does not create another backup.
  await store.updateItem(item.id, { title: "again" });
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("items.json.corrupt-")).length, 1);

  // The backed-up state reloads cleanly.
  const again = open();
  assert.deepEqual((await again.listItems()).map((i) => i.title), ["again"]);
  assert.equal(warn.mock.callCount(), 5, "watches and snapshot still warn on reload");
});

test("a file that exists but cannot be read is never written over", { skip: process.getuid?.() === 0 && "root can read anything" }, async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "items.json");
  const original = JSON.stringify([{ ...itemInput(), id: "keep0000", status: "open", snoozedUntil: null, createdAt: 1, updatedAt: 1 }]);
  writeFileSync(file, original);
  writeFileSync(path.join(dir, "memory.md"), "notes");
  chmodSync(file, 0o000);
  // Make the file removable again should an assertion fail before the chmod below (setup's rmSync hook runs first).
  t.after(() => { if (existsSync(file)) chmodSync(file, 0o600); });

  const store = open();
  await assert.rejects(store.ready, { code: "EACCES" });
  // The first commit and every later one reject; the second used to run against the empty default and overwrite the file.
  await assert.rejects(store.createItem(itemInput({ fingerprint: "new" })), { code: "EACCES" });
  await assert.rejects(store.createItem(itemInput({ fingerprint: "new" })), { code: "EACCES" });
  await assert.rejects(store.updateItem("keep0000", { title: "x" }), { code: "EACCES" });
  await assert.rejects(store.writeMemory("changed"), "no file is written while the store could not load");
  await assert.rejects(store.listItems(), "reads report the failure too");

  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, "utf8"), original, "the unreadable file is untouched");
  assert.equal(readFileSync(path.join(dir, "memory.md"), "utf8"), "notes");
  assert.deepEqual(readdirSync(dir).sort(), ["items.json", "memory.md"], "no temp or backup files");
  // Readable again, a fresh store loads what was there all along.
  assert.deepEqual((await open().listItems()).map((item) => item.id), ["keep0000"]);
});

test("a null snapshot file is a valid empty snapshot, not a corrupt one", async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "snapshot.json"), "null\n");
  const warn = t.mock.method(console, "warn", () => {});
  const store = open();
  assert.equal(await store.readSnapshot(), null);
  assert.equal(warn.mock.callCount(), 0);
  await store.writeSnapshot(snapshot());
  assert.ok(!readdirSync(dir).some((name) => name.includes(".corrupt-")));
});

test("hand-edited lists drop unreadable records and sort items newest-first", async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  const older = { ...itemInput({ fingerprint: "old" }), id: "old00000", status: "open", snoozedUntil: null, createdAt: 100, updatedAt: 100 };
  const newer = { ...itemInput({ fingerprint: "new" }), id: "new00000", status: "resolved", snoozedUntil: null, createdAt: 200, updatedAt: 250 };
  writeFileSync(path.join(dir, "items.json"), JSON.stringify([older, { id: "bad" }, newer, "junk", { ...older, id: "weird", status: "unknown" }]));
  writeFileSync(path.join(dir, "conversation.json"), JSON.stringify([message("ok"), { id: "no-parts", role: "user" }, { role: "user", parts: [] }, 7, null]));
  writeFileSync(path.join(dir, "ticks.json"), JSON.stringify([tick("t1"), { id: "missing fields" }, tick("t2")]));
  const warn = t.mock.method(console, "warn", () => {});
  const store = open();
  assert.deepEqual(await store.listItems(), [newer, older]);
  assert.deepEqual(await store.readMessages(), [message("ok")]);
  assert.deepEqual(await store.listTicks(), [tick("t1"), tick("t2")]);
  assert.equal(warn.mock.callCount(), 3, "one warning per file with dropped records");
  assert.ok(!readdirSync(dir).some((name) => name.includes(".corrupt-")), "a partly readable list is not a corrupt file");

  // The next write persists only the readable records.
  await store.updateItem("old00000", { title: "edited" });
  assert.deepEqual(readJson(path.join(dir, "items.json")).map((i) => i.id), ["new00000", "old00000"]);
});

test("an over-long ticks.json is trimmed to the newest reports on load", async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "ticks.json"), JSON.stringify(Array.from({ length: MAX_TICK_REPORTS + 10 }, (_, i) => tick(`t${i}`))));
  const ticks = await open().listTicks();
  assert.equal(ticks.length, MAX_TICK_REPORTS);
  assert.equal(ticks[0].id, "t10");
});
