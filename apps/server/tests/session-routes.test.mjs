import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { appContext, buildApp } from "../src/app.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const EVIL = { origin: "http://evil.example" };

async function until(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
  }
}

/**
 * A migrated database with two projects (one whose folder is gone) and a factory for apps whose
 * sessions run the fake ACP agent. Apps are closed before the database is dropped.
 */
async function setup(t, { recentEvents } = {}) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-session-routes-")));
  process.env.PORTAL_HOME = path.join(scratch, "home");
  const logPath = path.join(scratch, "agent.jsonl");
  const configPath = path.join(scratch, "config.json");
  writeFileSync(logPath, "");
  writeFileSync(configPath, JSON.stringify({ claude: "resume" }));
  const agents = ["claude", "codex"].map((id) => ({
    id,
    name: id === "claude" ? "Claude Code" : "Codex",
    command: process.execPath,
    args: [fixturePath, id, logPath, configPath],
    authHint: `Log in to ${id} on the host.`,
  }));

  const teardown = [];
  const database = await temporaryDatabase({ after: (fn) => teardown.push(fn) });
  const apps = [];
  t.after(async () => {
    for (const app of apps) await app.close().catch(() => {});
    for (const fn of teardown) await fn();
    rmSync(scratch, { recursive: true, force: true });
  });
  await database.sql`insert into projects (id, name, path, created_at) values
    ('proj-1', 'Repo', ${scratch}, 1), ('proj-gone', 'Gone', ${path.join(scratch, "missing")}, 2)`;

  const makeApp = async () => {
    // A "restart" builds a second app over the same database while the first is still open.
    const app = await buildApp({ database, orchestrator: false, singleInstance: false, sessions: { agents, initializeTimeoutMs: 2_000, recentEvents } });
    apps.push(app);
    return app;
  };
  const messages = (method) => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((entry) => entry.message?.method === method);
  return { app: await makeApp(), makeApp, scratch, messages };
}

