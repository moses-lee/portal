import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { createPgActivityStore } from "../src/orchestrator/activity/pg-store.ts";
import { MAX_DETAIL_BYTES, createActivityService } from "../src/orchestrator/activity/service.ts";
import { createMemoryActivityStore } from "../src/orchestrator/activity/store.ts";
import { fakeDeps, fakeSettings, fakeTimers, flush } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const home = mkdtempSync(path.join(os.tmpdir(), "portal-activity-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { buildApp } = await import("../src/app.ts");

// ---------------------------------------------------------------------------------------------
// Activity, against both stores
// ---------------------------------------------------------------------------------------------

const entry = (kind, at, refs = {}) => ({ at, actor: "agent", kind, summary: `${kind} happened`, refs, detail: null });

function activityBehaviour(label, open) {
  test(`${label}: entries page newest first and filter by kind prefix and run`, async (t) => {
    const store = await open(t);
    const a = await store.append(entry("memory.remembered", 1, { recordId: "r1" }));
    const b = await store.append(entry("tool.call", 2, { runId: "run1" }));
    const c = await store.append(entry("memory.proposed", 3, { runId: "run1" }));
    assert.ok(a.id < b.id && b.id < c.id);
    assert.deepEqual(a.refs, { recordId: "r1" });
    assert.deepEqual((await store.list()).map((e) => e.id), [c.id, b.id, a.id]);
    assert.deepEqual((await store.list({ limit: 2 })).map((e) => e.id), [c.id, b.id]);
    assert.deepEqual((await store.list({ before: b.id })).map((e) => e.id), [a.id]);
    assert.deepEqual((await store.list({ kind: "memory." })).map((e) => e.kind), ["memory.proposed", "memory.remembered"]);
    assert.deepEqual((await store.list({ kind: "tool.call" })).map((e) => e.id), [b.id]);
    // A prefix without the dot is an exact kind, and LIKE wildcards in a filter match nothing.
    assert.deepEqual(await store.list({ kind: "memory" }), []);
    assert.deepEqual(await store.list({ kind: "%." }), []);
    assert.deepEqual((await store.list({ runId: "run1" })).map((e) => e.id), [c.id, b.id]);
  });

  test(`${label}: countSince counts the entries at or after a time`, async (t) => {
    const store = await open(t);
    assert.equal(await store.countSince(0), 0);
    for (const at of [1, 2, 3]) await store.append(entry("tool.call", at));
    assert.equal(await store.countSince(0), 3);
    assert.equal(await store.countSince(2), 2);
    assert.equal(await store.countSince(4), 0);
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

test("routes: a chat turn lands in the activity log, filtered by kind and run", async (t) => {
  const database = await temporaryDatabase(t);
  const model = new MockLanguageModelV3({ doStream: textStream("On it.") });
  const { deps } = fakeDeps();
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings({ key: "sk-test" }), deps, timers: fakeTimers(), model: () => model } });
  t.after(() => app.close());
  const inject = (method, url, payload) => app.inject({ method, url, payload });

  const sent = await inject("POST", "/api/portal/messages", { message: { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } });
  assert.equal(sent.statusCode, 200);
  await flush();
  assert.deepEqual((await inject("GET", "/api/portal/messages")).json().messages.map((m) => m.role), ["user", "assistant"]);

  const activity = await inject("GET", "/api/portal/activity?kind=chat.");
  assert.equal(activity.statusCode, 200);
  const entries = activity.json().entries;
  assert.deepEqual(entries.map((e) => [e.kind, e.actor]), [["chat.turn", "user"]]);
  const byRun = await inject("GET", `/api/portal/activity?runId=${entries[0].refs.runId}&kind=chat.`);
  assert.deepEqual(byRun.json().entries.map((e) => e.id), [entries[0].id]);
  assert.equal((await inject("GET", "/api/portal/activity?limit=abc")).statusCode, 200);
});
