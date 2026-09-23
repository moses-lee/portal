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
  list: "needs_you", kind: "session_waiting", title: "Session needs your approval", body: "The agent asked to run a command.",
  links: { sessionId: "s1", projectId: "p1" },
  actions: [{ type: "open_session", sessionId: "s1", label: "Open" }, { type: "send_prompt", sessionId: "s1", prompt: "Continue" }],
  fingerprint: "session_waiting:s1",
};

test("status, messages, ticks, items, and watches answer their JSON shapes", async (t) => {
  const { app } = await setup(t);
  const status = await inject(app, "GET", "/api/portal");
  assert.equal(status.statusCode, 200);
  assert.deepEqual(Object.keys(status.json()), ["status"]);
  assert.equal(status.json().status.ready, true);
  assert.equal(status.json().status.busy, false);
  assert.equal(status.json().status.provider, "anthropic");
  assert.deepEqual(status.json().status.openItems, { needs_you: 0, ideas: 0 });

  assert.deepEqual((await inject(app, "GET", "/api/portal/messages")).json(), { messages: [] });
  assert.deepEqual((await inject(app, "GET", "/api/portal/ticks")).json(), { ticks: [] });
  assert.deepEqual((await inject(app, "GET", "/api/portal/items")).json(), { items: [] });
  assert.deepEqual((await inject(app, "GET", "/api/portal/watches")).json(), { watches: [] });
  // The legacy memory document is gone from the API; curated memory lives under /api/portal/memory/**.
  assert.equal((await inject(app, "GET", "/api/portal/memory")).statusCode, 404);

  assert.equal((await inject(app, "POST", "/api/portal/cancel")).statusCode, 204);
});

test("items and watches: PATCH validates, 404s unknown ids, and persists; actions run server-side", async (t) => {
  const { app, database, state } = await setup(t, { sessions: [sessionMeta()] });
  // Items and watches are created by the model's tools; a second store over the same database stands in for them.
  const { createPgOrchestratorStore } = await import("../src/orchestrator/pg-store.ts");
  const store = createPgOrchestratorStore({ db: database.db });
  const item = await store.createItem(itemInput);
  const watch = await store.createWatch({ intent: "Review PRs 1-3", notes: "Plan" });

  assert.deepEqual((await inject(app, "GET", "/api/portal/items")).json(), { items: [item] });
  assert.equal((await inject(app, "GET", "/api/portal")).json().status.openItems.needs_you, 1);

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

  // Actions: send_prompt runs here; open_* belongs to the browser; bad and missing indexes are refused.
  const sent = await inject(app, "POST", `/api/portal/items/${item.id}/actions/1`);
  assert.equal(sent.statusCode, 200);
  assert.deepEqual(sent.json(), {});
  assert.deepEqual(state.prompts, [{ id: "s1", text: "Continue" }]);
  const browserOnly = await inject(app, "POST", `/api/portal/items/${item.id}/actions/0`);
  assert.equal(browserOnly.statusCode, 400);
  assert.match(browserOnly.json().error, /runs in the browser/);
  assert.deepEqual((await inject(app, "POST", `/api/portal/items/${item.id}/actions/x`)).json(), { error: "Expected a numeric action index." });
  assert.equal((await inject(app, "POST", `/api/portal/items/${item.id}/actions/7`)).statusCode, 404);
  assert.equal((await inject(app, "POST", "/api/portal/items/nope0000/actions/0")).statusCode, 404);

  assert.deepEqual((await inject(app, "GET", "/api/portal/watches")).json(), { watches: [watch] });
  const done = await inject(app, "PATCH", `/api/portal/watches/${watch.id}`, { status: "done", notes: "All reviewed" });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().watch.status, "done");
  assert.equal(done.json().watch.notes, "All reviewed");
  assert.equal((await inject(app, "PATCH", `/api/portal/watches/${watch.id}`, { status: "paused" })).statusCode, 400);
  assert.equal((await inject(app, "PATCH", "/api/portal/watches/nope0000", { notes: "x" })).statusCode, 404);
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
    ["GET", "/api/portal"], ["GET", "/api/portal/items"], ["PATCH", "/api/portal/items/x"], ["POST", "/api/portal/items/x/actions/0"],
    ["PATCH", "/api/portal/watches/x"], ["POST", "/api/portal/messages"], ["POST", "/api/portal/tick"],
    ["POST", "/api/portal/cancel"], ["GET", "/api/portal/stream"],
  ]) {
    const response = await inject(app, method, url, method === "GET" ? undefined : {}, headers);
    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.deepEqual(response.json(), { error: "Cross-origin requests are not allowed." });
  }
  assert.equal((await inject(app, "GET", "/api/portal", undefined, { "sec-fetch-site": "cross-site" })).statusCode, 403);
});

