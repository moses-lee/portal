import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { TOOL_GROUPS } from "../src/orchestrator/tools/groups.ts";
import { READ_ONLY_TOOLS, createTools } from "../src/orchestrator/tools/index.ts";
import { createTrackedService } from "../src/orchestrator/tracked/service.ts";
import { createMemoryTrackedStore } from "../src/orchestrator/tracked/store.ts";
import { shapeOf, workspaceTools } from "../src/orchestrator/workspace/tools.ts";
import { describeView, parseView } from "../src/orchestrator/workspace/view.ts";
import { createWorkspaceService } from "../src/workspace/service.ts";
import { createMemoryWorkspaceStore } from "../src/workspace/store.ts";
import { T0, fakeDeps, fakeSettings, liveness, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const options = { toolCallId: "call", messages: [] };

// Ids as the World section shows them: 8-char prefixes of uuids. Two sessions share the prefix "5e0f".
const REVIEW = "17329ac6-0c1e-4c4f-9a57-3d2b1f0e9a01";
const FIRST = "5e0f1b2c-7d3e-4a1b-8c2d-000000000002";
const SECOND = "5e0f9d8e-1a2b-4c3d-9e8f-000000000003";
const PORTAL = "9b1d4e7a-5c6d-4e7f-8a9b-00000000000p";

/** The tool context a chat turn builds, over a fake hub with the real tracked and workspace services on memory stores. */
function setup({ interactive = true, view = null } = {}) {
  const store = createMemoryOrchestratorStore();
  const { deps, state } = fakeDeps({
    projects: [project({ id: PORTAL, name: "portal" })],
    sessions: [
      sessionMeta({ id: REVIEW, projectId: PORTAL, title: "Review auth" }),
      sessionMeta({ id: FIRST, projectId: PORTAL, title: "First", busy: true, liveness: liveness("busy", "running tests") }),
      sessionMeta({ id: SECOND, projectId: "", title: null }),
    ],
  });
  const activity = [];
  const events = [];
  const hub = {
    deps, timers: { now: () => T0 }, emit: (event) => events.push(event),
    activity: { log: async (entry) => { activity.push(entry); } },
    world: { current: async () => ({ tracked: [] }), trackedChanged: () => {} },
    jobs: {}, memory: {},
  };
  hub.tracked = createTrackedService(hub, createMemoryTrackedStore({ sessionExists: (id) => state.sessions.some((meta) => meta.id === id) }));
  const workspaceStore = createMemoryWorkspaceStore();
  hub.workspace = createWorkspaceService(hub, workspaceStore);
  const ctx = {
    store, deps, touched: new Set(), settings: fakeSettings(), interactive, now: () => T0,
    hub, turn: { runId: "run1", threadId: "main", kind: "chat", origin: interactive ? "chat" : "job", view },
  };
  return { tools: { ...createTools(ctx), ...workspaceTools(ctx) }, ctx, deps, state, hub, activity, events, workspaceStore };
}

/** Call a tool the way the SDK does: the input goes through its zod schema first. */
async function run(tool, input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), invalidInput: true };
  return tool.execute(parsed.data, options);
}

const UUID = /^[0-9a-f-]{36}$/;

test("the five workspace tools are a chat turn's always-on group; get_workspace is read-only; background turns get none", () => {
  const { tools } = setup();
  const names = ["get_workspace", "open_in_workspace", "arrange_tab", "close_in_workspace", "rename_tab"];
  for (const name of names) {
    assert.ok(tools[name], `${name} exists`);
    assert.ok(tools[name].description.length > 20, `${name} has a description`);
  }
  assert.deepEqual([...TOOL_GROUPS.workspace.tools], names);
  assert.equal(TOOL_GROUPS.workspace.always, true);
  assert.ok(READ_ONLY_TOOLS.has("get_workspace"));
  for (const name of names.slice(1)) assert.ok(!READ_ONLY_TOOLS.has(name), `${name} changes things`);
  const { ctx } = setup({ interactive: false });
  assert.deepEqual(workspaceTools(ctx), {}, "a background turn offers no workspace tools");
});