async function createSession(app, payload = { projectId: "proj-1" }) {
  const response = await app.inject({ method: "POST", url: "/api/sessions", payload });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function events(app, id, query = "") {
  const response = await app.inject({ method: "GET", url: `/api/sessions/${id}/events${query}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

/** Prompt, approve the permission the fake agent asks for, and wait for the turn to end. */
async function runTurn(app, id, text = "hello") {
  const prompted = await app.inject({ method: "POST", url: `/api/sessions/${id}/prompt`, payload: { text } });
  assert.equal(prompted.statusCode, 202, prompted.body);
  let request;
  await until(async () => {
    request = (await events(app, id)).events.findLast((e) => e.type === "permission_request");
    return request && !(await events(app, id)).events.some((e) => e.type === "permission_response" && e.requestId === request.requestId);
  }, "permission request");
  const answered = await app.inject({ method: "POST", url: `/api/sessions/${id}/permission`, payload: { requestId: request.requestId, optionId: "once" } });
  assert.equal(answered.statusCode, 200, answered.body);
  assert.deepEqual(answered.json(), { ok: true });
  await until(async () => (await events(app, id)).events.at(-1)?.type === "turn_end", "turn end");
}

/** Reads an SSE response frame by frame; comment frames (pings) are skipped. */
function sseReader(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame = { event: "message", id: undefined, data: "" };
          let comment = true;
          for (const line of raw.split("\n")) {
            if (line.startsWith(":")) continue;
            comment = false;
            const [field, ...rest] = line.split(": ");
            const value = rest.join(": ");
            if (field === "event") frame.event = value;
            else if (field === "id") frame.id = value;
            else if (field === "data") frame.data = value;
          }
          if (comment) continue;
          return { ...frame, data: frame.data ? JSON.parse(frame.data) : null };
        }
        const remaining = deadline - Date.now();
        assert.ok(remaining > 0, "Timed out waiting for an SSE frame");
        const chunk = await Promise.race([reader.read(), delay(remaining).then(() => ({ timeout: true }))]);
        if (chunk.timeout) continue;
        if (chunk.done) return null;
        buffer += chunk.value;
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

test("GET /api/agents lists the configured agents and the default", async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({ method: "GET", url: "/api/agents" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { agents: [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }], defaultAgentId: "claude" });
});

test("POST /api/sessions validates like the web route and creates a session in the project folder", async (t) => {
  const { app, scratch } = await setup(t);
  const post = (payload, headers) => app.inject({ method: "POST", url: "/api/sessions", payload, headers });

  assert.deepEqual((await post([])).json(), { error: "Expected a JSON object." });
  assert.equal((await post([])).statusCode, 400);
  const noProject = await post({});
  assert.equal(noProject.statusCode, 400);
  assert.deepEqual(noProject.json(), { error: "Choose a project to start the session in." });
  const badAgent = await post({ projectId: "proj-1", agentId: "gemini" });
  assert.equal(badAgent.statusCode, 400);
  assert.deepEqual(badAgent.json(), { error: "Unknown agent. Choose an agent from the dropdown." });
  const noSuchProject = await post({ projectId: "nope" });
  assert.equal(noSuchProject.statusCode, 404);
  assert.deepEqual(noSuchProject.json(), { error: "Unknown project." });
  const missing = await post({ projectId: "proj-gone" });
  assert.equal(missing.statusCode, 409);
  assert.match(missing.json().error, /^Project folder is missing: /);
  const crossOrigin = await post({ projectId: "proj-1" }, EVIL);
  assert.equal(crossOrigin.statusCode, 403);
  assert.deepEqual(crossOrigin.json(), { error: "Cross-origin requests are not allowed." });
  assert.equal((await app.inject({ method: "GET", url: "/api/sessions" })).json().sessions.length, 0);

  const session = await createSession(app);
  assert.equal(session.agentId, "claude");
  assert.equal(session.agentName, "Claude Code");
  assert.equal(session.cwd, scratch);
  assert.equal(session.projectId, "proj-1");
  assert.deepEqual(session.project, { id: "proj-1", name: "Repo" });
  assert.equal(session.cwdMissing, false);
  assert.equal(session.busy, false);
  assert.equal(session.awaitingPermission, false);
  assert.deepEqual(session.link, { status: "live" });
  assert.equal(session.title, null);
  assert.equal(typeof session.displayCwd, "string");
  assert.equal(session.state.configOptions.length, 3);
  const codex = await createSession(app, { projectId: "proj-1", agentId: "codex" });
  assert.equal(codex.agentId, "codex");

  const list = await app.inject({ method: "GET", url: "/api/sessions" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().sessions.map(({ id }) => id).sort(), [session.id, codex.id].sort());
  const one = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().id, session.id);
  assert.deepEqual(one.json().project, { id: "proj-1", name: "Repo" });
  const unknown = await app.inject({ method: "GET", url: "/api/sessions/nope" });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "Unknown session." });
});

test("prompt, permission, config, cancel, attach, events, and delete behave like the web routes", async (t) => {
  const { app, messages } = await setup(t);
  const session = await createSession(app);
  const post = (suffix, payload, headers) => app.inject({ method: "POST", url: `/api/sessions/${session.id}/${suffix}`, payload, headers });

  // Prompt.
  assert.deepEqual((await post("prompt", { text: "   " })).json(), { error: "empty prompt" });
  assert.equal((await post("prompt", {})).statusCode, 400);
  assert.equal((await post("prompt", { text: "hi" }, EVIL)).statusCode, 403);
  const unknownPrompt = await app.inject({ method: "POST", url: "/api/sessions/nope/prompt", payload: { text: "hi" } });
  assert.equal(unknownPrompt.statusCode, 409);
  assert.match(unknownPrompt.json().error, /no such session/i);

  // Permission validation, then a full turn.
  assert.equal((await post("permission", { requestId: "" , optionId: "x" })).statusCode, 400);
  assert.deepEqual((await post("permission", { requestId: "r" })).json(), { error: "Expected {requestId, optionId: string | null}." });
  const stale = await post("permission", { requestId: "r", optionId: null });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: "That permission request is no longer open." });
  await runTurn(app, session.id);
  const page = await events(app, session.id);
  assert.deepEqual(page.events.map(({ type }) => type), ["user", "turn_start", "update", "permission_request", "permission_response", "turn_end"]);
  assert.equal(page.nextSeq, 6);
  assert.equal(page.hasMore, false);
  assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json().title, "hello");

  // Events paging and validation.
  assert.deepEqual((await events(app, session.id, "?before=0")).events, []);
  for (const query of ["?limit=0", "?limit=abc", "?before=-1", "?before=1.5"]) {
    const bad = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/events${query}` });
    assert.equal(bad.statusCode, 400, query);
    assert.deepEqual(bad.json(), { error: "Invalid page cursor." });
  }
  const noEvents = await app.inject({ method: "GET", url: "/api/sessions/nope/events" });
  assert.equal(noEvents.statusCode, 404);
  assert.deepEqual(noEvents.json(), { error: "Unknown session." });
  // Large pages go out gzipped (the global compress plugin replaces the web's jsonResponse).
  for (let i = 0; i < 3; i++) await runTurn(app, session.id, `turn ${i} ${"x".repeat(300)}`);
  const zipped = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/events`, headers: { "accept-encoding": "gzip" } });
  assert.equal(zipped.headers["content-encoding"], "gzip");

  // Config.
  assert.deepEqual((await post("config", { modeId: "plan", value: "x" })).json(), { error: "Expected {configId, value} or {modeId}." });
  assert.equal((await post("config", { configId: "fast", value: "" })).statusCode, 400);
  assert.equal((await post("config", { modeId: "plan" }, EVIL)).statusCode, 403);
  const mode = await post("config", { modeId: "plan" });
  assert.equal(mode.statusCode, 200, mode.body);
  assert.equal(mode.json().state.modes.currentModeId, "plan");
  const option = await post("config", { configId: "model", value: "smart" });
  assert.equal(option.statusCode, 200, option.body);
  assert.equal(option.json().state.configOptions.find(({ id }) => id === "model").currentValue, "smart");
  const unknownConfig = await app.inject({ method: "POST", url: "/api/sessions/nope/config", payload: { modeId: "plan" } });
  assert.equal(unknownConfig.statusCode, 409);

  // Cancel and attach.
  const cancelled = await post("cancel");
  assert.equal(cancelled.statusCode, 200);
  assert.deepEqual(cancelled.json(), { ok: true });
  await until(() => messages("session/cancel").length === 1, "session/cancel");
  assert.equal((await post("cancel", undefined, EVIL)).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/sessions/nope/cancel" })).statusCode, 409);
  assert.deepEqual((await post("attach")).json(), { ok: true });
  assert.equal((await post("attach", undefined, EVIL)).statusCode, 403);
  const unknownAttach = await app.inject({ method: "POST", url: "/api/sessions/nope/attach" });
  assert.equal(unknownAttach.statusCode, 404);
  assert.match(unknownAttach.json().error, /no such session/i);

  // Delete.
  const refused = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}`, headers: EVIL });
  assert.equal(refused.statusCode, 403);
  const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  const again = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
  assert.equal(again.statusCode, 404);
  assert.deepEqual(again.json(), { error: "Unknown session." });
  assert.equal((await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })).statusCode, 404);
});

