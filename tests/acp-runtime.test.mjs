import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcpRuntime } from "../src/lib/acp-runtime.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

async function until(predicate, description) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(10);
  }
}

const PERMISSION_OPTIONS = [
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
];

/** Wait for the agent's next permission prompt on `session` and answer it as a viewer would. */
async function answerPermission(runtime, session, optionId = "always") {
  await until(() => session.pendingPermissions.size > 0, `permission request on ${session.agentId}`);
  const [requestId] = session.pendingPermissions;
  runtime.respondPermission(session.id, requestId, optionId);
  return requestId;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function setup(t, options = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "portal-acp-test-"));
  const logPath = path.join(cwd, "agent.jsonl");
  const configPath = path.join(cwd, "config.json");
  writeFileSync(logPath, "");
  writeFileSync(configPath, JSON.stringify(options.modes ?? {}));
  const definitions = ["claude", "codex"].map((id) => ({
    id,
    name: id === "claude" ? "Claude Code" : "Codex",
    command: process.execPath,
    args: [fixturePath, id, logPath, configPath],
    authHint: `Log in to ${id} on the host.`,
  }));
  const runtime = createAcpRuntime(definitions, {
    initializeTimeoutMs: options.initializeTimeoutMs ?? 2_000,
  });
  const records = () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const messages = (agentId, method) => records().filter((entry) =>
    entry.agentId === agentId && entry.message?.method === method,
  );
  const starts = (agentId) => records().filter((entry) => entry.agentId === agentId && entry.event === "spawn");

  t.after(async () => {
    runtime.dispose();
    const pids = [...new Set(records().map(({ pid }) => pid))];
    try {
      await until(() => pids.every((pid) => !isAlive(pid)), "fixture processes to stop");
    } finally {
      for (const pid of pids) {
        if (isAlive(pid)) process.kill(pid, "SIGKILL");
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return {
    runtime, cwd, records, messages, starts,
    setModes: (modes) => writeFileSync(configPath, JSON.stringify(modes)),
  };
}

test("colliding upstream IDs keep events, approvals, and cancellation in their own agent sessions", async (t) => {
  const { runtime, cwd, records, messages } = setup(t);
  const [claude, codex] = await Promise.all([
    runtime.createSession(cwd, "claude"),
    runtime.createSession(cwd, "codex"),
  ]);
  assert.notEqual(claude.id, codex.id);
  assert.notEqual(claude.id, "session-1");
  assert.notEqual(codex.id, "session-1");
  assert.equal(runtime.getSession(claude.id), claude);
  assert.deepEqual(new Set(runtime.listSessions().map(({ agentId }) => agentId)), new Set(["claude", "codex"]));

  const observed = [];
  claude.listeners.add((index, event) => observed.push({ index, event }));
  await Promise.all([runtime.sendPrompt(claude.id, "hold"), runtime.sendPrompt(codex.id, "hold")]);
  const requestIds = await Promise.all([answerPermission(runtime, claude), answerPermission(runtime, codex)]);
  assert.notEqual(requestIds[0], requestIds[1]);
  await until(() => records().filter(({ message }) => message?.result?.outcome?.outcome === "selected").length === 2, "permission responses");

  for (const [index, session] of [claude, codex].entries()) {
    const requestId = requestIds[index];
    assert.deepEqual(session.events.filter(({ type }) => type === "update").map(({ update }) => update.content.text), [`${session.agentId}:hold`]);
    assert.deepEqual(session.events.filter(({ type }) => type.startsWith("permission")), [
      {
        type: "permission_request", requestId,
        toolCall: { toolCallId: "tool-1", title: `${session.agentId} tool` },
        options: PERMISSION_OPTIONS,
      },
      { type: "permission_response", requestId, outcome: "selected", optionId: "always", optionName: "Always allow" },
    ]);
    assert.equal(session.pendingPermissions.size, 0);
    assert.equal(messages(session.agentId, "session/prompt")[0].message.params.sessionId, "session-1");
    const answer = records().find((entry) => entry.agentId === session.agentId && entry.message?.id === "permission-1" && entry.message.result);
    assert.deepEqual(answer.message.result, { outcome: { outcome: "selected", optionId: "always" } });
  }
  assert.deepEqual(observed.map(({ index }) => index), claude.events.map((_, index) => index));

  await runtime.cancel(claude.id);
  await until(() => !claude.busy, "Claude cancellation");
  assert.equal(codex.busy, true);
  assert.equal(messages("claude", "session/cancel")[0].message.params.sessionId, "session-1");
  assert.equal(messages("codex", "session/cancel").length, 0);
  assert.deepEqual(claude.events.at(-1), { type: "turn_end", stopReason: "cancelled" });

  await runtime.cancel(codex.id);
  await until(() => !codex.busy, "Codex cancellation");
});

test("simultaneous sessions share one process per agent and reject a second prompt while busy", async (t) => {
  const { runtime, cwd, starts, messages, records } = setup(t);
  const [first, second] = await Promise.all([
    runtime.createSession(cwd, "claude"),
    runtime.createSession(cwd, "claude"),
  ]);
  assert.equal(starts("claude").length, 1);
  assert.equal(starts("codex").length, 0);
  assert.equal(messages("claude", "initialize").length, 1);
  assert.notEqual(first.id, second.id);

  const attempts = await Promise.allSettled([
    runtime.sendPrompt(first.id, "hold"),
    runtime.sendPrompt(first.id, "duplicate"),
  ]);
  assert.equal(attempts[0].status, "fulfilled");
  assert.equal(attempts[1].status, "rejected");
  assert.match(attempts[1].reason.message, /busy/i);
  assert.equal(first.events.filter(({ type }) => type === "user").length, 1);
  await runtime.sendPrompt(second.id, "hello");
  await answerPermission(runtime, second, "once");
  await until(() => !second.busy, "second session response");
  assert.equal(first.busy, true);
  assert.deepEqual(second.events.at(-1), { type: "turn_end", stopReason: "end_turn" });
  assert.equal(messages("claude", "session/prompt").length, 2);
  await answerPermission(runtime, first);
  await until(() => records().filter(({ message }) => message?.result?.outcome?.outcome === "selected").length === 2, "permission responses");
  await runtime.cancel(first.id);
  await until(() => !first.busy, "first session cancellation");
});

test("agent exit preserves its peer and never reuses disconnected sessions after restarting", async (t) => {
  const { runtime, cwd, starts, messages } = setup(t);
  const old = await runtime.createSession(cwd, "claude");
  const idle = await runtime.createSession(cwd, "claude");
  const peer = await runtime.createSession(cwd, "codex");
  // A prompt left open on one session must not outlive its process.
  await runtime.sendPrompt(idle.id, "hold");
  await until(() => idle.pendingPermissions.size === 1, "held permission request");
  const [heldRequestId] = idle.pendingPermissions;
  await runtime.sendPrompt(old.id, "exit");
  await until(() => old.events.some(({ type }) => type === "error") && !old.busy, "agent exit");
  await until(() => idle.events.some(({ type }) => type === "error") && !idle.busy, "sibling session failure");
  assert.equal(idle.pendingPermissions.size, 0);
  assert.deepEqual(idle.events.slice(-2), [
    { type: "permission_response", requestId: heldRequestId, outcome: "cancelled" },
    idle.events.at(-1),
  ]);
  assert.throws(() => runtime.respondPermission(idle.id, heldRequestId, "always"), /session|exited|disconnect/i);
  await assert.rejects(runtime.sendPrompt(old.id, "again"), /session|exited|disconnect/i);
  await assert.rejects(runtime.sendPrompt(idle.id, "again"), /session|exited|disconnect/i);
  await assert.rejects(runtime.cancel(old.id), /session|exited|disconnect/i);
  assert.equal(starts("claude").length, 1);

  await runtime.sendPrompt(peer.id, "still here");
  await answerPermission(runtime, peer);
  await until(() => !peer.busy, "unaffected peer response");
  assert.equal(peer.events.some(({ type }) => type === "error"), false);
  assert.equal(starts("codex").length, 1);

  const replacement = await runtime.createSession(cwd, "claude");
  assert.notEqual(replacement.id, old.id);
  assert.equal(starts("claude").length, 2);
  const oldEvents = old.events.length;
  await runtime.sendPrompt(replacement.id, "new process");
  await answerPermission(runtime, replacement);
  await until(() => !replacement.busy, "replacement response");
  assert.equal(messages("claude", "session/prompt").at(-1).message.params.sessionId, "session-1");
  assert.equal(old.events.length, oldEvents);
  await assert.rejects(runtime.sendPrompt(old.id, "do not reuse"), /session|exited|disconnect/i);
});

test("closed ACP stdout invalidates sessions and stops a process that has not exited", async (t) => {
  const { runtime, cwd, starts } = setup(t);
  const session = await runtime.createSession(cwd, "claude");
  const pid = starts("claude")[0].pid;
  await runtime.sendPrompt(session.id, "disconnect");
  await until(() => session.events.some(({ type }) => type === "error") && !session.busy, "transport disconnect");
  await until(() => !isAlive(pid), "disconnected process cleanup");
  await assert.rejects(runtime.sendPrompt(session.id, "again"), /session|disconnect/i);
  const replacement = await runtime.createSession(cwd, "claude");
  assert.notEqual(replacement.id, session.id);
  assert.equal(starts("claude").length, 2);
});

for (const mode of ["error", "hang"]) {
  test(`initialization ${mode} cleans up its process and permits retry`, async (t) => {
    const { runtime, cwd, starts, setModes } = setup(t, {
      modes: { claude: mode },
      initializeTimeoutMs: mode === "hang" ? 300 : 2_000,
    });
    await assert.rejects(runtime.createSession(cwd, "claude"), (error) => {
      assert.match(error.message, mode === "hang" ? /timed?\s*out|timeout/i : /initialization failed/i);
      assert.match(error.message, /executable.*adapter installation/i);
      assert.doesNotMatch(error.message, /log in|sign in/i);
      return true;
    });
    assert.equal(runtime.listSessions().length, 0);
    assert.equal(starts("claude").length, 1);
    await until(() => !isAlive(starts("claude")[0].pid), "failed startup process cleanup");

    setModes({});
    const session = await runtime.createSession(cwd, "claude");
    assert.equal(session.agentId, "claude");
    assert.equal(starts("claude").length, 2);
    await runtime.sendPrompt(session.id, "retry succeeded");
    await answerPermission(runtime, session);
    await until(() => !session.busy, "retried agent response");
    assert.deepEqual(session.events.at(-1), { type: "turn_end", stopReason: "end_turn" });
  });
}

test("unknown agents and unknown sessions fail without launching a process", async (t) => {
  const { runtime, cwd, records } = setup(t);
  await assert.rejects(runtime.createSession(cwd, "missing"), /agent/i);
  await assert.rejects(runtime.sendPrompt("missing", "hello"), /session/i);
  await assert.rejects(runtime.cancel("missing"), /session/i);
  assert.equal(records().length, 0);
});

test("missing authentication gives host setup guidance without affecting another agent", async (t) => {
  const { runtime, cwd, starts, setModes } = setup(t, { modes: { codex: "auth-required" } });
  const peer = await runtime.createSession(cwd, "claude");
  await assert.rejects(runtime.createSession(cwd, "codex"), (error) => {
    assert.match(error.message, /authentication required/i);
    assert.match(error.message, /log in to codex on the host/i);
    return true;
  });
  assert.deepEqual(runtime.listSessions().map(({ id }) => id), [peer.id]);
  await runtime.sendPrompt(peer.id, "still authenticated");
  await answerPermission(runtime, peer);
  await until(() => !peer.busy, "authenticated peer response");

  setModes({});
  const session = await runtime.createSession(cwd, "codex");
  assert.equal(session.agentId, "codex");
  assert.equal(starts("codex").length, 1);
});

test("missing executables reject cleanly on repeated startup attempts", async (t) => {
  const runtime = createAcpRuntime([{
    id: "missing", name: "Missing", command: "/portal-test/nonexistent-agent", args: [], authHint: "Log in on the host.",
  }]);
  t.after(() => runtime.dispose());
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runtime.createSession(os.tmpdir(), "missing"), (error) => {
      assert.match(error.message, /enoent|not found|no such|start/i);
      assert.match(error.message, /executable.*adapter installation/i);
      assert.doesNotMatch(error.message, /log in|sign in/i);
      return true;
    });
  }
  assert.equal(runtime.listSessions().length, 0);
});

test("initialize advertises boolean config options and session/new state is captured", async (t) => {
  const { runtime, cwd, messages } = setup(t);
  const session = await runtime.createSession(cwd, "claude");
  assert.deepEqual(messages("claude", "initialize")[0].message.params.clientCapabilities, {
    session: { configOptions: { boolean: {} } },
  });
  assert.deepEqual(session.state.modes, {
    currentModeId: "default",
    availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
  });
  assert.deepEqual(session.state.configOptions.map(({ id, type, currentValue }) => ({ id, type, currentValue })), [
    { id: "mode", type: "select", currentValue: "default" },
    { id: "model", type: "select", currentValue: "fast" },
    { id: "fast", type: "boolean", currentValue: false },
  ]);
  await until(() => session.state.commands.length === 2, "commands pushed after session/new");
  assert.deepEqual(session.state.commands, [
    { name: "help", description: "Show help" },
    { name: "review", description: "Review code", input: { hint: "what to review" } },
  ]);
  assert.deepEqual(runtime.listSessions()[0].state, session.state);

  const seen = [];
  session.stateListeners.add((state) => seen.push(state));
  await runtime.sendPrompt(session.id, "commands");
  await until(() => !session.busy, "commands turn");
  assert.deepEqual(seen.map(({ commands }) => commands.map(({ name }) => name)), [["help", "review", "commit"]]);
  assert.equal(seen[0], session.state);
  // State updates are not part of the replayable log.
  assert.deepEqual(session.events.map(({ type }) => type), ["user", "turn_start", "turn_end"]);
});

test("config options and modes round-trip through the agent and notify state listeners", async (t) => {
  const { runtime, cwd, messages } = setup(t);
  const session = await runtime.createSession(cwd, "claude");
  const seen = [];
  session.stateListeners.add((state) => seen.push(state));

  const afterModel = await runtime.setConfigOption(session.id, "model", "smart");
  assert.equal(afterModel, session.state);
  assert.equal(afterModel.configOptions.find(({ id }) => id === "model").currentValue, "smart");
  assert.deepEqual(messages("claude", "session/set_config_option").at(-1).message.params, {
    sessionId: "session-1", configId: "model", value: "smart",
  });

  const afterBoolean = await runtime.setConfigOption(session.id, "fast", true);
  assert.equal(afterBoolean.configOptions.find(({ id }) => id === "fast").currentValue, true);
  assert.deepEqual(messages("claude", "session/set_config_option").at(-1).message.params, {
    sessionId: "session-1", configId: "fast", type: "boolean", value: true,
  });

  const afterMode = await runtime.setMode(session.id, "plan");
  assert.equal(afterMode.modes.currentModeId, "plan");
  assert.deepEqual(afterMode.modes.availableModes.map(({ id }) => id), ["default", "plan"]);
  assert.deepEqual(messages("claude", "session/set_mode").at(-1).message.params, { sessionId: "session-1", modeId: "plan" });

  // Selecting the mode config option makes the fixture push current_mode_update.
  await runtime.setConfigOption(session.id, "mode", "default");
  await until(() => session.state.modes.currentModeId === "default", "current_mode_update");
  assert.equal(session.state.configOptions.find(({ id }) => id === "mode").currentValue, "default");
  assert.ok(seen.length >= 4);
  assert.equal(seen.at(-1), session.state);
  assert.deepEqual(session.events, []);
  assert.deepEqual(runtime.listSessions()[0].state, session.state);
  await assert.rejects(runtime.setConfigOption("missing", "model", "smart"), /session/i);
  await assert.rejects(runtime.setMode("missing", "plan"), /session/i);
});

test("Stop cancels an open permission prompt before the agent is told to stop", async (t) => {
  const { runtime, cwd, records, messages } = setup(t);
  const session = await runtime.createSession(cwd, "claude");
  await runtime.sendPrompt(session.id, "hold");
  await until(() => session.pendingPermissions.size === 1, "permission request");
  const [requestId] = session.pendingPermissions;
  assert.equal(session.events.at(-1).type, "permission_request");

  await runtime.cancel(session.id);
  await until(() => !session.busy, "cancellation");
  assert.deepEqual(session.events.slice(-2), [
    { type: "permission_response", requestId, outcome: "cancelled" },
    { type: "turn_end", stopReason: "cancelled" },
  ]);
  assert.equal(session.pendingPermissions.size, 0);
  const answerIndex = records().findIndex(({ message }) => message?.id === "permission-1" && message.result);
  assert.deepEqual(records()[answerIndex].message.result, { outcome: { outcome: "cancelled" } });
  assert.equal(messages("claude", "session/cancel").length, 1);
  // The agent hears the cancelled answer before it is told to stop the turn.
  assert.ok(answerIndex < records().findIndex(({ message }) => message?.method === "session/cancel"));
  assert.throws(() => runtime.respondPermission(session.id, requestId, "always"), /no longer open/i);
});

test("permission answers must name an open request on the same session and an offered option", async (t) => {
  const { runtime, cwd, records } = setup(t);
  const session = await runtime.createSession(cwd, "claude");
  const other = await runtime.createSession(cwd, "codex");
  await runtime.sendPrompt(session.id, "hold");
  await until(() => session.pendingPermissions.size === 1, "permission request");
  const [requestId] = session.pendingPermissions;

  assert.throws(() => runtime.respondPermission(session.id, "nope", "always"), /no longer open/i);
  assert.throws(() => runtime.respondPermission(other.id, requestId, "always"), /no longer open/i);
  assert.throws(() => runtime.respondPermission(session.id, requestId, "sudo"), /unknown permission option/i);
  assert.throws(() => runtime.respondPermission("missing", requestId, "always"), /session/i);
  assert.equal(session.pendingPermissions.size, 1);
  assert.equal(records().some(({ message }) => message?.id === "permission-1" && message.result), false);

  runtime.respondPermission(session.id, requestId, null);
  assert.deepEqual(session.events.at(-1), { type: "permission_response", requestId, outcome: "cancelled" });
  await until(() => records().some(({ message }) => message?.id === "permission-1" && message.result), "cancelled answer");
  await runtime.cancel(session.id);
  await until(() => !session.busy, "cancellation");
});

test("projectId is kept as Portal metadata and never crosses the ACP wire", async (t) => {
  const { runtime, cwd, messages } = setup(t);
  const session = await runtime.createSession(cwd, "claude", "proj-1");
  assert.equal(session.projectId, "proj-1");
  assert.equal(runtime.getSession(session.id).projectId, "proj-1");
  assert.deepEqual(runtime.listSessions().map(({ id, projectId }) => ({ id, projectId })), [{ id: session.id, projectId: "proj-1" }]);
  assert.deepEqual(messages("claude", "session/new")[0].message.params, { cwd, mcpServers: [] });
  // Sessions created without a project (older callers, tests) carry an empty id rather than undefined.
  const unowned = await runtime.createSession(cwd, "claude");
  assert.equal(unowned.projectId, "");
  assert.equal(messages("claude", "session/new").length, 2);
});
