import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceService } from "../src/workspace/service.ts";
import { createMemoryWorkspaceStore } from "../src/workspace/store.ts";
import { T0, fakeDeps, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const REVIEW = "17329ac6-0c1e-4c4f-9a57-3d2b1f0e9a01";
const FIRST = "5e0f1b2c-7d3e-4a1b-8c2d-000000000002";
const PORTAL = "9b1d4e7a-5c6d-4e7f-8a9b-00000000000p";

/** The real service over `store` and a fake hub with two sessions, its pushes and activity entries recorded. */
function setup(store) {
  const { deps, state } = fakeDeps({
    projects: [project({ id: PORTAL, name: "portal" })],
    sessions: [sessionMeta({ id: REVIEW, projectId: PORTAL, title: "Review auth" }), sessionMeta({ id: FIRST, projectId: PORTAL, title: "First" })],
  });
  const activity = [];
  const events = [];
  const hub = { deps, timers: { now: () => T0 }, emit: (event) => events.push(event), activity: { log: async (entry) => { activity.push(entry); } } };
  return { workspace: createWorkspaceService(hub, store), deps, state, activity, events };
}

/**
 * A memory store whose next mutation, once `arm` is called, waits at a gate before it runs: the
 * window between `apply`'s session check and its write. `arm` answers when the mutation has
 * reached the gate and how to release it.
 */
function gatedStore() {
  const store = createMemoryWorkspaceStore();
  let gate = null;
  const mutate = async (fn) => {
    if (gate) {
      const { reached, open } = gate;
      gate = null;
      reached();
      await open;
    }
    return store.mutate(fn);
  };
  function arm() {
    let reached;
    let release;
    const arrived = new Promise((resolve) => { reached = resolve; });
    const open = new Promise((resolve) => { release = resolve; });
    gate = { reached, open };
    return { arrived, release };
  }
  return { store: { read: store.read, mutate }, arm };
}

test("a session deleted between apply's check and its write leaves no ghost pane: the cascade closes it with one push and no entry, and the op answers not_found", async () => {
  const { store, arm } = gatedStore();
  const { workspace, deps, activity, events } = setup(store);
  const { location } = await workspace.apply({ op: "open", sessionId: FIRST }, "user");
  const pushes = events.length;
  const entries = activity.length;

  const { arrived, release } = arm();
  const applying = workspace.apply({ op: "open", sessionId: REVIEW, target: { ...location, edge: "right" } }, "user");
  await arrived;
  // The delete lands now: the session goes and its delete event runs the cascade, which finds no pane yet.
  assert.equal(await deps.sessions.remove(REVIEW), true);
  await workspace.onSessionDeleted(REVIEW);
  assert.equal(events.length, pushes, "nothing to close yet, nothing pushed");
  release();

  await assert.rejects(applying, (err) => err.code === "not_found" && /^No session has id "17329ac6/.test(err.message), "the op answers as the check would have a moment earlier");
  const after = await workspace.read();
  assert.deepEqual(after.tabs.map((tab) => tab.root), [{ kind: "pane", id: location.paneId, sessionId: FIRST }], "no pane holds the deleted session; the split collapsed back");
  assert.equal(events.length, pushes + 1, "one push, from the cascade");
  assert.deepEqual(events.at(-1), { type: "workspace", workspace: after });
  assert.equal(activity.length, entries, "neither the ghost open nor its close is logged");
  assert.equal(after.version, 3, "the write and the close both happened");
});

test("apply still answers not_found before writing when a session is already gone, and leaves a live session's op alone", async () => {
  const { store } = gatedStore();
  const { workspace, deps, events } = setup(store);
  await deps.sessions.remove(REVIEW);
  await assert.rejects(workspace.apply({ op: "open", sessionId: REVIEW }, "user"), (err) => err.code === "not_found");
  assert.equal((await workspace.read()).version, 0, "nothing written");
  assert.equal(events.length, 0);
  const { changed, location } = await workspace.apply({ op: "arrange", sessionIds: [FIRST, null], preset: "columns-2" }, "user");
  assert.equal(changed, true);
  assert.ok(location.tabId);
  assert.equal(events.length, 1);
});
