import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { fakeDeps, fakeSettings, fakeTimers, flush, sessionMeta, T0 } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

// Nothing here may touch the real ~/.portal (the settings and projects services still look there for legacy files).
const home = mkdtempSync(path.join(os.tmpdir(), "portal-tracked-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { appContext, buildApp } = await import("../src/app.ts");
const { createPgSessionStore } = await import("../src/sessions/pg-session-store.ts");

function sessionRecord(id) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1", createdAt: 1, lastActiveAt: 1, title: null,
    upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false,
  };
}

/**
 * The app over a throwaway database holding sessions s1 and s2 (rows the sessions runtime loads at
 * boot), with a runtime that never reaches a provider. The fake deps' `onDeleted` is bridged to the
 * real sessions runtime once the app is built, as the live deps do.
 */
async function setup(t) {
  const database = await temporaryDatabase(t);
  const sessionStore = createPgSessionStore({ db: database.db });
  for (const id of ["s1", "s2"]) await sessionStore.putSession(sessionRecord(id));
  const { deps } = fakeDeps({ sessions: [sessionMeta({ id: "s1", title: "Fix the login bug" }), sessionMeta({ id: "s2", title: null, projectId: "p2" })] });
  const deleted = new Set();
  deps.sessions.onDeleted = (listener) => {
    deleted.add(listener);
    return () => deleted.delete(listener);
  };
  const timers = fakeTimers();
  const model = new MockLanguageModelV3({});
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings(), deps, timers, model: () => model } });
  t.after(() => app.close());
  const ctx = appContext(app);
  ctx.sessions.onSessionsChange((change) => {
    if (change.type === "deleted") for (const listener of deleted) listener(change.id);
  });
  await ctx.orchestrator.ready;
  const events = [];
  const unsubscribe = ctx.orchestrator.subscribe((event) => { if (event.type === "tracked") events.push(event); });
  t.after(unsubscribe);
  return { app, ctx, database, timers, events, deleted };
}

const inject = (app, method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });

test("GET, PUT, and DELETE /api/portal/tracked answer their shapes; PUT 404s unknown sessions and is idempotent", async (t) => {
  const { app, events } = await setup(t);
  assert.deepEqual((await inject(app, "GET", "/api/portal/tracked")).json(), { sessions: [] });

  const put = await inject(app, "PUT", "/api/portal/tracked/s1");
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { session: { sessionId: "s1", trackedAt: T0, trackedBy: "user" } });
  assert.deepEqual(events, [{ type: "tracked", sessions: [{ sessionId: "s1", trackedAt: T0, trackedBy: "user" }] }], "the change is pushed");

  const again = await inject(app, "PUT", "/api/portal/tracked/s1");
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), put.json(), "tracking again keeps the first row");
  assert.equal(events.length, 1, "and pushes nothing");

  const missing = await inject(app, "PUT", "/api/portal/tracked/nope");
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "Unknown session." });
  const nul = await inject(app, "PUT", "/api/portal/tracked/s2%00");
  assert.equal(nul.statusCode, 404, "an id holding U+0000 is unknown, not s2");
  assert.equal((await inject(app, "DELETE", "/api/portal/tracked/s1%00")).statusCode, 204);
  assert.equal((await inject(app, "GET", "/api/portal/tracked")).json().sessions.length, 1, "and untracks nothing");

  assert.equal((await inject(app, "PUT", "/api/portal/tracked/s2")).statusCode, 200);
  assert.deepEqual((await inject(app, "GET", "/api/portal/tracked")).json().sessions.map((row) => row.sessionId), ["s1", "s2"]);

  const removed = await inject(app, "DELETE", "/api/portal/tracked/s1");
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");
  assert.deepEqual((await inject(app, "GET", "/api/portal/tracked")).json().sessions.map((row) => row.sessionId), ["s2"]);
  assert.deepEqual(events.at(-1).sessions.map((row) => row.sessionId), ["s2"]);
  const count = events.length;
  assert.equal((await inject(app, "DELETE", "/api/portal/tracked/s1")).statusCode, 204, "untracking an untracked session is still a 204");
  assert.equal((await inject(app, "DELETE", "/api/portal/tracked/nope")).statusCode, 204);
  assert.equal(events.length, count, "and pushes nothing");
});

