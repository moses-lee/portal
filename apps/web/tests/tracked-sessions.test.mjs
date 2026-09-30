import assert from "node:assert/strict";
import test from "node:test";
import {
  groupTracked,
  shortSessionId,
  trackedAttentionCount,
  trackedGroupOf,
  trackedState,
  trackedStateLabels,
} from "../src/lib/tracked-sessions.ts";

const live = { status: "live" };

function session(id, patch = {}) {
  return {
    id,
    lastActiveAt: 0,
    busy: false,
    awaitingPermission: false,
    link: live,
    liveness: "idle",
    ...patch,
  };
}

const track = (sessionId, trackedAt = 0) => ({ sessionId, trackedAt, trackedBy: "user" });

test("an idle live session is finished: it waits on the user", () => {
  assert.equal(trackedState(session("a")), "finished");
});

test("an open permission prompt wins over everything else", () => {
  assert.equal(trackedState(session("a", { awaitingPermission: true, busy: true, liveness: "blocked" })), "approval");
  assert.equal(trackedState(session("a", { liveness: "blocked" })), "approval");
  assert.equal(trackedState(session("a", { awaitingPermission: true, link: { status: "offline", error: "gone" } })), "approval");
});

test("a running turn is working; a quiet one past the threshold is hung", () => {
  assert.equal(trackedState(session("a", { busy: true, liveness: "busy" })), "working");
  assert.equal(trackedState(session("a", { busy: true })), "working");
  assert.equal(trackedState(session("a", { busy: true, liveness: "hung" })), "hung");
});

test("attaching the agent is connecting", () => {
  assert.equal(trackedState(session("a", { link: { status: "connecting" }, liveness: "busy" })), "connecting");
});

test("a dead agent or an offline link with an error is offline; a detached idle one is finished", () => {
  assert.equal(trackedState(session("a", { link: { status: "offline", error: null }, liveness: "dead" })), "offline");
  assert.equal(trackedState(session("a", { liveness: "dead" })), "offline");
  assert.equal(trackedState(session("a", { link: { status: "offline", error: "spawn failed" } })), "offline");
  assert.equal(trackedState(session("a", { link: { status: "offline", error: null } })), "finished");
});

test("badge labels and groups", () => {
  assert.deepEqual(Object.values(trackedStateLabels), ["Needs approval", "Finished", "Working", "Connecting", "Offline", "Hung"]);
  assert.equal(trackedGroupOf("offline"), "stalled");
  assert.equal(trackedGroupOf("hung"), "stalled");
  assert.equal(trackedGroupOf("working"), "working");
});

test("tracked sessions group in order, newest prompt first, skipping unknown ids", () => {
  const sessions = [
    session("working", { busy: true, lastActiveAt: 5 }),
    session("done-old", { lastActiveAt: 1 }),
    session("done-new", { lastActiveAt: 9 }),
    session("hung", { busy: true, liveness: "hung", lastActiveAt: 3 }),
    session("dead", { liveness: "dead", lastActiveAt: 4 }),
    session("approve", { awaitingPermission: true, lastActiveAt: 2 }),
    session("untracked", { awaitingPermission: true }),
  ];
  const tracked = ["working", "done-old", "done-new", "hung", "dead", "approve", "gone"].map((id) => track(id));
  const groups = groupTracked(tracked, sessions);
  assert.deepEqual(
    groups.map((group) => [group.id, group.label, group.rows.map((row) => `${row.session.id}:${row.state}`)]),
    [
      ["approval", "Needs approval", ["approve:approval"]],
      ["finished", "Finished", ["done-new:finished", "done-old:finished"]],
      ["working", "Working", ["working:working"]],
      ["stalled", "Offline or hung", ["dead:offline", "hung:hung"]],
    ],
  );
  assert.equal(groups[0].rows[0].tracked.sessionId, "approve");
  assert.equal(trackedAttentionCount(groups), 3);
});

test("nothing tracked, nothing listed", () => {
  assert.deepEqual(groupTracked([], [session("a")]), []);
  assert.equal(trackedAttentionCount([]), 0);
});

test("short ids are the first eight characters", () => {
  assert.equal(shortSessionId("0123456789abcdef"), "01234567");
  assert.equal(shortSessionId("abc"), "abc");
});

test("session mode starts at half the space beside the sidebar and keeps the main pane at 480 px", async () => {
  const { trackedSessionWidth, parseTrackedWidth } = await import("../src/lib/tracked-sessions.ts");
  // First open: half the space beside the sidebar (1440 wide, 280 sidebar: 580, the thread keeps 580).
  assert.equal(trackedSessionWidth({ wanted: null, shared: 1160 }), 580);
  // Half would leave the pane under 480: clamped (and never under the session minimum).
  assert.equal(trackedSessionWidth({ wanted: null, shared: 900 }), 420);
  // A stored width wins, within the bounds.
  assert.equal(trackedSessionWidth({ wanted: 600, shared: 1320 }), 600);
  assert.equal(trackedSessionWidth({ wanted: 1200, shared: 1320 }), 840);
  assert.equal(trackedSessionWidth({ wanted: 100, shared: 1320 }), 360);
  // Too little room: never narrower than the list.
  assert.equal(trackedSessionWidth({ wanted: 500, shared: 700 }), 320);
  assert.equal(parseTrackedWidth(""), null);
  assert.equal(parseTrackedWidth("abc"), null);
  assert.equal(parseTrackedWidth("640"), 640);
});