test("open_in_workspace takes an id prefix, opens a new tab with its path, logs as Portal, and says when the session was already open", async (t) => {
  const { tools, activity, events } = setup();
  const opened = await run(tools.open_in_workspace, { sessionId: "17329ac6" });
  assert.equal(opened.error, undefined, JSON.stringify(opened));
  assert.equal(opened.sessionId, REVIEW);
  assert.match(opened.tabId, UUID);
  assert.match(opened.paneId, UUID);
  assert.equal(opened.path, `/tabs/${opened.tabId}`);
  assert.equal(opened.opened, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "workspace");
  assert.deepEqual(activity.map(({ actor, kind, summary, refs, detail }) => ({ actor, kind, summary, refs, detail })), [{
    actor: "agent", kind: "workspace.opened", summary: 'Opened "Review auth" in a new tab',
    refs: { sessionId: REVIEW, projectId: PORTAL, runId: "run1", threadId: "main" }, detail: { actor: "portal", tabId: opened.tabId, paneId: opened.paneId },
  }]);

  const again = await run(tools.open_in_workspace, { sessionId: REVIEW });
  assert.deepEqual(again, { sessionId: REVIEW, tabId: opened.tabId, paneId: opened.paneId, path: opened.path, opened: false, note: "It was already open in the workspace; nothing changed." });
  assert.equal(events.length, 1, "nothing pushed for a no-op");
  assert.equal(activity.length, 1);

  assert.match((await run(tools.open_in_workspace, { sessionId: "5e0f" })).error, /ambiguous: 2 sessions start with it/);
  assert.match((await run(tools.open_in_workspace, { sessionId: "zzzz" })).error, /^No session has id "zzzz"/);
  assert.equal((await run(tools.open_in_workspace, { sessionId: "" })).invalidInput, true);
});

test("open_in_workspace beside a session splits its pane on the given edge; get_workspace shows the shape, names, states, and the view", async () => {
  const { tools, ctx } = setup();
  const first = await run(tools.open_in_workspace, { sessionId: "17329ac6" });
  const beside = await run(tools.open_in_workspace, { sessionId: "5e0f1b2c", besideSessionId: "17329ac6" });
  assert.equal(beside.tabId, first.tabId, "the same tab");
  assert.notEqual(beside.paneId, first.paneId);
  const below = await run(tools.open_in_workspace, { sessionId: SECOND, besideSessionId: "5e0f1b2c", edge: "bottom" });
  assert.equal(below.tabId, first.tabId);

  const notOpen = await run(tools.open_in_workspace, { sessionId: SECOND, besideSessionId: "17329ac6" });
  assert.equal(notOpen.opened, false, "the session is already open; nothing moves");
  await run(tools.close_in_workspace, { sessionId: SECOND });
  const closedBeside = await run(tools.open_in_workspace, { sessionId: FIRST, besideSessionId: SECOND });
  assert.match(closedBeside.error, /^Session 5e0f9d8e is not open in the workspace; open it first/);

  let listed = await run(tools.get_workspace, {});
  assert.equal(listed.lookingAt, null);
  assert.match(listed.note, /no view/);
  assert.equal(listed.tabs.length, 1);
  const [tab] = listed.tabs;
  assert.equal(tab.id, first.tabId);
  assert.equal(tab.name, "Review auth + First");
  assert.equal(tab.namedBy, null);
  assert.equal(tab.shape, "row[pane, pane]");
  assert.equal(tab.preset, "columns-2");
  assert.equal(tab.path, `/tabs/${first.tabId}`);
  assert.deepEqual(tab.panes, [
    { paneId: first.paneId, sessionId: "17329ac6", title: "Review auth", state: "idle" },
    { paneId: beside.paneId, sessionId: "5e0f1b2c", title: "First", state: "busy", status: "running tests" },
  ]);

  await run(tools.open_in_workspace, { sessionId: SECOND, besideSessionId: "5e0f1b2c", edge: "bottom" });
  ctx.turn.view = { sessionId: REVIEW, tabId: first.tabId, paneId: first.paneId };
  listed = await run(tools.get_workspace, {});
  assert.equal(listed.tabs[0].shape, "row[pane, column[pane, pane]]");
  assert.equal(listed.tabs[0].preset, "one-beside-two");
  assert.equal(listed.tabs[0].name, "3 sessions");
  assert.deepEqual(listed.tabs[0].panes.map((pane) => [pane.sessionId, pane.title]), [["17329ac6", "Review auth"], ["5e0f1b2c", "First"], ["5e0f9d8e", null]]);
  assert.deepEqual(listed.lookingAt, {
    sessionId: REVIEW, title: "Review auth", tabId: first.tabId, tabName: "3 sessions", paneId: first.paneId, text: 'session 17329ac6 (Review auth), in tab "3 sessions".',
  });
  assert.equal(listed.note, undefined);

  ctx.turn.view = { sessionId: null, tabId: null, paneId: null };
  assert.equal((await run(tools.get_workspace, {})).lookingAt.text, "the Portal page, no session.");
  ctx.turn.view = { sessionId: REVIEW, tabId: null, paneId: null };
  assert.equal((await run(tools.get_workspace, {})).lookingAt.text, "session 17329ac6 (Review auth).", "the tracked panel names no tab");
});