test("a manual tick answers its report and stores it", async (t) => {
  const { app, model } = await setup(t, { sessions: [sessionMeta()] });
  const response = await inject(app, "POST", "/api/portal/tick");
  assert.equal(response.statusCode, 200);
  const { report } = response.json();
  assert.equal(report.reason, "manual");
  assert.equal(report.modelInvoked, false, "nothing changed, so the model was not called");
  assert.equal(model.doGenerateCalls.length, 0);
  assert.deepEqual((await inject(app, "GET", "/api/portal/ticks")).json().ticks.map((tick) => tick.id), [report.id]);
  assert.equal((await inject(app, "GET", "/api/portal")).json().status.lastTick.id, report.id);
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

test("GET /api/portal/stream opens with status, items, watches, forwards events, and counts presence", async (t) => {
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
  assert.deepEqual(await next(), { type: "watches", watches: [] });
  assert.equal(presence.count(), before + 1, "an open stream counts as a present browser");

  // A runtime event reaches the stream: a manual tick emits status and tick events. (No keep-alive,
  // or closing the app waits for the idle socket to time out.)
  await fetch(`http://127.0.0.1:${port}/api/portal/tick`, { method: "POST", headers: { connection: "close" } });
  let event;
  do event = await next(); while (event.type !== "tick");
  assert.equal(event.report.reason, "manual");

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
  ctx.sessions = {
    ready: Promise.resolve(),
    listSessions: () => [{ id: "s1" }],
    sendPrompt: async (id, text) => { calls.push(["prompt", id, text]); },
    deleteSession: async (id) => id === "s1",
    listAgents: () => [{ id: "fake", name: "Fake agent" }],
    defaultAgentId: "fake",
  };
  ctx.projects = { ready: Promise.resolve(), list: () => [{ id: "p1" }], get: (id) => (id === "p1" ? { id } : undefined) };
  ctx.settings = { read: async () => ({ scripts: { preWorktreeDelete: { command: "", timeoutSeconds: 60, abortOnFailure: false } } }), orchestrator: async () => ({ provider: "openai" }), apiKey: async (p) => `key-${p}`, subscribe: () => () => {} };
  assert.deepEqual(await deps.sessions.list(), [{ id: "s1" }]);
  await deps.sessions.prompt("s1", "hi");
  assert.deepEqual(calls, [["prompt", "s1", "hi"]]);
  assert.equal(await deps.sessions.remove("s1"), true);
  assert.deepEqual(await deps.projects.list(), [{ id: "p1" }]);
  assert.equal(await deps.projects.get("zz"), undefined);
  assert.deepEqual(await deps.agents.list(), [{ id: "fake", name: "Fake agent" }], "the sessions service's agents, not the built-in ones");
  assert.equal(await deps.agents.defaultId(), "fake");
  assert.equal(await settings.apiKey("anthropic"), "key-anthropic");
  // Scripts read their settings from the context's settings service; an unset script does not run.
  assert.deepEqual(await deps.scripts.run("preWorktreeDelete", { cwd: home }), { ran: false });
});
