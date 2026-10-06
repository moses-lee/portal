import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { fakeDeps, fakeSettings, fakeTimers, flush, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

// Nothing here may touch the real ~/.portal (the settings and projects services still look there for legacy files).
const home = mkdtempSync(path.join(os.tmpdir(), "portal-workspace-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { appContext, buildApp } = await import("../src/app.ts");
const { createPgSessionStore } = await import("../src/sessions/pg-session-store.ts");

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

function sessionRecord(id) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1", createdAt: 1, lastActiveAt: 1, title: null,
    upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false,
  };
}

/**
 * The app over a throwaway database holding sessions s1 and s2 (rows the sessions runtime loads at
 * boot, so the delete route and the purge find them), with a runtime that never reaches a provider.
 * The fake deps' `onDeleted` is bridged to the real sessions runtime once the app is built, as the
 * live deps do.
 */
async function setup(t, { doStream } = {}) {
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
  const model = new MockLanguageModelV3({ doStream });
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings(), deps, timers, model: () => model } });
  t.after(() => app.close());
  const ctx = appContext(app);
  ctx.sessions.onSessionsChange((change) => {
    if (change.type === "deleted") for (const listener of deleted) listener(change.id);
  });
  await ctx.orchestrator.ready;
  const events = [];
  const unsubscribe = ctx.orchestrator.subscribe((event) => { if (event.type === "workspace") events.push(event); });
  t.after(unsubscribe);
  const inject = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });
  const post = async (op, headers) => inject("POST", "/api/workspace/ops", op, headers);
  const read = async () => (await inject("GET", "/api/workspace")).json().workspace;
  const activity = async () => (await inject("GET", "/api/portal/activity?kind=workspace.")).json().entries;
  return { app, ctx, database, timers, events, deleted, model, inject, post, read, activity };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("GET /api/workspace and POST /api/workspace/ops answer their shapes, push every change, and leave a no-op alone", async (t) => {
  const { post, read, events } = await setup(t);
  assert.deepEqual(await read(), { tabs: [], version: 0 });

  const opened = await post({ op: "open", sessionId: "s1" });
  assert.equal(opened.statusCode, 200, opened.body);
  const { workspace, location } = opened.json();
  assert.deepEqual(Object.keys(opened.json()).sort(), ["location", "workspace"]);
  assert.equal(workspace.version, 1);
  assert.equal(workspace.tabs.length, 1);
  assert.match(location.tabId, UUID);
  assert.match(location.paneId, UUID);
  assert.deepEqual(workspace.tabs[0], { id: location.tabId, title: null, titleSource: null, createdAt: workspace.tabs[0].createdAt, root: { kind: "pane", id: location.paneId, sessionId: "s1" } });
  assert.deepEqual(events, [{ type: "workspace", workspace }], "the change is pushed whole");

  const again = await post({ op: "open", sessionId: "s1" });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { workspace, location }, "opening an open session answers its location without a change");
  assert.equal(events.length, 1, "and pushes nothing");

  const beside = await post({ op: "open", sessionId: "s2", target: { tabId: location.tabId, paneId: location.paneId, edge: "right" } });
  assert.equal(beside.statusCode, 200, beside.body);
  const split = beside.json().workspace.tabs[0].root;
  assert.equal(split.kind, "split");
  assert.equal(split.direction, "row");
  assert.deepEqual(split.children.map((pane) => pane.sessionId), ["s1", "s2"]);
  assert.equal(beside.json().workspace.version, 2);
  assert.deepEqual(await read(), beside.json().workspace);

  const moved = await post({ op: "move_tab", tabId: location.tabId, index: 0 });
  assert.equal(moved.statusCode, 200);
  assert.equal(moved.json().location, undefined, "ops that place nothing answer no location");
  assert.equal(moved.json().workspace.version, 2, "a no-op move writes nothing");
});

