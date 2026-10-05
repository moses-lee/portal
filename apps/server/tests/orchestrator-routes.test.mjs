import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { T0, fakeDeps, fakeSettings, fakeTimers, flush, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

// Nothing here may touch the real ~/.portal (the settings and projects services still look there for legacy files).
const home = mkdtempSync(path.join(os.tmpdir(), "portal-orchestrator-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { appContext, buildApp } = await import("../src/app.ts");

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textStream(text) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ]),
  };
}

/** The app over a throwaway database with a runtime that never reaches a provider: fake model, deps, settings, and clock. */
async function setup(t, { key = "sk-test", sessions = [], doStream } = {}) {
  const database = await temporaryDatabase(t);
  const settingsStore = fakeSettings({ key });
  const { deps, state } = fakeDeps({ sessions });
  const model = new MockLanguageModelV3({ doStream });
  const timers = fakeTimers();
  const app = await buildApp({ database, orchestrator: { settingsStore, deps, timers, model: () => model } });
  t.after(() => app.close());
  return { app, database, settingsStore, deps, state, model, timers };
}

const inject = (app, method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });

const itemInput = {
  kind: "custom", title: "Session needs your approval", body: "The agent asked to run a command.",
  links: { sessionId: "s1", projectId: "p1" },
  actions: [{ type: "open_session", sessionId: "s1", label: "Open" }, { type: "send_prompt", sessionId: "s1", prompt: "Continue" }],
  fingerprint: "custom:s1",
};

test("status, messages, ticks, and items answer their JSON shapes; watches and the legacy memory text are gone", async (t) => {
  const { app } = await setup(t);
  const status = await inject(app, "GET", "/api/portal");
  assert.equal(status.statusCode, 200);
  assert.deepEqual(Object.keys(status.json()), ["status"]);
  assert.equal(status.json().status.ready, true);
  assert.equal(status.json().status.busy, false);
  assert.equal(status.json().status.provider, "anthropic");
  assert.equal(status.json().status.counts.needsYou, 0);

  assert.deepEqual((await inject(app, "GET", "/api/portal/messages")).json(), { messages: [], hasMore: false, before: null, after: null });
  for (const [method, url] of [["GET", "/api/portal/ticks"], ["POST", "/api/portal/tick"]]) assert.equal((await inject(app, method, url)).statusCode, 404, `${url} is gone`);
  for (const field of ["intervalMinutes", "idleIntervalMinutes", "lastTick", "nextTickAt"]) assert.ok(!(field in status.json().status), `status has no ${field}`);
  assert.deepEqual((await inject(app, "GET", "/api/portal/items")).json(), { items: [] });
  assert.equal((await inject(app, "GET", "/api/portal/watches")).statusCode, 404);
  // The legacy memory document is gone from the API; curated memory lives under /api/portal/memory/**.
  assert.equal((await inject(app, "GET", "/api/portal/memory")).statusCode, 404);

  assert.equal((await inject(app, "POST", "/api/portal/cancel")).statusCode, 204);
});