test("GET /api/sessions/stream sends a snapshot, then created/updated/deleted changes, and counts presence", async (t) => {
  const { app } = await setup(t);
  const existing = await createSession(app);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const { presence } = appContext(app);
  const before = presence.count();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/sessions/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  const stream = sseReader(response);

  const snapshot = await stream.next();
  assert.equal(snapshot.data.type, "snapshot");
  assert.deepEqual(snapshot.data.sessions, [{ id: existing.id, busy: false, awaitingPermission: false, link: { status: "live" }, title: null, lastActiveAt: existing.lastActiveAt }]);
  assert.equal(presence.count(), before + 1);

  const created = await createSession(app, { projectId: "proj-1", agentId: "codex" });
  const createdFrame = await stream.next();
  assert.equal(createdFrame.data.type, "created");
  assert.equal(createdFrame.data.session.id, created.id);
  assert.deepEqual(createdFrame.data.session.project, { id: "proj-1", name: "Repo" });
  assert.equal(typeof createdFrame.data.session.displayCwd, "string");

  await app.inject({ method: "POST", url: `/api/sessions/${created.id}/prompt`, payload: { text: "hold" } });
  const updated = await stream.next();
  assert.equal(updated.data.type, "updated");
  assert.equal(updated.data.id, created.id);
  assert.equal(updated.data.patch.busy, true);
  assert.equal(updated.data.patch.title, "hold");

  await app.inject({ method: "DELETE", url: `/api/sessions/${existing.id}` });
  let frame;
  do frame = await stream.next(); while (frame.data.type !== "deleted");
  assert.deepEqual(frame.data, { type: "deleted", id: existing.id });

  await stream.cancel();
  controller.abort();
  await until(() => presence.count() === before, "presence to drop when the stream closes");
});