test("arrange_tab builds a preset in a new tab or rebuilds one by id prefix, naming it as Portal; sessions open elsewhere move", async () => {
  const { tools, activity } = setup();
  const review = await run(tools.open_in_workspace, { sessionId: REVIEW });
  const arranged = await run(tools.arrange_tab, { sessionIds: ["17329ac6", "5e0f1b2c"], preset: "columns-2", title: "Review pair" });
  assert.equal(arranged.error, undefined, JSON.stringify(arranged));
  assert.deepEqual(arranged, { tabId: arranged.tabId, path: `/tabs/${arranged.tabId}`, preset: "columns-2", sessionIds: [REVIEW, FIRST], rebuilt: false });
  assert.notEqual(arranged.tabId, review.tabId);
  let listed = await run(tools.get_workspace, {});
  assert.deepEqual(listed.tabs.map((tab) => [tab.name, tab.namedBy, tab.shape]), [["Review pair", "portal", "row[pane, pane]"]], "the review session's old tab went away with it");
  const entry = activity.at(-1);
  assert.equal(entry.kind, "workspace.arranged");
  assert.equal(entry.summary, 'Arranged 2 sessions as columns-2 in tab "Review pair"');
  assert.deepEqual(entry.detail, { actor: "portal", tabId: arranged.tabId, preset: "columns-2", sessionIds: [REVIEW, FIRST] });
  assert.deepEqual(entry.refs, { runId: "run1", threadId: "main" });

  const rebuilt = await run(tools.arrange_tab, { sessionIds: [SECOND, null, "17329ac6"], preset: "one-beside-two", tabId: arranged.tabId.slice(0, 4) });
  assert.equal(rebuilt.error, undefined, JSON.stringify(rebuilt));
  assert.equal(rebuilt.tabId, arranged.tabId);
  assert.equal(rebuilt.rebuilt, true);
  listed = await run(tools.get_workspace, {});
  assert.deepEqual(listed.tabs.map((tab) => [tab.name, tab.preset, tab.panes.map((pane) => pane.sessionId)]), [
    ["Review pair", "one-beside-two", ["5e0f9d8e", null, "17329ac6"]],
    ["First", "single", ["5e0f1b2c"]],
  ], "the session the preset had no room for moved to its own tab after it");

  assert.match((await run(tools.arrange_tab, { sessionIds: [REVIEW], preset: "single", tabId: "zzzz" })).error, /^tabId: No tab has id "zzzz"\..*use get_workspace/);
  assert.match((await run(tools.arrange_tab, { sessionIds: [REVIEW, REVIEW], preset: "columns-2" })).error, /only one pane/);
  assert.equal((await run(tools.arrange_tab, { sessionIds: [REVIEW], preset: "stack" })).invalidInput, true);
  assert.equal((await run(tools.arrange_tab, { sessionIds: [REVIEW, FIRST, SECOND, null, null], preset: "grid-2x2" })).invalidInput, true);
});