test("items: PATCH validates, 404s unknown ids, and persists; actions run server-side", async (t) => {
  const { app, database, state } = await setup(t, { sessions: [sessionMeta()] });
  // Items are created by the model's tools; a second store over the same database stands in for them.
  const { createPgOrchestratorStore } = await import("../src/orchestrator/pg-store.ts");
  const store = createPgOrchestratorStore({ db: database.db });
  const item = await store.createItem(itemInput);

  assert.deepEqual((await inject(app, "GET", "/api/portal/items")).json(), { items: [item] });
  assert.equal((await inject(app, "GET", "/api/portal")).json().status.counts.needsYou, 1);

  const snoozed = await inject(app, "PATCH", `/api/portal/items/${item.id}`, { status: "snoozed", snoozedUntil: T0 + 60_000, fingerprint: "ignored" });
  assert.equal(snoozed.statusCode, 200);
  assert.equal(snoozed.json().item.status, "snoozed");
  assert.equal(snoozed.json().item.fingerprint, item.fingerprint);
  assert.deepEqual(await store.getItem(item.id), snoozed.json().item);

  const bad = await inject(app, "PATCH", `/api/portal/items/${item.id}`, { status: "bogus" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /"status" must be one of/);
  const noSnooze = await inject(app, "PATCH", `/api/portal/items/${item.id}`, { status: "snoozed", snoozedUntil: null });
  assert.equal(noSnooze.statusCode, 400);
  assert.match(noSnooze.json().error, /snoozedUntil/);
  assert.deepEqual(
    (await inject(app, "PATCH", `/api/portal/items/${item.id}`, ["status"])).json(),
    { error: "Expected a JSON object body." },
  );
  const missing = await inject(app, "PATCH", "/api/portal/items/nope0000", { title: "x" });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: 'Unknown item "nope0000".' });

  // Actions: send_prompt runs here once approved (the agent wrote its text); open_* belongs to the browser; bad and missing indexes are refused.
  const asked = await inject(app, "POST", `/api/portal/items/${item.id}/actions/1`);
  assert.equal(asked.statusCode, 200);
  assert.deepEqual(Object.keys(asked.json()), ["approvalId"]);
  assert.deepEqual(state.prompts, []);
  const approved = await inject(app, "POST", `/api/portal/approvals/${asked.json().approvalId}/decide`, { approve: true });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().approval.status, "approved");
  assert.deepEqual(state.prompts, [{ id: "s1", text: "Continue" }]);
  const browserOnly = await inject(app, "POST", `/api/portal/items/${item.id}/actions/0`);
  assert.equal(browserOnly.statusCode, 400);
  assert.match(browserOnly.json().error, /runs in the browser/);
  assert.deepEqual((await inject(app, "POST", `/api/portal/items/${item.id}/actions/x`)).json(), { error: "Expected a numeric action index." });
  assert.equal((await inject(app, "POST", `/api/portal/items/${item.id}/actions/7`)).statusCode, 404);
  assert.equal((await inject(app, "POST", "/api/portal/items/nope0000/actions/0")).statusCode, 404);

});

test("needsYou counts what the attention page lists: open and lapsed-snoozed items, never future snoozes, retired kinds, or settled ones", async (t) => {
  const { app, database } = await setup(t);
  const { createPgOrchestratorStore } = await import("../src/orchestrator/pg-store.ts");
  const store = createPgOrchestratorStore({ db: database.db });
  const make = (fingerprint, extra = {}) => store.createItem({ ...itemInput, links: {}, actions: [], fingerprint, ...extra });
  await make("open");
  await make("lapsed", { status: "snoozed", snoozedUntil: T0 - 1 });
  await make("future", { status: "snoozed", snoozedUntil: T0 + 60_000 });
  await make("retired", { kind: "session_waiting" });
  await make("retired-lapsed", { kind: "session_hung", status: "snoozed", snoozedUntil: T0 - 1 });
  await make("resolved", { status: "resolved" });
  assert.equal((await inject(app, "GET", "/api/portal")).json().status.counts.needsYou, 2);
});