test("tracking and untracking are logged as session.tracked and session.untracked", async (t) => {
  const { app } = await setup(t);
  await inject(app, "PUT", "/api/portal/tracked/s1");
  await inject(app, "PUT", "/api/portal/tracked/s1");
  await inject(app, "PUT", "/api/portal/tracked/s2");
  await inject(app, "DELETE", "/api/portal/tracked/s1");
  await inject(app, "DELETE", "/api/portal/tracked/s1");
  const entries = (await inject(app, "GET", "/api/portal/activity?kind=session.")).json().entries;
  assert.deepEqual(entries.map(({ actor, kind, summary, refs, detail }) => ({ actor, kind, summary, refs, detail })), [
    { actor: "user", kind: "session.untracked", summary: 'Untracked "Fix the login bug"', refs: { sessionId: "s1", projectId: "p1" }, detail: { trackedBy: "user" } },
    { actor: "user", kind: "session.tracked", summary: 'Tracked "Claude Code session s2"', refs: { sessionId: "s2", projectId: "p2" }, detail: { trackedBy: "user" } },
    { actor: "user", kind: "session.tracked", summary: 'Tracked "Fix the login bug"', refs: { sessionId: "s1", projectId: "p1" }, detail: { trackedBy: "user" } },
  ], "one entry per change, newest first; repeats log nothing");
});

test("the tracked service records Portal as the tracker, with the reason and the run", async (t) => {
  const { ctx, events } = await setup(t);
  const tracked = ctx.orchestrator.hub.tracked;
  assert.deepEqual(await tracked.track("s2", "portal", { runId: "r1", threadId: "main" }), {
    session: { sessionId: "s2", trackedAt: T0, trackedBy: "portal" }, created: true,
  });
  assert.equal(await tracked.track("zzz", "portal"), null);
  assert.equal(await tracked.isTracked("s2"), true);
  assert.equal(await tracked.untrack("s2", "portal", { reason: "  review summarised  ", runId: "r2" }), true);
  assert.equal(await tracked.untrack("s2", "portal"), false);
  assert.deepEqual(await tracked.list(), []);
  assert.deepEqual(events.map((event) => event.sessions.length), [1, 0]);
  const entries = await ctx.orchestrator.hub.activity.list({ kind: "session." });
  assert.deepEqual(entries.map(({ actor, kind, summary, refs, detail }) => ({ actor, kind, summary, refs, detail })), [
    {
      actor: "agent", kind: "session.untracked", summary: 'Untracked "Claude Code session s2": review summarised', refs: { sessionId: "s2", projectId: "p2", runId: "r2" },
      detail: { trackedBy: "portal", reason: "review summarised" },
    },
    { actor: "agent", kind: "session.tracked", summary: 'Tracked "Claude Code session s2"', refs: { sessionId: "s2", projectId: "p2", runId: "r1", threadId: "main" }, detail: { trackedBy: "portal" } },
  ]);
});

test("a track that lands while its session is being deleted is taken back: no row, no log, no push", async (t) => {
  const { app, ctx, database, events } = await setup(t);
  // The runtime has already dropped s3 (so the deps no longer know it), but its row is still there.
  await createPgSessionStore({ db: database.db }).putSession(sessionRecord("s3"));
  const put = await inject(app, "PUT", "/api/portal/tracked/s3");
  assert.equal(put.statusCode, 404);
  assert.equal(await ctx.orchestrator.hub.tracked.track("s3", "portal"), null);
  assert.deepEqual(await ctx.orchestrator.hub.tracked.list(), []);
  assert.deepEqual(events, []);
  assert.deepEqual(await ctx.orchestrator.hub.activity.list({ kind: "session." }), []);
});

