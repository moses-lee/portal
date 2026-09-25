import assert from "node:assert/strict";
import test from "node:test";
import {
  createProbeState, deriveLiveness, formatDuration, isStall, resetProbe, sampleProbe, trackToolCall,
} from "../src/lib/liveness.ts";

const MIN = 60_000;

/** A process table at `at` from rows of { pid, ppid, startedAt, cpuMs, command }. */
function tableAt(at, rows) {
  const table = { at, rows: new Map(), children: new Map() };
  for (const row of rows) {
    table.rows.set(row.pid, { pid: row.pid, ppid: row.ppid, elapsedMs: at - row.startedAt, cpuMs: row.cpuMs, command: row.command });
    table.children.set(row.ppid, [...(table.children.get(row.ppid) ?? []), row.pid]);
  }
  return table;
}

const T0 = 1_000_000_000;
const agent = { pid: 100, ppid: 1, startedAt: T0 - 60 * MIN, cpuMs: 40_000, command: "node claude-agent-acp" };
/** Claude Code's per-session process burns CPU of its own even while it waits. */
const sessionProc = (cpuMs) => ({ pid: 200, ppid: 100, startedAt: T0 - 50 * MIN, cpuMs, command: "claude --session-id=up-1" });
const mcp = { pid: 250, ppid: 200, startedAt: T0 - 50 * MIN, cpuMs: 9_000, command: "node some-mcp-server" };
const shell = { pid: 300, ppid: 200, startedAt: T0 + 5_000, cpuMs: 20, command: "/bin/zsh -c bazel test //..." };
const bazel = (cpuMs) => ({ pid: 301, ppid: 300, startedAt: T0 + 5_000, cpuMs, command: "bazel test //..." });
const target = { agentPid: 100, marker: "up-1", turnStartedAt: T0 };

