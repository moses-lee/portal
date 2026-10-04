import assert from "node:assert/strict";
import test from "node:test";
import {
  groupTracked,
  shortSessionId,
  trackedAttentionCount,
  trackedGroupOf,
  trackedSortKey,
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
  assert.deepEqual(Object.values(trackedStateLabels), ["Needs approval", "Hung", "Offline", "Connecting", "Working", "Background", "Finished"]);
  assert.equal(trackedGroupOf("offline"), "stalled");
  assert.equal(trackedGroupOf("hung"), "stalled");
  assert.equal(trackedGroupOf("working"), "working");
  assert.equal(trackedGroupOf("background"), "background");
  assert.equal(trackedGroupOf("connecting"), "connecting");
  assert.equal(trackedGroupOf("finished"), "finished");
});

test("background work after the turn is its own state and its own group", () => {
  assert.equal(trackedState(session("a", { liveness: "background" })), "background");
  const groups = groupTracked([track("a")], [session("a", { liveness: "background" })]);
  assert.deepEqual(groups.map((group) => [group.id, group.label, group.rows.map((row) => row.state)]), [["background", "Background", ["background"]]]);
});

test("tracked sessions group as approval, stalled, working, background, connecting, finished, skipping unknown ids", () => {
  const sessions = [
    session("working", { busy: true, lastActiveAt: 5 }),
    session("done-old", { lastActiveAt: 1 }),
    session("done-new", { lastActiveAt: 9 }),
    session("hung", { busy: true, liveness: "hung", lastActiveAt: 3 }),
    session("dead", { liveness: "dead", lastActiveAt: 4 }),
    session("approve", { awaitingPermission: true, lastActiveAt: 2 }),
    session("bg", { liveness: "background", lastActiveAt: 6 }),
    session("attach", { link: { status: "connecting" }, lastActiveAt: 7 }),
    session("untracked", { awaitingPermission: true }),
  ];
  const tracked = ["working", "done-old", "done-new", "hung", "dead", "approve", "bg", "attach", "gone"].map((id) => track(id));
  const groups = groupTracked(tracked, sessions);
  assert.deepEqual(
    groups.map((group) => [group.id, group.label, group.rows.map((row) => `${row.session.id}:${row.state}`)]),
    [
      ["approval", "Needs approval", ["approve:approval"]],
      ["stalled", "Offline or hung", ["dead:offline", "hung:hung"]],
      ["working", "Working", ["working:working"]],
      ["background", "Background", ["bg:background"]],
      ["connecting", "Connecting", ["attach:connecting"]],
      ["finished", "Finished", ["done-new:finished", "done-old:finished"]],
    ],
  );
  assert.equal(groups[0].rows[0].tracked.sessionId, "approve");
});

test("finished sessions sort by when their turn ended, falling back to the last prompt", () => {
  const sessions = [
    // Prompted last, but its turn ended first.
    session("long-ago", { lastActiveAt: 50, turnEndedAt: 60 }),
    session("just-ended", { lastActiveAt: 10, turnEndedAt: 100 }),
    // No turn end recorded: its last prompt stands in.
    session("legacy", { lastActiveAt: 80, turnEndedAt: null }),
    session("older-legacy", { lastActiveAt: 20 }),
  ];
  const groups = groupTracked(sessions.map((s) => track(s.id)), sessions);
  assert.deepEqual(groups.map((group) => group.id), ["finished"]);
  assert.deepEqual(groups[0].rows.map((row) => row.session.id), ["just-ended", "legacy", "long-ago", "older-legacy"]);
  assert.equal(trackedSortKey("finished", sessions[0]), 60);
  assert.equal(trackedSortKey("working", sessions[0]), 50);
});

test("other groups keep the newest prompt first, whatever their turn ends say", () => {
  const sessions = [
    session("a", { busy: true, lastActiveAt: 1, turnEndedAt: 99 }),
    session("b", { busy: true, lastActiveAt: 2, turnEndedAt: 0 }),
  ];
  const [working] = groupTracked(sessions.map((s) => track(s.id)), sessions);
  assert.deepEqual(working.rows.map((row) => row.session.id), ["b", "a"]);
});

test("the attention badge counts approvals and stalled sessions, not finished ones", () => {
  const sessions = [
    session("approve", { awaitingPermission: true }),
    session("hung", { busy: true, liveness: "hung" }),
    session("dead", { liveness: "dead" }),
    session("done", {}),
    session("done-2", {}),
    session("working", { busy: true }),
    session("bg", { liveness: "background" }),
  ];
  const groups = groupTracked(sessions.map((s) => track(s.id)), sessions);
  assert.equal(trackedAttentionCount(groups), 3);
  assert.equal(trackedAttentionCount(groupTracked([track("done")], sessions)), 0);
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
