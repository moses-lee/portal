import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileSessionStore, defaultSessionsDir } from "../src/lib/file-session-store.ts";
import { readTurnPage } from "../src/lib/session-pages.ts";
import { createMemorySessionStore } from "../src/lib/session-store.ts";

function setup(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portal-sessions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Like a fresh PORTAL_HOME, the directory does not exist yet.
  const dir = path.join(root, "portal-home", "sessions");
  return { root, dir, open: () => createFileSessionStore({ dir, ...options }) };
}

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

test("defaultSessionsDir honours PORTAL_HOME", () => {
  const previous = process.env.PORTAL_HOME;
  try {
    delete process.env.PORTAL_HOME;
    assert.equal(defaultSessionsDir(), path.join(os.homedir(), ".portal", "sessions"));
    process.env.PORTAL_HOME = "/custom/portal";
    assert.equal(defaultSessionsDir(), path.join("/custom/portal", "sessions"));
  } finally {
    if (previous === undefined) delete process.env.PORTAL_HOME; else process.env.PORTAL_HOME = previous;
  }
});

for (const [name, make] of [["memory", () => createMemorySessionStore()], ["file", (t) => setup(t, { chunkSize: 100 }).open()]]) {
  test(`${name} store: metadata round-trips and tail pages walk the log backwards`, async (t) => {
    const store = make(t);
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
    // Cursors past the end and far-back cursors without a cached offset work too.
    assert.deepEqual((await store.readTail("a", { beforeSeq: 99, limit: 3 })).events.map(({ seq }) => seq), [22, 23, 24]);
    assert.deepEqual((await store.readTail("a", { beforeSeq: 3, limit: 99 })).events.map(({ seq }) => seq), [0, 1, 2]);
    // Other sessions are untouched.
    assert.deepEqual(await store.readTail("b", { limit: 5 }), { events: [], hasMore: false });

    await store.deleteSession("a");
    assert.deepEqual((await store.listSessions()).map(({ id }) => id), ["b"]);
    assert.equal(await store.eventCount("a"), 0);
    await store.deleteSession("missing");
    await store.dispose();
  });
}