test("tool calls open on start, stay open through heartbeats, and close when finished", () => {
  const open = new Map();
  assert.equal(trackToolCall(open, { sessionUpdate: "tool_call", toolCallId: "a", title: "bazel test //...", kind: "execute", status: "pending" }, 10), true);
  assert.deepEqual(open.get("a"), { id: "a", title: "bazel test //...", kind: "execute", startedAt: 10, lastOutputAt: null });
  // A bare in_progress beat (Claude Code sends one on a timer while a tool runs) is not output.
  assert.equal(trackToolCall(open, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", _meta: { claudeCode: { toolResponse: { elapsedTimeSeconds: 30 } } } }, 20), false);
  assert.equal(open.get("a").lastOutputAt, null);
  assert.equal(trackToolCall(open, { sessionUpdate: "tool_call_update", toolCallId: "a", content: [{ type: "content", content: { type: "text", text: "PASSED" } }] }, 30), true);
  assert.equal(open.get("a").lastOutputAt, 30);
  assert.equal(open.get("a").startedAt, 10);
  assert.equal(trackToolCall(open, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }, 40), true);
  assert.equal(open.size, 0);
  // A call first seen by its update (it started before a reconnect) opens then; a failed one closes.
  trackToolCall(open, { sessionUpdate: "tool_call_update", toolCallId: "b", status: "in_progress", title: "npm test" }, 50);
  assert.equal(open.get("b").title, "npm test");
  trackToolCall(open, { sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" }, 60);
  assert.equal(open.size, 0);
  assert.equal(trackToolCall(open, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, 70), false);
});

test("the probe finds the session's own process, lists the turn's children, and measures CPU over the window", () => {
  const state = createProbeState();
  const first = sampleProbe(state, tableAt(T0 + 10_000, [agent, sessionProc(600_000), mcp, shell, bazel(100)]), target);
  assert.equal(first.alive, true);
  assert.equal(first.scope, "session");
  assert.equal(first.rootPid, 200);
  // The MCP server predates the turn, so it is not one of the turn's processes.
  assert.deepEqual(first.children.map((child) => child.pid), [300, 301]);
  assert.equal(first.children[1].command, "bazel test //...");
  assert.equal(first.children[1].elapsedMs, 5_000);
  assert.equal(first.cpuMs, null, "one sample measures nothing yet");
  assert.equal(state.lastCpuAt, T0 + 5_000, "processes of the turn found on the first look count from their start");

  const second = sampleProbe(state, tableAt(T0 + 40_000, [agent, sessionProc(601_000), mcp, shell, bazel(2_100)]), target);
  assert.equal(second.cpuMs, 1_000 + 2_000);
  assert.equal(second.childCpuMs, 2_000);
  assert.equal(second.windowMs, 30_000);
  assert.equal(state.lastCpuAt, T0 + 40_000);

  // The session process keeps ticking, but the tool's processes are quiet: not a sign of life.
  sampleProbe(state, tableAt(T0 + 70_000, [agent, sessionProc(602_000), mcp, shell, bazel(2_101)]), target);
  assert.equal(state.lastCpuAt, T0 + 40_000);

  // A process of the turn exiting is a sign of life even without CPU.
  sampleProbe(state, tableAt(T0 + 100_000, [agent, sessionProc(603_000), mcp, shell]), target);
  assert.equal(state.lastCpuAt, T0 + 100_000);

  resetProbe(state);
  assert.equal(state.last, null);
  assert.equal(state.lastCpuAt, null);
});

test("without a process of its own the probe measures the whole agent, and a vanished agent is not alive", () => {
  const state = createProbeState();
  const shared = sampleProbe(state, tableAt(T0 + 10_000, [agent, sessionProc(1_000), shell]), { ...target, marker: "not-there" });
  assert.equal(shared.scope, "agent");
  assert.equal(shared.rootPid, 100);
  assert.deepEqual(shared.children.map((child) => child.pid), [300]);

  const gone = sampleProbe(createProbeState(), tableAt(T0, [sessionProc(1_000)]), target);
  assert.equal(gone.alive, false);
  assert.equal(gone.rootPid, null);
  assert.deepEqual(gone.children, []);
});

test("old samples leave the window, one baseline before it stays", () => {
  const state = createProbeState();
  for (let i = 0; i <= 12; i++) sampleProbe(state, tableAt(T0 + i * MIN, [agent, sessionProc(i * 1_000)]), { ...target, windowMs: 5 * MIN });
  assert.equal(state.samples[0].at, T0 + 7 * MIN);
  assert.equal(state.last.windowMs, 5 * MIN);
  assert.equal(state.last.cpuMs, 5_000);
});

/** A probe state as if the probe had run, with `lastCpuAt` and whether the agent was alive. */
function probed({ alive = true, lastCpuAt = null } = {}) {
  const state = createProbeState();
  state.last = { agentPid: 100, alive, scope: "session", rootPid: 200, children: [], cpuMs: 0, childCpuMs: 0, windowMs: 0, sampledAt: T0 };
  state.lastCpuAt = lastCpuAt;
  return state;
}

const base = {
  now: T0 + 45 * MIN, link: "live", awaitingPermission: false, turnOpen: true, turnStartedAt: T0,
  openTools: [{ id: "a", title: "bazel test //...", kind: "execute", startedAt: T0 + 1_000, lastOutputAt: null }],
  lastOutputAt: T0 + 1_000, probe: probed({ lastCpuAt: T0 + 44 * MIN }), lost: null, hungAfterMs: 15 * MIN,
};

test("a long tool run whose processes still use CPU is busy, never idle", () => {
  const liveness = deriveLiveness(base);
  assert.equal(liveness.state, "busy");
  assert.equal(liveness.summary, "running tool: bazel test //... for 44m");
  assert.equal(isStall(liveness.state), false);
  assert.equal(liveness.openTools.length, 1);
});

test("an open turn with no CPU and no output for the threshold is hung; one minute less is still busy", () => {
  const quiet = { ...base, probe: probed({ lastCpuAt: T0 + 20 * MIN }) };
  const hung = deriveLiveness({ ...quiet, now: T0 + 35 * MIN });
  assert.equal(hung.state, "hung");
  assert.equal(hung.summary, "hung: no CPU or output for 15m (tool: bazel test //..., started 34m ago)");
  assert.equal(isStall(hung.state), true);
  assert.equal(deriveLiveness({ ...quiet, now: T0 + 34 * MIN }).state, "busy");
  // Output counts as much as CPU does.
  assert.equal(deriveLiveness({ ...quiet, now: T0 + 35 * MIN, lastOutputAt: T0 + 30 * MIN }).state, "busy");
  // A turn with no tool that went quiet (the model stopped streaming) hangs too.
  const noTool = deriveLiveness({ ...base, openTools: [], probe: probed(), lastOutputAt: T0, now: T0 + 16 * MIN });
  assert.equal(noTool.summary, "hung: no CPU or output for 16m");
});

test("without a probe a quiet turn is never called hung", () => {
  const liveness = deriveLiveness({ ...base, probe: null, now: T0 + 5 * 60 * MIN });
  assert.equal(liveness.state, "busy");
});

test("dead, blocked, and idle", () => {
  const lost = { reason: "process_exited", detail: "Claude Code was killed by SIGKILL", at: T0, exitCode: null, signal: "SIGKILL" };
  const dead = deriveLiveness({ ...base, link: "offline", turnOpen: false, lost });
  assert.equal(dead.state, "dead");
  assert.equal(dead.summary, "dead: Claude Code was killed by SIGKILL");
  assert.equal(dead.lost, lost);
  assert.equal(deriveLiveness({ ...base, probe: probed({ alive: false }) }).state, "dead");
  // Offline with nothing lost is an agent Portal simply has not reattached yet.
  assert.equal(deriveLiveness({ ...base, link: "offline", turnOpen: false }).state, "idle");
  const blocked = deriveLiveness({ ...base, awaitingPermission: true, permissionTitle: "rm -rf build" });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.summary, "waiting on a permission: rm -rf build");
  assert.equal(deriveLiveness({ ...base, turnOpen: false, openTools: [] }).state, "idle");
  assert.equal(deriveLiveness({ ...base, link: "connecting", turnOpen: false }).state, "busy");
});

test("durations read the way a person would say them", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(39 * MIN), "39m");
  assert.equal(formatDuration(125 * MIN), "2h 5m");
  assert.equal(formatDuration(3 * 60 * MIN), "3h");
  assert.equal(formatDuration(52 * 60 * MIN), "2d 4h");
});