test("rename_tab renames as Portal by id or prefix and is refused, with a note, when the user named the tab", async () => {
  const { tools, hub, activity } = setup();
  const { tabId } = await run(tools.open_in_workspace, { sessionId: REVIEW });
  const renamed = await run(tools.rename_tab, { tabId: tabId.slice(0, 6), title: "  Auth review  " });
  assert.deepEqual(renamed, { tabId, title: "Auth review", path: `/tabs/${tabId}` });
  assert.deepEqual(activity.at(-1).detail, { actor: "portal", tabId, from: null, to: "Auth review" });
  assert.equal(activity.at(-1).kind, "workspace.renamed");
  assert.deepEqual(await run(tools.rename_tab, { tabId, title: "Auth review" }), { tabId, title: "Auth review", path: `/tabs/${tabId}`, note: "It already had that name." });

  await hub.workspace.apply({ op: "rename_tab", tabId, title: "Mine", source: "user" }, "user");
  const refused = await run(tools.rename_tab, { tabId, title: "Portal's pick" });
  assert.deepEqual(refused, { error: 'The user named this tab "Mine"; Portal does not rename it.' });
  assert.equal((await run(tools.get_workspace, {})).tabs[0].name, "Mine");
  assert.equal((await run(tools.rename_tab, { tabId, title: "" })).invalidInput, true);
  assert.equal((await run(tools.rename_tab, { tabId, title: "x".repeat(61) })).invalidInput, true);
  assert.match((await run(tools.rename_tab, { tabId: "zzzz", title: "x" })).error, /No tab has id "zzzz"/);
});

test("close_in_workspace closes a tab by id prefix or the pane holding a session, and wants exactly one of the two", async () => {
  const { tools, activity } = setup();
  const review = await run(tools.open_in_workspace, { sessionId: REVIEW });
  const first = await run(tools.open_in_workspace, { sessionId: FIRST, besideSessionId: REVIEW });
  const other = await run(tools.open_in_workspace, { sessionId: SECOND });

  assert.match((await run(tools.close_in_workspace, {})).error, /exactly one of tabId or sessionId/);
  assert.match((await run(tools.close_in_workspace, { tabId: review.tabId, sessionId: REVIEW })).error, /exactly one/);

  assert.deepEqual(await run(tools.close_in_workspace, { sessionId: "5e0f1b2c" }), { closed: "pane", sessionId: FIRST, tabId: review.tabId, paneId: first.paneId });
  assert.equal(activity.at(-1).kind, "workspace.closed");
  assert.deepEqual(activity.at(-1).detail, { actor: "portal", tabId: review.tabId, paneId: first.paneId, what: "pane" });
  assert.equal(activity.at(-1).refs.sessionId, FIRST);
  assert.equal((await run(tools.get_workspace, {})).tabs[0].shape, "pane", "the split collapsed");

  assert.deepEqual(await run(tools.close_in_workspace, { sessionId: FIRST }), { closed: false, sessionId: FIRST, note: "That session is not open in the workspace." });
  assert.deepEqual(await run(tools.close_in_workspace, { tabId: other.tabId.slice(0, 5) }), { closed: "tab", tabId: other.tabId });
  assert.deepEqual(activity.at(-1).detail, { actor: "portal", tabId: other.tabId, what: "tab" });
  assert.equal(activity.at(-1).summary, 'Closed tab "Untitled"');
  assert.deepEqual((await run(tools.get_workspace, {})).tabs.map((tab) => tab.id), [review.tabId]);
  assert.match((await run(tools.close_in_workspace, { tabId: "zzzz" })).error, /No tab has id "zzzz"/);
});