test("file store: survives reopening, drops a torn last line, and skips unreadable lines", async (t) => {
  const { dir, open } = setup(t, { chunkSize: 64 });
  let store = open();
  await store.putSession(record("s"));
  await fill(store, "s", 12);
  await store.dispose();
  const file = path.join(dir, "logs", "s.jsonl");
  assert.ok(existsSync(file));
  assert.deepEqual(readdirSync(dir).sort(), ["index.json", "logs"]);
  const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.equal(index.version, 1);
  assert.deepEqual(index.sessions.map(({ id }) => id), ["s"]);

  // A crash mid-append leaves a partial final line; an unrelated corrupt line is skipped on read.
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  lines[4] = "{not json";
  writeFileSync(file, `${lines.join("\n")}\n`);
  appendFileSync(file, JSON.stringify(event(12)).slice(0, 20));

  store = open();
  await store.ready;
  assert.deepEqual((await store.listSessions()).map(({ id }) => id), ["s"]);
  assert.equal(await store.eventCount("s"), 12);
  const all = await store.readTail("s", { limit: 50 });
  assert.deepEqual(all.events.map(({ seq }) => seq), [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(all.hasMore, false);
  // Appends continue on a clean line boundary after the trimmed tail.
  await store.appendEvent("s", event(12));
  assert.deepEqual((await store.readTail("s", { limit: 2 })).events.map(({ seq }) => seq), [11, 12]);
  await store.dispose();
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 13);
});

test("file store: an unreadable index is kept aside and rebuilt on the next write", async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.json"), "{broken");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  t.after(() => { console.warn = originalWarn; });
  const store = open();
  await store.ready;
  assert.deepEqual(await store.listSessions(), []);
  assert.match(warnings.join("\n"), /unreadable sessions index/i);
  await store.putSession(record("fresh"));
  const files = readdirSync(dir);
  assert.ok(files.includes("index.json"));
  assert.ok(files.some((name) => name.startsWith("index.json.bad-")));
  assert.deepEqual((await open().listSessions()).map(({ id }) => id), ["fresh"]);
});

test("file store: concurrent appends land in order and pages see them", async (t) => {
  const { open } = setup(t);
  const store = open();
  await store.putSession(record("c"));
  await Promise.all(Array.from({ length: 40 }, (_, seq) => store.appendEvent("c", event(seq))));
  assert.equal(await store.eventCount("c"), 40);
  const page = await store.readTail("c", { limit: 40 });
  assert.deepEqual(page.events.map(({ seq }) => seq), Array.from({ length: 40 }, (_, i) => i));
  await store.dispose();
});

test("file store: unreadable lines never make a page report more than it can deliver", async (t) => {
  const { dir, open } = setup(t, { chunkSize: 64 });
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  // A corrupt first line below a short turn: the page must end at the log start, not loop.
  writeFileSync(path.join(dir, "logs", "c.jsonl"), ["{garbage", JSON.stringify(event(1, "user", { text: "q" })), JSON.stringify(event(2)), JSON.stringify(event(3))].join("\n") + "\n");
  // Two corrupt lines and no turn start at all.
  writeFileSync(path.join(dir, "logs", "d.jsonl"), ["{garbage", "also garbage", JSON.stringify(event(2)), JSON.stringify(event(3))].join("\n") + "\n");
  // Blank lines only.
  writeFileSync(path.join(dir, "logs", "e.jsonl"), "\n\n\n");
  const store = open();
  for (const id of ["c", "d", "e"]) await store.putSession(record(id));
  assert.equal(await store.eventCount("c"), 4);
  assert.deepEqual(await store.readTail("c", { beforeSeq: 1, limit: 10 }), { events: [], hasMore: false });
  const c = await readTurnPage(store, "c", { minEvents: 300 });
  assert.deepEqual(c.events.map(({ seq }) => seq), [1, 2, 3]);
  assert.equal(c.hasMore, false);
  const d = await readTurnPage(store, "d", { minEvents: 300 });
  assert.deepEqual(d.events.map(({ seq }) => seq), [2, 3]);
  assert.equal(d.hasMore, false);
  assert.equal(await store.eventCount("e"), 0);
  assert.deepEqual(await readTurnPage(store, "e", { minEvents: 10 }), { events: [], hasMore: false });
  await store.dispose();
});

test("file store: a failed write leaves a gap instead of blocking every later append", async (t) => {
  const { open } = setup(t, { chunkSize: 64 });
  let store = open();
  await store.putSession(record("g"));
  await store.appendEvent("g", event(0, "user", { text: "q" }));
  await store.appendEvent("g", event(1));
  // seq 2 was lost (disk full, say); the next event still lands.
  await store.appendEvent("g", event(3));
  await assert.rejects(store.appendEvent("g", event(2)), /out-of-order|already holds/i);
  assert.equal(await store.eventCount("g"), 4);
  assert.deepEqual((await store.readTail("g", { limit: 10 })).events.map(({ seq }) => seq), [0, 1, 3]);
  await store.dispose();
  // The next seq comes from the last event on disk, not from the line count.
  store = open();
  assert.equal(await store.eventCount("g"), 4);
  await store.appendEvent("g", event(4));
  const page = await readTurnPage(store, "g", { minEvents: 10 });
  assert.deepEqual(page.events.map(({ seq }) => seq), [0, 1, 3, 4]);
  assert.equal(page.hasMore, false);
  await store.dispose();
});

test("file store: appends racing dispose or delete are rejected cleanly, never written to a closed handle", async (t) => {
  const { dir, open } = setup(t);
  let store = open();
  await store.putSession(record("r"));
  await store.appendEvent("r", event(0, "user", { text: "q" }));
  const [, late] = await Promise.allSettled([store.dispose(), store.appendEvent("r", event(1))]);
  assert.equal(late.status, "rejected");
  assert.match(late.reason.message, /closed/i);
  assert.doesNotMatch(late.reason.message, /EBADF/);
  assert.equal(readFileSync(path.join(dir, "logs", "r.jsonl"), "utf8").trim().split("\n").length, 1);

  store = open();
  await store.appendEvent("r", event(1));
  // Delete runs behind the index queue, so a racing append may land first (and be deleted with the
  // log) or arrive after the log closed (and be rejected); either way nothing is left behind.
  const [, lateDelete] = await Promise.allSettled([store.deleteSession("r"), store.appendEvent("r", event(2))]);
  if (lateDelete.status === "rejected") assert.match(lateDelete.reason.message, /closed/i);
  assert.equal(existsSync(path.join(dir, "logs", "r.jsonl")), false);
  assert.deepEqual(await store.listSessions(), []);
  await store.dispose();
});

test("file store: ids that are not plain identifiers are ignored when loading the index", async (t) => {
  const { dir, open } = setup(t);
  mkdirSync(dir, { recursive: true });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  writeFileSync(path.join(dir, "index.json"), JSON.stringify({ version: 1, sessions: [record("../../escape"), record("ok-1")] }));
  const store = open();
  await store.ready;
  // The whole file is treated as unreadable rather than half-trusted.
  assert.deepEqual(await store.listSessions(), []);
});