test("GET /api/sessions/:id/stream replays after the cursor, sends meta, tails, and reports deletion", async (t) => {
  const { app } = await setup(t, { recentEvents: 3 });
  const session = await createSession(app);
  await runTurn(app, session.id);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const open = (query = "", headers = {}) => fetch(`${base}/api/sessions/${session.id}/stream${query}`, { headers });

  // Unknown sessions and bad cursors are plain-text errors, as before.
  const unknown = await fetch(`${base}/api/sessions/nope/stream`);
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), "no such session");
  const badCursor = await open("?since=abc");
  assert.equal(badCursor.status, 400);
  assert.equal(await badCursor.text(), "invalid event cursor");

  // Only the last three events are in memory: seqs 3, 4, 5.
  const replay = sseReader(await open("?since=2"));
  const replayed = [await replay.next(), await replay.next(), await replay.next()];
  assert.deepEqual(replayed.map(({ id }) => id), ["3", "4", "5"]);
  assert.deepEqual(replayed.map(({ data }) => data.type), ["permission_request", "permission_response", "turn_end"]);
  assert.equal(replayed[2].data.seq, undefined);
  assert.equal(replayed[2].data.ts, undefined);
  const meta = await replay.next();
  assert.equal(meta.event, "meta");
  assert.deepEqual(meta.data.link, { status: "live" });
  assert.equal(meta.data.title, "hello");
  assert.equal(meta.data.cwd, session.cwd);
  assert.equal(meta.data.agentId, "claude");
  assert.deepEqual(meta.data.project, { id: "proj-1", name: "Repo" });
  assert.equal(meta.data.cwdMissing, false);
  assert.equal(meta.data.busy, false);
  await replay.cancel();

  // Last-Event-ID wins over ?since; a cursor at the head replays nothing.
  const caughtUp = sseReader(await open("?since=0", { "last-event-id": "5" }));
  assert.equal((await caughtUp.next()).event, "meta");
  await caughtUp.cancel();

  // A cursor older than memory gets a reset instead of a gap.
  const aged = sseReader(await open());
  assert.equal((await aged.next()).event, "reset");
  assert.equal((await aged.next()).event, "meta");
  await aged.cancel();

  // Live tail: new events arrive with their seq, state changes as meta, deletion as `deleted`.
  const tail = sseReader(await open("?since=5"));
  assert.equal((await tail.next()).event, "meta");
  const next = async (predicate) => {
    for (;;) {
      const frame = await tail.next();
      assert.ok(frame, "stream ended early");
      if (predicate(frame)) return frame;
    }
  };
  await app.inject({ method: "POST", url: `/api/sessions/${session.id}/prompt`, payload: { text: "again" } });
  const user = await next((frame) => frame.event === "message");
  assert.equal(user.id, "6");
  assert.deepEqual(user.data, { type: "user", text: "again" });
  await app.inject({ method: "POST", url: `/api/sessions/${session.id}/config`, payload: { modeId: "plan" } });
  const modeMeta = await next((frame) => frame.event === "meta" && frame.data.state.modes?.currentModeId === "plan");
  assert.equal(modeMeta.data.state.modes.currentModeId, "plan");
  await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
  await next((frame) => frame.event === "deleted");
  assert.equal(await tail.next(), null, "the stream ends after deletion");
});

test("opening a persisted session's stream reattaches its agent and reports it through meta", async (t) => {
  const ctx = await setup(t);
  const session = await createSession(ctx.app);
  await runTurn(ctx.app, session.id);
  await ctx.app.close();

  // A fresh server over the same database sees the session offline until a viewer opens it.
  const app = await ctx.makeApp();
  const listed = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
  assert.deepEqual(listed.json().link, { status: "offline", error: null });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const stream = sseReader(await fetch(`${base}/api/sessions/${session.id}/stream?since=5`));
  const links = [];
  while (links.at(-1) !== "live") {
    const frame = await stream.next();
    assert.ok(frame, "stream ended early");
    if (frame.event === "meta") links.push(frame.data.link.status);
  }
  assert.equal(links[0], "offline");
  assert.ok(links.includes("connecting"));
  assert.equal(ctx.messages("session/resume").length, 1);
  await stream.cancel();
  const page = await events(app, session.id);
  assert.equal(page.nextSeq, 6);
});