test("POST /api/portal/items/bulk settles many items, skips unknown ids, logs one entry, and validates its body", async (t) => {
  const { app, database } = await setup(t);
  const { createPgOrchestratorStore } = await import("../src/orchestrator/pg-store.ts");
  const store = createPgOrchestratorStore({ db: database.db });
  const make = (fingerprint, title) => store.createItem({ ...itemInput, links: {}, actions: [], fingerprint, title });
  const a = await make("a", "First");
  const b = await make("b", "Second");
  const c = await make("c", "Third");
  assert.equal((await inject(app, "GET", "/api/portal")).json().status.counts.needsYou, 3);

  const resolved = await inject(app, "POST", "/api/portal/items/bulk", { ids: [a.id, b.id, "nope0000", a.id], status: "resolved" });
  assert.equal(resolved.statusCode, 200);
  assert.deepEqual(resolved.json().missing, ["nope0000"]);
  assert.deepEqual(resolved.json().items.map((item) => [item.id, item.status]), [[a.id, "resolved"], [b.id, "resolved"]]);
  assert.equal((await store.getItem(a.id)).status, "resolved");
  assert.equal((await store.getItem(c.id)).status, "open");
  assert.equal((await inject(app, "GET", "/api/portal")).json().status.counts.needsYou, 1, "the count is fresh right after the write");
  await flush();
  const [entry, ...others] = (await inject(app, "GET", "/api/portal/activity?kind=item.resolved")).json().entries;
  assert.equal(others.length, 0, "one entry for the batch");
  assert.equal(entry.actor, "user");
  assert.equal(entry.summary, "Marked 2 items resolved");
  assert.equal(entry.refs.itemId, undefined);
  assert.deepEqual(entry.detail.itemIds, [a.id, b.id]);

  const dismissed = await inject(app, "POST", "/api/portal/items/bulk", { ids: [c.id], status: "dismissed" });
  assert.deepEqual(dismissed.json().items.map((item) => item.status), ["dismissed"]);
  await flush();
  const [single] = (await inject(app, "GET", "/api/portal/activity?kind=item.dismissed")).json().entries;
  assert.equal(single.summary, 'Marked "Third" dismissed');
  assert.equal(single.refs.itemId, c.id);
  assert.deepEqual((await inject(app, "POST", "/api/portal/items/bulk", { ids: ["gone0000"], status: "dismissed" })).json(), { items: [], missing: ["gone0000"] });

  for (const body of [
    { ids: [], status: "resolved" }, { ids: Array.from({ length: 501 }, (_, i) => `id${i}`), status: "resolved" }, { ids: "a", status: "resolved" },
    { ids: [1], status: "resolved" }, { ids: [""], status: "resolved" }, { ids: [a.id], status: "open" }, { ids: [a.id] }, ["x"],
  ]) {
    const response = await inject(app, "POST", "/api/portal/items/bulk", body);
    assert.equal(response.statusCode, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(typeof response.json().error, "string");
  }
  assert.equal((await inject(app, "POST", "/api/portal/items/bulk", { ids: Array.from({ length: 500 }, (_, i) => `id${i}`), status: "dismissed" })).json().missing.length, 500);
});

test("body validation: messages need a user text part, and bad JSON is a 400", async (t) => {
  const { app } = await setup(t);
  const bad = await inject(app, "POST", "/api/portal/messages", "{ nope", { "content-type": "application/json" });
  assert.equal(bad.statusCode, 400);
  assert.equal(typeof bad.json().error, "string");
  for (const message of [undefined, { role: "assistant", parts: [{ type: "text", text: "hi" }] }, { role: "user", parts: [{ type: "text", text: "  " }] }]) {
    const response = await inject(app, "POST", "/api/portal/messages", { message });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "Expected { message } with role \"user\" and a non-empty text part." });
  }
});

test("cross-origin requests are refused with 403 on every route", async (t) => {
  const { app } = await setup(t);
  const headers = { origin: "https://evil.example", host: "portal.local" };
  for (const [method, url] of [
    ["GET", "/api/portal"], ["GET", "/api/portal/items"], ["PATCH", "/api/portal/items/x"], ["POST", "/api/portal/items/bulk"], ["POST", "/api/portal/items/x/actions/0"],
    ["GET", "/api/portal/jobs"], ["PATCH", "/api/portal/jobs/x"], ["POST", "/api/portal/jobs/x/run"], ["GET", "/api/portal/runs"], ["GET", "/api/portal/runs/x"],
    ["POST", "/api/portal/runs/x/cancel"], ["GET", "/api/portal/intents"], ["PATCH", "/api/portal/intents/x"], ["POST", "/api/portal/messages"],
    ["POST", "/api/portal/cancel"], ["GET", "/api/portal/stream"],
  ]) {
    const response = await inject(app, method, url, method === "GET" ? undefined : {}, headers);
    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.deepEqual(response.json(), { error: "Cross-origin requests are not allowed." });
  }
  assert.equal((await inject(app, "GET", "/api/portal", undefined, { "sec-fetch-site": "cross-site" })).statusCode, 403);
});