test("400 for a malformed op, 404 for an unknown session, tab, or pane, 409 when the reducer refuses; errors are { error }", async (t) => {
  const { post, read, events } = await setup(t);
  for (const [body, message] of [
    [{ op: "nope" }, "Unknown workspace op."],
    [{}, "Unknown workspace op."],
    [[], "Unknown workspace op."],
    [{ op: "open", sessionId: 5 }, "open needs a sessionId or null."],
    [{ op: "open", sessionId: "s1", target: { tabId: "t" } }, "open target needs tabId, paneId and an edge (left, right, top, bottom)."],
    [{ op: "arrange", sessionIds: ["s1"], preset: "cols" }, "arrange needs a preset: single, columns-2, columns-3, rows-2, grid-2x2, one-beside-two."],
    [{ op: "rename_tab", tabId: "t", title: "x", source: "me" }, 'rename_tab needs source "user" or "portal".'],
  ]) {
    const response = await post(body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(response.json(), { error: message });
  }

  const unknownSession = await post({ op: "open", sessionId: "nope" });
  assert.equal(unknownSession.statusCode, 404);
  assert.deepEqual(unknownSession.json(), { error: 'No session has id "nope".' });
  assert.equal((await post({ op: "arrange", sessionIds: ["s1", "zzz"], preset: "columns-2" })).statusCode, 404);
  assert.equal((await post({ op: "replace_pane", paneId: "p", sessionId: "zzz" })).statusCode, 404);
  const unknownTab = await post({ op: "close_tab", tabId: "nope" });
  assert.equal(unknownTab.statusCode, 404);
  assert.deepEqual(unknownTab.json(), { error: "No tab nope in the workspace." });
  assert.deepEqual((await post({ op: "close_pane", paneId: "nope" })).json(), { error: "No pane nope in the workspace." });

  const duplicate = await post({ op: "arrange", sessionIds: ["s1", "s1"], preset: "columns-2" });
  assert.equal(duplicate.statusCode, 409);
  assert.deepEqual(duplicate.json(), { error: "A session can be open in only one pane." });
  const { location } = (await post({ op: "arrange", sessionIds: ["s1"], preset: "single", title: "Mine" })).json();
  const tooLong = await post({ op: "rename_tab", tabId: location.tabId, title: "x".repeat(61), source: "user" });
  assert.equal(tooLong.statusCode, 400);

  assert.equal((await read()).version, 1, "only the arrange was written");
  assert.equal(events.length, 1, "refused ops push nothing");
});

test("the routes act as the user whatever the body claims: a rename or an arrange's title is the user's, so the orchestrator cannot rename over it", async (t) => {
  const { ctx, post, read, activity } = await setup(t);
  const arranged = await post({ op: "arrange", sessionIds: ["s1"], preset: "single", title: "Mine", titleSource: "portal" });
  assert.equal(arranged.statusCode, 200, arranged.body);
  const { tabId } = arranged.json().location;
  assert.deepEqual((await read()).tabs.map((tab) => [tab.title, tab.titleSource]), [["Mine", "user"]], "titleSource is stamped user over the body's portal");

  const renamed = await post({ op: "rename_tab", tabId, title: "Still mine", source: "portal" });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.deepEqual((await read()).tabs.map((tab) => [tab.title, tab.titleSource]), [["Still mine", "user"]], "source is stamped user: the user may rename their own tab");
  assert.deepEqual((await activity()).map((entry) => [entry.kind, entry.detail.actor]), [["workspace.renamed", "user"], ["workspace.arranged", "user"]]);

  await assert.rejects(ctx.orchestrator.hub.workspace.apply({ op: "rename_tab", tabId, title: "Portal's", source: "portal" }, "portal"), /The user named this tab "Still mine"/, "the service still refuses Portal");
  const untitled = await post({ op: "arrange", sessionIds: ["s2"], preset: "single", titleSource: "portal" });
  assert.equal(untitled.statusCode, 200, untitled.body);
  assert.deepEqual((await read()).tabs.at(-1).titleSource, null, "no title, no stamp");
});

test("structural ops are logged as workspace.* entries by the user; move_tab and resize are not", async (t) => {
  const { post, activity } = await setup(t);
  const { location: first } = (await post({ op: "open", sessionId: "s1" })).json();
  const { location: arranged, workspace } = (await post({ op: "arrange", sessionIds: ["s1", "s2"], preset: "columns-2", title: "Review" })).json();
  await post({ op: "rename_tab", tabId: arranged.tabId, title: "Both", source: "user" });
  const split = workspace.tabs.find((tab) => tab.id === arranged.tabId).root;
  assert.equal(workspace.tabs.length, 1, "s1 moved into the arranged tab, so its old tab went away");
  await post({ op: "resize", splitId: split.id, sizes: [30, 70] });
  await post({ op: "move_tab", tabId: arranged.tabId, index: 0 });
  const [s1Pane, s2Pane] = split.children;
  await post({ op: "close_pane", paneId: s2Pane.id });
  await post({ op: "replace_pane", paneId: s1Pane.id, sessionId: "s2" });
  await post({ op: "close_tab", tabId: arranged.tabId });

  const entries = (await activity()).map(({ actor, kind, summary, refs, detail }) => ({ actor, kind, summary, refs, detail }));
  assert.deepEqual(entries, [
    { actor: "user", kind: "workspace.closed", summary: 'Closed tab "Both"', refs: { sessionId: "s2", projectId: "p2" }, detail: { actor: "user", tabId: arranged.tabId, what: "tab" } },
    { actor: "user", kind: "workspace.opened", summary: 'Opened "Claude Code session s2" in a pane', refs: { sessionId: "s2", projectId: "p2" }, detail: { actor: "user", tabId: arranged.tabId, paneId: s1Pane.id } },
    { actor: "user", kind: "workspace.closed", summary: 'Closed the pane of "Claude Code session s2"', refs: { sessionId: "s2", projectId: "p2" }, detail: { actor: "user", tabId: arranged.tabId, paneId: s2Pane.id, what: "pane" } },
    { actor: "user", kind: "workspace.renamed", summary: 'Renamed tab "Review" to "Both"', refs: {}, detail: { actor: "user", tabId: arranged.tabId, from: "Review", to: "Both" } },
    { actor: "user", kind: "workspace.arranged", summary: 'Arranged 2 sessions as columns-2 in tab "Review"', refs: {}, detail: { actor: "user", tabId: arranged.tabId, preset: "columns-2", sessionIds: ["s1", "s2"] } },
    { actor: "user", kind: "workspace.opened", summary: 'Opened "Fix the login bug" in a new tab', refs: { sessionId: "s1", projectId: "p1" }, detail: { actor: "user", tabId: first.tabId, paneId: first.paneId } },
  ], "newest first; resize and move_tab leave no entry");
});

test("GET /api/portal/stream opens with the workspace right after the tracked list and pushes it after every change", async (t) => {
  const { app, post } = await setup(t);
  const { workspace: initial } = (await post({ op: "open", sessionId: "s1" })).json();
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
  const opening = [];
  for (let i = 0; i < 7; i++) opening.push(await next());
  assert.deepEqual(opening.map((event) => event.type), ["status", "items", "threads", "approvals", "intents", "tracked", "workspace"]);
  assert.deepEqual(opening[6].workspace, initial);

  // No keep-alive, or closing the app waits for the idle socket to time out.
  const posted = await fetch(`http://127.0.0.1:${port}/api/workspace/ops`, {
    method: "POST", headers: { connection: "close", "content-type": "application/json" }, body: JSON.stringify({ op: "open", sessionId: "s2" }),
  });
  assert.equal(posted.status, 200);
  let event;
  do event = await next(); while (event.type !== "workspace");
  assert.equal(event.workspace.version, 2);
  assert.deepEqual(event.workspace.tabs.map((tab) => tab.root.sessionId), ["s1", "s2"]);
  controller.abort();
});

test("deleting a session through the route closes its pane: the split collapses, the change is pushed, nothing is logged", async (t) => {
  const { inject, post, read, events, activity, deleted } = await setup(t);
  assert.equal(deleted.size, 2, "the tracked and workspace services listen for deleted sessions");
  const { location } = (await post({ op: "open", sessionId: "s1" })).json();
  await post({ op: "open", sessionId: "s2", target: { ...location, edge: "bottom" } });
  const before = events.length;
  assert.equal((await inject("DELETE", "/api/sessions/s1")).statusCode, 204);
  for (let i = 0; i < 50 && events.length === before; i++) await flush();
  const workspace = await read();
  assert.equal(workspace.tabs.length, 1);
  assert.deepEqual(workspace.tabs[0].root, { kind: "pane", id: workspace.tabs[0].root.id, sessionId: "s2" }, "the pane left collapses into the tab");
  assert.equal(workspace.version, 3);
  assert.deepEqual(events.at(-1).workspace, workspace);
  assert.deepEqual((await activity()).filter((entry) => entry.kind === "workspace.closed"), [], "the cascade is not logged; the delete is");
});

test("the purge of removed sessions closes every pane those sessions held", async (t) => {
  const { inject, post, read, events } = await setup(t);
  await post({ op: "open", sessionId: "s1" });
  await post({ op: "open", sessionId: "s2" });
  await post({ op: "open", sessionId: null });
  const before = events.length;
  // s1 and s2 point at projects Portal does not list, so emptying Removed deletes them both.
  const purged = await inject("DELETE", "/api/sessions/removed");
  assert.equal(purged.statusCode, 200, purged.body);
  assert.deepEqual(purged.json(), { deleted: 2 });
  for (let i = 0; i < 100 && (events.length < before + 2); i++) await flush();
  const workspace = await read();
  assert.deepEqual(workspace.tabs.map((tab) => tab.root.sessionId), [null], "only the start-page tab is left");
  assert.equal(workspace.version, 5);
});

test("POST /api/portal/messages takes a view beside the message: the turn's prompt says what the user is looking at; a bad view is a 400", async (t) => {
  const { inject, post, model } = await setup(t, { doStream: async () => textStream("ok") });
  const { location } = (await post({ op: "arrange", sessionIds: ["s1", "s2"], preset: "columns-2" })).json();
  const message = (id) => ({ id, role: "user", parts: [{ type: "text", text: "what is this?" }] });

  for (const view of [5, "x", [], { sessionId: 5 }, { sessionId: "s1", tabId: "" }, { paneId: {} }]) {
    const bad = await inject("POST", "/api/portal/messages", { message: message("u0"), view });
    assert.equal(bad.statusCode, 400, JSON.stringify(view));
    assert.match(bad.json().error, /view/);
  }
  assert.equal(model.doStreamCalls.length, 0, "a bad view never starts a turn");

  const response = await inject("POST", "/api/portal/messages", { message: message("u1"), view: { sessionId: "s1", tabId: location.tabId, paneId: location.paneId } });
  assert.equal(response.statusCode, 200, response.body);
  await flush();
  const system = () => model.doStreamCalls.at(-1).prompt.find((entry) => entry.role === "system").content;
  assert.match(system(), /\nYou are looking at: session s1 \(Fix the login bug\), in tab "Fix the login bug \+ Untitled"\.$/);
  assert.match(system(), /Workspace tabs:\n- "Fix the login bug \+ Untitled" \[[0-9a-f]{8}\]: s1 \(idle\), s2 \(idle\)/, "the World section lists the tabs");

  const page = await inject("POST", "/api/portal/threads/main/messages", { message: message("u2"), view: { sessionId: null, tabId: null, paneId: null } });
  assert.equal(page.statusCode, 200, page.body);
  await flush();
  assert.match(system(), /\nYou are looking at: the Portal page, no session\.$/);

  const none = await inject("POST", "/api/portal/messages", { message: message("u3") });
  assert.equal(none.statusCode, 200, none.body);
  await flush();
  assert.doesNotMatch(system(), /You are looking at/, "a message without a view adds no line");
});

test("cross-origin requests to the workspace routes are refused with 403", async (t) => {
  const { inject, read } = await setup(t);
  const headers = { origin: "https://evil.example", host: "portal.local" };
  for (const [method, url, payload] of [["GET", "/api/workspace"], ["POST", "/api/workspace/ops", { op: "open", sessionId: "s1" }]]) {
    assert.equal((await inject(method, url, payload, headers)).statusCode, 403, `${method} ${url}`);
  }
  assert.deepEqual(await read(), { tabs: [], version: 0 });
});
