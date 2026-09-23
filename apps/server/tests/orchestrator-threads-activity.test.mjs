import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { createPgActivityStore } from "../src/orchestrator/activity/pg-store.ts";
import { MAX_DETAIL_BYTES, createActivityService } from "../src/orchestrator/activity/service.ts";
import { createMemoryActivityStore } from "../src/orchestrator/activity/store.ts";
import { createPgOrchestratorStore } from "../src/orchestrator/pg-store.ts";
import { OrchestratorStoreError, createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { fakeDeps, fakeSettings, fakeTimers, flush } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const home = mkdtempSync(path.join(os.tmpdir(), "portal-threads-activity-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { buildApp } = await import("../src/app.ts");

const message = (id, text = id, role = "user") => ({ id, role, parts: [{ type: "text", text }], metadata: { at: 1 } });
const pull = { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" };

async function rejectsWith(promise, status) {
  await assert.rejects(promise, (err) => err instanceof OrchestratorStoreError && err.status === status);
}

// ---------------------------------------------------------------------------------------------
// Threads, against both stores
// ---------------------------------------------------------------------------------------------

function threadBehaviour(label, open) {
  test(`${label}: a fresh store has the main thread and nothing else`, async (t) => {
    const store = await open(t);
    await store.ready;
    const threads = await store.listThreads();
    assert.deepEqual(threads.map((thread) => [thread.id, thread.kind, thread.status]), [["main", "main", "active"]]);
    assert.deepEqual(threads[0].scope, { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] });
  });

  test(`${label}: messages belong to their thread, and appending moves lastMessageAt`, async (t) => {
    const store = await open(t);
    await store.ready;
    const side = await store.createThread({ title: "  Review #7 ", scope: { pulls: [pull, pull], repos: ["acme/app"] }, intentId: "i1" });
    assert.equal(side.kind, "side");
    assert.equal(side.title, "Review #7");
    assert.deepEqual(side.scope.pulls, [pull]);
    assert.equal(side.lastMessageAt, null);
    await store.appendMessages([message("m1")]);
    await store.appendMessages([message("s1"), message("s2")], side.id);
    assert.deepEqual((await store.readMessages()).map((m) => m.id), ["m1"]);
    assert.deepEqual((await store.readMessages(side.id)).map((m) => m.id), ["s1", "s2"]);
    await store.writeMessages([message("s3")], side.id);
    assert.deepEqual((await store.readMessages(side.id)).map((m) => m.id), ["s3"]);
    assert.deepEqual((await store.readMessages("main")).map((m) => m.id), ["m1"]);
    const reread = await store.getThread(side.id);
    assert.equal(typeof reread.lastMessageAt, "number");
    assert.equal(reread.intentId, "i1");
  });

  test(`${label}: main lists first, side threads by latest activity; the main thread cannot be archived`, async (t) => {
    const store = await open(t);
    await store.ready;
    const older = await store.createThread({ title: "Older" });
    const newer = await store.createThread({ title: "Newer" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendMessages([message("x")], older.id);
    assert.deepEqual((await store.listThreads()).map((thread) => thread.id), ["main", older.id, newer.id]);
    const archived = await store.updateThread(newer.id, { status: "archived", title: "Done" });
    assert.equal(archived.status, "archived");
    assert.equal(archived.title, "Done");
    await rejectsWith(store.updateThread("main", { status: "archived" }), 400);
    await rejectsWith(store.createThread({ title: "  " }), 400);
  });

  test(`${label}: an unknown thread is a 404 for writes and empty for reads`, async (t) => {
    const store = await open(t);
    await store.ready;
    await rejectsWith(store.appendMessages([message("m")], "nope"), 404);
    await rejectsWith(store.updateThread("nope", { title: "x" }), 404);
    assert.deepEqual(await store.readMessages("nope"), []);
    assert.equal(await store.getThread("nope"), null);
  });
}

threadBehaviour("memory threads", async () => createMemoryOrchestratorStore());
threadBehaviour("postgres threads", async (t) => createPgOrchestratorStore({ db: (await temporaryDatabase(t)).db }));

// ---------------------------------------------------------------------------------------------
// Activity, against both stores
// ---------------------------------------------------------------------------------------------

const entry = (kind, at, refs = {}) => ({ at, actor: "agent", kind, summary: `${kind} happened`, refs, detail: null });

function activityBehaviour(label, open) {
  test(`${label}: entries page newest first and filter by kind prefix, thread, and run`, async (t) => {
    const store = await open(t);
    const a = await store.append(entry("memory.remembered", 1, { threadId: "main", recordId: "r1" }));
    const b = await store.append(entry("tool.call", 2, { threadId: "main", runId: "run1" }));
    const c = await store.append(entry("memory.proposed", 3, { threadId: "t2", runId: "run1" }));
    assert.ok(a.id < b.id && b.id < c.id);
    assert.deepEqual(a.refs, { threadId: "main", recordId: "r1" });
    assert.deepEqual((await store.list()).map((e) => e.id), [c.id, b.id, a.id]);
    assert.deepEqual((await store.list({ limit: 2 })).map((e) => e.id), [c.id, b.id]);
    assert.deepEqual((await store.list({ before: b.id })).map((e) => e.id), [a.id]);
    assert.deepEqual((await store.list({ kind: "memory." })).map((e) => e.kind), ["memory.proposed", "memory.remembered"]);
    assert.deepEqual((await store.list({ kind: "tool.call" })).map((e) => e.id), [b.id]);
    // A prefix without the dot is an exact kind, and LIKE wildcards in a filter match nothing.
    assert.deepEqual(await store.list({ kind: "memory" }), []);
    assert.deepEqual(await store.list({ kind: "%." }), []);
    assert.deepEqual((await store.list({ threadId: "main" })).map((e) => e.id), [b.id, a.id]);
    assert.deepEqual((await store.list({ runId: "run1" })).map((e) => e.id), [c.id, b.id]);
  });
}

activityBehaviour("memory activity", async () => createMemoryActivityStore());
activityBehaviour("postgres activity", async (t) => createPgActivityStore({ db: (await temporaryDatabase(t)).db }));

test("activity service: publishes each entry, caps summary and detail, and never throws on a failed write", async () => {
  const events = [];
  const service = createActivityService({ store: createMemoryActivityStore(), emit: (event) => events.push(event), now: () => 42 });
  const logged = await service.log({ actor: "user", kind: "item.dismissed", summary: "x".repeat(600), detail: { big: "y".repeat(MAX_DETAIL_BYTES) } });
  assert.equal(logged.at, 42);
  assert.equal(logged.summary.length, 500);
  assert.match(logged.detail.note, /detail omitted/);
  assert.deepEqual(events, [{ type: "activity", entry: logged }]);
  const broken = createActivityService({ store: { append: async () => { throw new Error("db down"); }, list: async () => [] }, emit: () => {} });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await broken.log({ actor: "system", kind: "x", summary: "y" }), null);
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const textStream = (text) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
  ]),
});

test("routes: threads list, a side thread's messages and turn, per-thread cancel, and the activity log", async (t) => {
  const database = await temporaryDatabase(t);
  const model = new MockLanguageModelV3({ doStream: textStream("On it.") });
  const { deps } = fakeDeps();
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings({ key: "sk-test" }), deps, timers: fakeTimers(), model: () => model } });
  t.after(() => app.close());
  const inject = (method, url, payload) => app.inject({ method, url, payload });

  const listed = await inject("GET", "/api/portal/threads");
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().threads.map((thread) => thread.id), ["main"]);

  const side = await createPgOrchestratorStore({ db: database.db }).createThread({ title: "Review #7" });
  const sent = await inject("POST", `/api/portal/threads/${side.id}/messages`, { message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } });
  assert.equal(sent.statusCode, 200);
  await flush();
  const messages = await inject("GET", `/api/portal/threads/${side.id}/messages`);
  assert.deepEqual(messages.json().messages.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual((await inject("GET", "/api/portal/messages")).json().messages, []);
  assert.equal((await inject("GET", "/api/portal/threads/nope/messages")).statusCode, 404);
  assert.equal((await inject("POST", "/api/portal/threads/nope/messages", { message: { role: "user", parts: [{ type: "text", text: "x" }] } })).statusCode, 404);
  assert.equal((await inject("POST", `/api/portal/threads/${side.id}/cancel`)).statusCode, 204);

  const activity = await inject("GET", `/api/portal/activity?threadId=${side.id}&kind=chat.`);
  assert.equal(activity.statusCode, 200);
  assert.deepEqual(activity.json().entries.map((e) => [e.kind, e.actor]), [["chat.turn", "user"]]);
  assert.equal((await inject("GET", "/api/portal/activity?limit=abc")).statusCode, 200);
});