test("POST /api/portal/messages streams the UI message stream and persists both messages; 409 is JSON", async (t) => {
  const { app, model, settingsStore } = await setup(t, { doStream: textStream("Hello from Portal") });
  const response = await inject(app, "POST", "/api/portal/messages", { message: { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] } }, { "accept-encoding": "gzip" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  assert.equal(response.headers["x-vercel-ai-ui-message-stream"], "v1");
  assert.equal(response.headers["content-encoding"], undefined, "the stream is not gzipped");
  assert.equal(response.headers["cache-control"], "no-cache, no-transform", "nor gzipped (and buffered) by the Next proxy");
  assert.match(response.body, /Hello from Portal/);
  assert.equal(model.doStreamCalls.length, 1);
  await flush();
  const { messages } = (await inject(app, "GET", "/api/portal/messages")).json();
  assert.deepEqual(messages.map((message) => [message.id, message.role]), [["u1", "user"], [messages[1].id, "assistant"]]);
  assert.equal(messages[1].parts.find((part) => part.type === "text").text, "Hello from Portal");

  await settingsStore.change({ apiKey: "" });
  const refused = await inject(app, "POST", "/api/portal/messages", { message: { role: "user", parts: [{ type: "text", text: "Again" }] } });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.headers["content-type"], /application\/json/);
  assert.match(refused.json().error, /API key/);
});

test("GET /api/portal/stream opens with status, items, threads, forwards events, and counts presence", async (t) => {
  const { app } = await setup(t);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();
  const { presence } = appContext(app);
  const before = presence.count();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${port}/api/portal/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const events = [];
  async function next() {
    for (;;) {
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.length) return events.shift();
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += value;
    }
  }
  assert.equal((await next()).type, "status");
  assert.deepEqual(await next(), { type: "items", items: [] });
  assert.equal((await next()).type, "threads");
  assert.equal(presence.count(), before + 1, "an open stream counts as a present browser");

  // A runtime event reaches the stream: a manual world refresh emits `world`. (No keep-alive, or
  // closing the app waits for the idle socket to time out.)
  await fetch(`http://127.0.0.1:${port}/api/portal/world/refresh`, { method: "POST", headers: { connection: "close" } });
  let event;
  do event = await next(); while (event.type !== "world");
  assert.equal(typeof event.at, "number");

  controller.abort();
  for (let i = 0; i < 50 && presence.count() !== before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(presence.count(), before, "closing the stream releases presence");
});

test("liveDeps and liveSettingsStore read the services from the context at call time", async () => {
  const { liveDeps, liveSettingsStore } = await import("../src/orchestrator/deps.ts");
  const calls = [];
  const ctx = {};
  const deps = liveDeps(ctx);
  const settings = liveSettingsStore(ctx);
  // Services attached after the deps were built, as buildApp may do.
  let sessions = [{ id: "s1", projectId: "gone" }];
  ctx.sessions = {
    ready: Promise.resolve(),
    listSessions: () => sessions,
    getSession: (id) => sessions.find((s) => s.id === id),
    sendPrompt: async (id, text) => { calls.push(["prompt", id, text]); },
    deleteSession: async (id) => {
      const before = sessions.length;
      sessions = sessions.filter((s) => s.id !== id);
      return sessions.length < before;
    },
    listAgents: () => [{ id: "fake", name: "Fake agent" }, { id: "other", name: "Other agent" }],
    defaultAgentId: "fake",
  };
  let lastAgentId = null;
  ctx.lastUsed = { read: async () => ({ agentId: lastAgentId, settings: {} }) };
  const removed = new Set(["gone"]);
  ctx.projects = {
    ready: Promise.resolve(), list: () => [{ id: "p1" }], get: (id) => (id === "p1" ? { id } : undefined),
    getRemoved: (id) => (removed.has(id) ? { id } : undefined),
    forgetRemoved: async (id) => removed.delete(id),
  };
  ctx.terminals = { closeSession: (id) => calls.push(["closeTerminals", id]) };
  ctx.settings = { read: async () => ({ scripts: { preWorktreeDelete: { command: "", timeoutSeconds: 60, abortOnFailure: false } } }), orchestrator: async () => ({ provider: "openai" }), apiKey: async (p) => `key-${p}`, subscribe: () => () => {} };
  assert.deepEqual(await deps.sessions.list(), [{ id: "s1", projectId: "gone" }]);
  await deps.sessions.prompt("s1", "hi");
  assert.deepEqual(calls, [["prompt", "s1", "hi"]]);
  // delete_session deletes like the HTTP route: terminals close, and the emptied removed project is forgotten.
  assert.equal(await deps.sessions.remove("s1"), true);
  assert.deepEqual(calls.at(-1), ["closeTerminals", "s1"]);
  assert.equal(removed.has("gone"), false);
  assert.equal(await deps.sessions.remove("s1"), false);
  assert.equal(calls.length, 2, "an unknown session closes nothing");
  assert.deepEqual(await deps.projects.list(), [{ id: "p1" }]);
  assert.equal(await deps.projects.get("zz"), undefined);
  assert.deepEqual(await deps.agents.list(), [{ id: "fake", name: "Fake agent" }, { id: "other", name: "Other agent" }], "the sessions service's agents, not the built-in ones");
  assert.equal(await deps.agents.defaultId(), "fake");
  // The user's last pick wins while the server still offers it.
  lastAgentId = "other";
  assert.equal(await deps.agents.defaultId(), "other");
  lastAgentId = "retired";
  assert.equal(await deps.agents.defaultId(), "fake");
  assert.equal(await settings.apiKey("anthropic"), "key-anthropic");
  // Scripts read their settings from the context's settings service; an unset script does not run.
  assert.deepEqual(await deps.scripts.run("preWorktreeDelete", { cwd: home }), { ran: false });
});

