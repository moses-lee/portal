import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createOrchestratorRuntime } from "../src/orchestrator/runtime.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { TOOL_GROUPS } from "../src/orchestrator/tools/groups.ts";
import { prepareTurn } from "../src/orchestrator/turn.ts";
import { T0, fakeDeps, fakePresence, fakeSettings, fakeTimers, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const REVIEW = "17329ac6-0c1e-4c4f-9a57-3d2b1f0e9a01";
const FIRST = "5e0f1b2c-7d3e-4a1b-8c2d-000000000002";
const UNTITLED = "7a7a7a7a-1111-4222-8333-000000000004";
const PORTAL = "9b1d4e7a-5c6d-4e7f-8a9b-00000000000p";

const WORKSPACE_TOOLS = [...TOOL_GROUPS.workspace.tools];

/** A runtime on memory stores with three sessions, the review and first ones arranged side by side in one tab. */
async function setup(t) {
  const store = createMemoryOrchestratorStore();
  const { deps } = fakeDeps({
    projects: [project({ id: PORTAL, name: "portal" })],
    sessions: [
      sessionMeta({ id: REVIEW, projectId: PORTAL, title: "Review auth" }),
      sessionMeta({ id: FIRST, projectId: PORTAL, title: "First", busy: true }),
      sessionMeta({ id: UNTITLED, projectId: PORTAL, title: null }),
    ],
  });
  const model = new MockLanguageModelV3({});
  const runtime = createOrchestratorRuntime({ store, settingsStore: fakeSettings(), deps, timers: fakeTimers(), presence: fakePresence(0), model: () => model });
  t.after(() => runtime.dispose());
  await runtime.ready;
  const { location } = await runtime.hub.workspace.apply({ op: "arrange", sessionIds: [REVIEW, FIRST], preset: "columns-2" }, "user");
  return { runtime, hub: runtime.hub, tabId: location.tabId, paneId: location.paneId };
}

const chatTurn = (view) => ({ kind: "chat", role: "chat", trigger: "user", threadId: "main", interactive: true, query: "", touched: new Set(), view });

test("a chat turn's prompt ends with what the user is looking at: the session and its tab, or the Portal page", async (t) => {
  const { hub, tabId, paneId } = await setup(t);
  const inTab = await prepareTurn(hub, chatTurn({ sessionId: REVIEW, tabId, paneId }));
  assert.match(inTab.system, /\n\nYou are looking at: session 17329ac6 \(Review auth\), in tab "Review auth \+ First"\.$/);
  assert.deepEqual(inTab.turn.view, { sessionId: REVIEW, tabId, paneId }, "the tools see the view through the turn");
  for (const name of WORKSPACE_TOOLS) assert.ok(inTab.tools[name], `${name} is offered`);
  assert.match(inTab.system, /Workspace:\n- The workspace is where the user is working/, "the guidance");
  assert.match(inTab.system, /Tracked sessions: none\.\nWorkspace tabs:\n- "Review auth \+ First" \[[0-9a-f]{8}\]: 17329ac6 \(idle\), 5e0f1b2c \(working\)\n/, "the World section lists the tabs after the tracked sessions");

  const page = await prepareTurn(hub, chatTurn({ sessionId: null, tabId: null, paneId: null }));
  assert.match(page.system, /\n\nYou are looking at: the Portal page, no session\.$/);

  const tracked = await prepareTurn(hub, chatTurn({ sessionId: UNTITLED, tabId: null, paneId: null }));
  assert.match(tracked.system, /\n\nYou are looking at: session 7a7a7a7a \(Untitled\)\.$/, "the tracked panel names no tab, and an untitled session reads Untitled");

  const gone = await prepareTurn(hub, chatTurn({ sessionId: "deadbeef-0000-4000-8000-000000000000", tabId: "nope", paneId: null }));
  assert.match(gone.system, /\n\nYou are looking at: session deadbeef \(no longer exists\)\.$/);

  const none = await prepareTurn(hub, chatTurn(undefined));
  assert.doesNotMatch(none.system, /You are looking at/, "no view, no line");
  assert.equal(none.turn.view, null);
  const nulled = await prepareTurn(hub, chatTurn(null));
  assert.doesNotMatch(nulled.system, /You are looking at/);
});

test("background turns get no You-are-looking-at line and no workspace tools, even when a view is passed", async (t) => {
  const { hub, tabId, paneId } = await setup(t);
  const helper = await prepareTurn(hub, {
    kind: "helper", role: "chat", trigger: "agent", threadId: null, interactive: false, query: "look", touched: new Set(), view: { sessionId: REVIEW, tabId, paneId },
  });
  assert.doesNotMatch(helper.system, /You are looking at/);
  assert.equal(helper.turn.view, null);
  for (const name of WORKSPACE_TOOLS) assert.equal(helper.tools[name], undefined, `${name} is not a background tool`);
  assert.match(helper.system, /Workspace tabs:/, "the world's section is still there: the tabs are state, the tools are not");

  const named = await prepareTurn(hub, {
    kind: "helper", role: "chat", trigger: "agent", threadId: null, interactive: false, toolNames: ["get_workspace", "list_items"], query: "", touched: new Set(),
    view: { sessionId: REVIEW, tabId, paneId },
  });
  assert.deepEqual(Object.keys(named.tools).sort(), ["get_workspace", "list_items"], "a turn that names its tools can still read the workspace");
  assert.doesNotMatch(named.system, /You are looking at/);
});
