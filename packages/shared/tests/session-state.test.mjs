import assert from "node:assert/strict";
import test from "node:test";
import { activityOfState, agentActivity } from "../src/agent-activity.ts";
import { sessionState, sessionStateLabels, sessionStates } from "../src/session-state.ts";

const live = { status: "live" };

function input(patch = {}) {
  return { busy: false, awaitingPermission: false, link: live, liveness: "idle", ...patch };
}

test("an idle live session is finished", () => {
  assert.equal(sessionState(input()), "finished");
  assert.equal(sessionState({ busy: false, awaitingPermission: false }), "finished", "no link and no liveness is finished");
});

test("approval wins over everything: an open prompt or liveness blocked", () => {
  assert.equal(sessionState(input({ awaitingPermission: true })), "approval");
  assert.equal(sessionState(input({ liveness: "blocked" })), "approval");
  assert.equal(sessionState(input({ awaitingPermission: true, busy: true, liveness: "hung" })), "approval");
  assert.equal(sessionState(input({ awaitingPermission: true, liveness: "dead", link: { status: "offline", error: "gone" } })), "approval");
  assert.equal(sessionState(input({ awaitingPermission: true, link: { status: "connecting" } })), "approval");
});

test("hung comes next, before offline and connecting", () => {
  assert.equal(sessionState(input({ busy: true, liveness: "hung" })), "hung");
  assert.equal(sessionState(input({ liveness: "hung", link: { status: "offline", error: "gone" } })), "hung");
  assert.equal(sessionState(input({ liveness: "hung", link: { status: "connecting" } })), "hung");
});

test("offline: liveness dead, or an offline link with an error", () => {
  assert.equal(sessionState(input({ liveness: "dead" })), "offline");
  assert.equal(sessionState(input({ busy: true, liveness: "dead", link: { status: "offline", error: null } })), "offline");
  assert.equal(sessionState(input({ link: { status: "offline", error: "spawn failed" } })), "offline");
  assert.equal(sessionState(input({ busy: true, link: { status: "offline", error: "spawn failed" } })), "offline");
  assert.equal(sessionState(input({ liveness: "dead", link: { status: "connecting" } })), "offline", "offline before connecting");
});

test("an offline link without an error is finished, not an attention state", () => {
  assert.equal(sessionState(input({ link: { status: "offline", error: null } })), "finished");
  assert.equal(sessionState({ busy: false, awaitingPermission: false, link: { status: "offline", error: null } }), "finished");
});

test("connecting comes before working", () => {
  assert.equal(sessionState(input({ link: { status: "connecting" } })), "connecting");
  assert.equal(sessionState(input({ busy: true, liveness: "busy", link: { status: "connecting" } })), "connecting");
});

test("working: busy, or liveness busy", () => {
  assert.equal(sessionState(input({ busy: true })), "working");
  assert.equal(sessionState(input({ liveness: "busy" })), "working");
  assert.equal(sessionState(input({ busy: true, liveness: "background" })), "working", "an open turn beats background work");
});

test("background: no open turn, background tasks running", () => {
  assert.equal(sessionState(input({ liveness: "background" })), "background");
  assert.equal(sessionState(input({ liveness: "background", link: { status: "offline", error: null } })), "background");
});

test("states are listed in precedence order, each with a label", () => {
  assert.deepEqual(sessionStates, ["approval", "hung", "offline", "connecting", "working", "background", "finished"]);
  assert.deepEqual(Object.keys(sessionStateLabels).sort(), [...sessionStates].sort());
});

test("agentActivity folds sessionState onto the stable activity values", () => {
  assert.deepEqual(
    Object.fromEntries(sessionStates.map((state) => [state, activityOfState(state)])),
    { approval: "waiting", hung: "error", offline: "error", connecting: "connecting", working: "working", background: "working", finished: "idle" },
  );
  assert.equal(agentActivity(input()), "idle");
  assert.equal(agentActivity(input({ busy: true })), "working");
  assert.equal(agentActivity(input({ awaitingPermission: true, busy: true })), "waiting");
  assert.equal(agentActivity(input({ link: { status: "connecting" } })), "connecting");
  assert.equal(agentActivity(input({ link: { status: "offline", error: "gone" } })), "error");
  assert.equal(agentActivity(input({ link: { status: "offline", error: null } })), "idle");
  assert.equal(agentActivity(input({ busy: true, liveness: "hung" })), "error");
  assert.equal(agentActivity(input({ liveness: "background" })), "working");
});

test("agentActivity: a failed last block is an error unless something more pressing shows", () => {
  assert.equal(agentActivity({ ...input(), failed: true }), "error");
  assert.equal(agentActivity({ ...input({ busy: true }), failed: true }), "error");
  assert.equal(agentActivity({ ...input({ awaitingPermission: true }), failed: true }), "waiting");
  assert.equal(agentActivity({ ...input({ link: { status: "connecting" } }), failed: true }), "connecting");
});