test("message routes page the thread, hand out one message in full, and filter items by status", async (t) => {
  const { app } = await setup(t);
  const store = appContext(app).orchestrator.hub.store;
  const tool = { type: "tool-list_sessions", toolCallId: "c1", state: "output-available", input: { limit: 2 }, output: { rows: [1, 2] } };
  await store.appendMessages([
    ...Array.from({ length: 4 }, (_, i) => ({ id: `u${i}`, role: "user", parts: [{ type: "text", text: `q${i}` }], metadata: { at: i } })),
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "ran it" }, tool], metadata: { at: 9 } },
  ]);
  const page = (await inject(app, "GET", "/api/portal/messages?limit=2")).json();
  assert.deepEqual(page.messages.map((m) => m.id), ["u3", "a1"]);
  assert.equal(page.hasMore, true);
  assert.equal(typeof page.before, "number");
  // Tool traffic is left out of a page and marked; the single-message route has it.
  const paged = page.messages[1];
  assert.equal(paged.metadata.toolIO, "omitted");
  assert.equal(paged.parts[1].input, "[open to load]");
  assert.equal(paged.parts[1].output, "[open to load]");
  assert.equal(paged.parts[1].state, "output-available");
  const full = (await inject(app, "GET", "/api/portal/threads/main/messages/a1")).json().message;
  assert.deepEqual(full.parts[1], tool);
  assert.equal(full.metadata.toolIO, undefined);
  assert.equal((await inject(app, "GET", "/api/portal/threads/main/messages/nope")).statusCode, 404);
  assert.equal((await inject(app, "GET", "/api/portal/threads/other/messages/a1")).statusCode, 404);

  const older = (await inject(app, "GET", `/api/portal/messages?before=${page.before}&limit=2`)).json();
  assert.deepEqual(older.messages.map((m) => m.id), ["u1", "u2"]);
  const newer = (await inject(app, "GET", `/api/portal/messages?after=${older.after}`)).json();
  assert.deepEqual(newer.messages.map((m) => m.id), ["u3", "a1"]);
  assert.equal(newer.hasMore, false);
  assert.equal((await inject(app, "GET", "/api/portal/messages?before=x")).statusCode, 400);
  assert.equal((await inject(app, "GET", "/api/portal/threads/main/messages?limit=1")).json().messages.length, 1);

  await store.createItem({ kind: "custom", title: "open", body: "", links: {}, actions: [], fingerprint: "f1" });
  await store.createItem({ kind: "custom", title: "done", body: "", links: {}, actions: [], fingerprint: "f2", status: "resolved" });
  assert.equal((await inject(app, "GET", "/api/portal/items")).json().items.length, 2);
  const live = (await inject(app, "GET", "/api/portal/items?status=open,snoozed")).json().items;
  assert.deepEqual(live.map((item) => item.title), ["open"]);
});