test("delete_session closes the session's pane before the delete, pushed but not logged as a workspace change", async () => {
  const { tools, hub, activity, events } = setup();
  const review = await run(tools.open_in_workspace, { sessionId: REVIEW });
  await run(tools.open_in_workspace, { sessionId: FIRST, besideSessionId: REVIEW });
  const pushes = events.length;
  assert.deepEqual(await run(tools.delete_session, { sessionId: "17329ac6" }), { sessionId: REVIEW, deleted: true });
  const workspace = await hub.workspace.read();
  assert.deepEqual(workspace.tabs.map((tab) => [tab.id, tab.root.kind, tab.root.sessionId]), [[review.tabId, "pane", FIRST]]);
  assert.equal(events.filter((event) => event.type === "workspace").length, pushes + 1, "the cascade is pushed once");
  assert.deepEqual(activity.filter((entry) => entry.kind === "workspace.closed"), [], "and not logged");
  await hub.workspace.onSessionDeleted(REVIEW);
  assert.equal((await hub.workspace.read()).version, workspace.version, "a session with no pane changes nothing");
});

test("shapeOf, describeView, and parseView", () => {
  const pane = (id, sessionId = null) => ({ kind: "pane", id, sessionId });
  assert.equal(shapeOf(pane("p")), "pane");
  assert.equal(shapeOf({ kind: "split", id: "s", direction: "column", sizes: [50, 50], children: [{ kind: "split", id: "r", direction: "row", sizes: [50, 50], children: [pane("a"), pane("b")] }, pane("c")] }), "column[row[pane, pane], pane]");

  const workspace = { version: 1, tabs: [{ id: "t1", title: null, titleSource: null, createdAt: 1, root: { kind: "split", id: "s", direction: "row", sizes: [50, 50], children: [pane("a", REVIEW), pane("b", SECOND)] } }] };
  const titleOf = (id) => (id === REVIEW ? "Review auth" : id === SECOND ? null : undefined);
  assert.equal(describeView({ sessionId: REVIEW, tabId: "t1", paneId: "a" }, workspace, titleOf).text, 'session 17329ac6 (Review auth), in tab "Review auth + Untitled".');
  assert.equal(describeView({ sessionId: SECOND, tabId: "t1", paneId: "b" }, workspace, titleOf).text, 'session 5e0f9d8e (Untitled), in tab "Review auth + Untitled".');
  assert.equal(describeView({ sessionId: REVIEW, tabId: "gone", paneId: "a" }, workspace, titleOf).text, "session 17329ac6 (Review auth).", "a tab the workspace no longer holds is left out");
  assert.equal(describeView({ sessionId: REVIEW, tabId: "t1", paneId: "a" }, null, titleOf).text, "session 17329ac6 (Review auth).");
  assert.equal(describeView({ sessionId: FIRST, tabId: null, paneId: null }, workspace, titleOf).text, "session 5e0f1b2c (no longer exists).");
  assert.equal(describeView({ sessionId: null, tabId: "t1", paneId: null }, workspace, titleOf).text, "the Portal page, no session.");

  assert.deepEqual(parseView({ sessionId: "s1", tabId: "t1", paneId: "p1" }), { sessionId: "s1", tabId: "t1", paneId: "p1" });
  assert.deepEqual(parseView({}), { sessionId: null, tabId: null, paneId: null }, "absent fields count as null");
  assert.deepEqual(parseView({ sessionId: "s1", extra: 1 }), { sessionId: "s1", tabId: null, paneId: null }, "unknown fields are dropped");
  for (const bad of [null, "x", [], { sessionId: 1 }, { tabId: "" }, { paneId: false }]) {
    assert.throws(() => parseView(bad), (err) => err.status === 400 && /view/.test(err.message), JSON.stringify(bad));
  }
});