test("two concurrent tracks of one session make one row, one log entry, and one push", async (t) => {
  const { ctx, events } = await setup(t);
  const tracked = ctx.orchestrator.hub.tracked;
  const results = await Promise.all([tracked.track("s1", "user"), tracked.track("s1", "portal"), tracked.track("s1", "user")]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => JSON.stringify(result.session))).size, 1, "every caller sees the same row");
  assert.equal(events.length, 1);
  assert.equal((await ctx.orchestrator.hub.activity.list({ kind: "session.tracked" })).length, 1);
});

test("deleting a tracked session drops its row and pushes the list, without logging an untrack", async (t) => {
  const { app, ctx, events, deleted } = await setup(t);
  assert.equal(deleted.size, 1, "the service listens for deleted sessions");
  await inject(app, "PUT", "/api/portal/tracked/s1");
  await inject(app, "PUT", "/api/portal/tracked/s2");
  const response = await inject(app, "DELETE", "/api/sessions/s1");
  assert.equal(response.statusCode, 204);
  for (let i = 0; i < 50 && events.at(-1).sessions.length !== 1; i++) await flush();
  assert.deepEqual(events.at(-1).sessions.map((row) => row.sessionId), ["s2"]);
  assert.deepEqual((await inject(app, "GET", "/api/portal/tracked")).json().sessions.map((row) => row.sessionId), ["s2"]);
  assert.deepEqual((await ctx.orchestrator.hub.activity.list({ kind: "session.untracked" })), []);
  await app.close();
  assert.equal(deleted.size, 0, "disposing the orchestrator stops listening");
});

test("liveDeps.sessions.onDeleted forwards the sessions runtime's deletes only", async () => {
  const { liveDeps } = await import("../src/orchestrator/deps.ts");
  const listeners = new Set();
  const ctx = { sessions: { onSessionsChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } } };
  const ids = [];
  const unsubscribe = liveDeps(ctx).sessions.onDeleted((id) => ids.push(id));
  for (const listener of listeners) {
    listener({ type: "updated", id: "s1", patch: {} });
    listener({ type: "created", session: { id: "s2" } });
    listener({ type: "deleted", id: "s3" });
  }
  assert.deepEqual(ids, ["s3"]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("GET /api/portal/stream opens with the tracked list and pushes it after every change", async (t) => {
  const { app } = await setup(t);
  await inject(app, "PUT", "/api/portal/tracked/s1");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${port}/api/portal/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
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
  async function nextTracked() {
    let event;
    do event = await next(); while (event.type !== "tracked");
    return event;
  }
  const opening = [];
  for (let i = 0; i < 6; i++) opening.push(await next());
  assert.deepEqual(opening.map((event) => event.type), ["status", "items", "threads", "approvals", "intents", "tracked"]);
  assert.deepEqual(opening[5].sessions, [{ sessionId: "s1", trackedAt: T0, trackedBy: "user" }]);

  // No keep-alive, or closing the app waits for the idle socket to time out.
  const headers = { connection: "close" };
  await fetch(`http://127.0.0.1:${port}/api/portal/tracked/s2`, { method: "PUT", headers });
  assert.deepEqual((await nextTracked()).sessions.map((row) => row.sessionId), ["s1", "s2"]);
  await fetch(`http://127.0.0.1:${port}/api/portal/tracked/s1`, { method: "DELETE", headers });
  assert.deepEqual((await nextTracked()).sessions.map((row) => row.sessionId), ["s2"]);
  controller.abort();
});

test("cross-origin requests to the tracked routes are refused with 403", async (t) => {
  const { app } = await setup(t);
  const headers = { origin: "https://evil.example", host: "portal.local" };
  for (const [method, url] of [["GET", "/api/portal/tracked"], ["PUT", "/api/portal/tracked/s1"], ["DELETE", "/api/portal/tracked/s1"]]) {
    assert.equal((await inject(app, method, url, undefined, headers)).statusCode, 403, `${method} ${url}`);
  }
  assert.deepEqual((await inject(app, "GET", "/api/portal/tracked")).json(), { sessions: [] });
});
