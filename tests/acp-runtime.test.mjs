import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcpRuntime } from "../src/lib/acp-runtime.ts";
import { createFileSessionStore } from "../src/lib/file-session-store.ts";
import { createMemorySessionStore } from "../src/lib/session-store.ts";

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
  // Every runtime built over this fixture (including "restarted" ones) is disposed together.
  const runtimes = [];
  const spawnRuntime = (extra = {}) => {
    const runtime = createAcpRuntime(definitions, {
      initializeTimeoutMs: options.initializeTimeoutMs ?? 2_000,
      agentCallTimeoutMs: options.agentCallTimeoutMs,
      store: options.store,
      recentEvents: options.recentEvents,
      ...extra,
    });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = spawnRuntime();
  const records = () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const messages = (agentId, method) => records().filter((entry) =>
    entry.agentId === agentId && entry.message?.method === method,
  );
  const starts = (agentId) => records().filter((entry) => entry.agentId === agentId && entry.event === "spawn");

  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
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
    runtime, cwd, records, messages, starts, spawnRuntime,
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

// --- Persistence -------------------------------------------------------------------------------


/** Build a second runtime over the same store and fixture, as a server restart would. */
function restart(t, ctx, modes = {}) {
  ctx.setModes(modes);
  return ctx.spawnRuntime();
}

function persistentSetup(t, options = {}) {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), "portal-acp-store-"));
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  const store = createFileSessionStore({ dir: storeDir, chunkSize: 256 });
  return { ...setup(t, { ...options, store }), store, storeDir };
}

test("events and metadata are written through to the store and paged from it", async (t) => {
  const { runtime, cwd, store, storeDir } = persistentSetup(t, { recentEvents: 3 });
  await runtime.ready;
  const session = await runtime.createSession(cwd, "claude", "proj-1");
  assert.deepEqual(session.link, { status: "live" });
  assert.equal(session.title, null);
  await runtime.sendPrompt(session.id, "  Summarize this repo\nplease  ");
  await answerPermission(runtime, session, "once");
  await until(() => !session.busy, "turn");
  assert.equal(session.title, "Summarize this repo");
  assert.ok(session.lastActiveAt >= session.createdAt);

  // user, turn_start, update, permission_request, permission_response, turn_end
  const page = await runtime.readEvents(session.id, { limit: 10 });
  assert.deepEqual(page.events.map(({ type }) => type), ["user", "turn_start", "update", "permission_request", "permission_response", "turn_end"]);
  assert.deepEqual(page.events.map(({ seq }) => seq), [0, 1, 2, 3, 4, 5]);
  assert.ok(page.events.every(({ ts }) => typeof ts === "number"));
  assert.equal(page.hasMore, false);
  assert.equal(page.nextSeq, 6);
  // Only the newest events stay in memory; the store holds the rest.
  assert.equal(session.events.length, 3);
  assert.equal(session.eventBase, 3);
  assert.deepEqual(runtime.eventsSince(session.id, 2).map(({ seq }) => seq), [3, 4, 5]);
  assert.deepEqual(runtime.eventsSince(session.id, 5), []);
  assert.equal(runtime.eventsSince(session.id, 1), null);

  const [record] = await store.listSessions();
  assert.equal(record.id, session.id);
  assert.equal(record.upstreamId, "session-1");
  assert.equal(record.projectId, "proj-1");
  assert.equal(record.title, "Summarize this repo");
  assert.equal(record.state.commands.length, 2);
  assert.equal(readFileSync(path.join(storeDir, "logs", `${session.id}.jsonl`), "utf8").trim().split("\n").length, 6);
  assert.deepEqual(runtime.listSessions().map(({ id, title, link }) => ({ id, title, link })), [{ id: session.id, title: "Summarize this repo", link: { status: "live" } }]);
});

test("persisted sessions come back offline after a restart, resume on demand, and keep appending", async (t) => {
  const first = persistentSetup(t);
  const { runtime, cwd } = first;
  const session = await runtime.createSession(cwd, "claude", "proj-1");
  const idle = await runtime.createSession(cwd, "codex");
  await runtime.sendPrompt(session.id, "hello");
  await answerPermission(runtime, session, "once");
  await until(() => !session.busy, "turn");
  await runtime.setMode(session.id, "plan");
  // A second turn is left open when the server stops.
  await runtime.sendPrompt(session.id, "hold");
  await until(() => session.pendingPermissions.size === 1, "held permission");
  await runtime.dispose();

  const next = restart(t, first, { claude: "resume" });
  await next.ready;
  const listed = next.listSessions();
  assert.deepEqual(listed.map(({ id }) => id), [session.id, idle.id]);
  const restored = next.getSession(session.id);
  assert.deepEqual(restored.link, { status: "offline", error: null });
  assert.equal(restored.busy, false);
  assert.equal(restored.title, "hello");
  assert.equal(restored.projectId, "proj-1");
  assert.equal(restored.state.modes.currentModeId, "plan");
  assert.equal(first.starts("claude").length, 1);

  // The cut-off turn is closed with an error so the transcript does not end mid-turn.
  const page = await next.readEvents(session.id, { limit: 100 });
  assert.equal(page.events.at(-1).type, "error");
  assert.match(page.events.at(-1).message, /restarted/i);
  // Shutdown cancels the open permission prompt (the agent hears that), then the restart closes the turn.
  assert.deepEqual(page.events.slice(-6).map(({ type }) => type), ["user", "turn_start", "update", "permission_request", "permission_response", "error"]);
  assert.equal(page.events[0].seq, 0);
  const idlePage = await next.readEvents(idle.id);
  assert.deepEqual(idlePage, { events: [], hasMore: false, nextSeq: 0 });

  // Opening the session reattaches the agent with session/resume, never session/new.
  await next.attach(session.id);
  assert.deepEqual(restored.link, { status: "live" });
  assert.equal(first.starts("claude").length, 2);
  const resumes = first.messages("claude", "session/resume");
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].message.params, { sessionId: "session-1", cwd, mcpServers: [] });
  assert.equal(first.messages("claude", "session/new").length, 1);
  assert.equal(restored.state.modes.currentModeId, "plan");
  await until(() => restored.state.commands.length === 2, "commands after resume");
  await next.attach(session.id); // Already live: no second request.
  assert.equal(first.messages("claude", "session/resume").length, 1);

  const before = page.nextSeq;
  await next.sendPrompt(session.id, "after restart");
  await answerPermission(next, restored, "once");
  await until(() => !restored.busy, "turn after restart");
  assert.equal(first.messages("claude", "session/prompt").at(-1).message.params.sessionId, "session-1");
  const after = await next.readEvents(session.id, { limit: 4 });
  assert.deepEqual(after.events.map(({ seq }) => seq), [before, before + 1, before + 2, before + 3, before + 4, before + 5]);
  assert.equal(after.events[0].type, "user");
  assert.equal(after.hasMore, true);
  const older = await next.readEvents(session.id, { before: after.events[0].seq, limit: 4 });
  assert.equal(older.events.at(-1).seq, before - 1);
  assert.equal(older.events[0].type, "user");
});

test("sending a prompt reattaches an offline session first, and load replays are not logged twice", async (t) => {
  const first = persistentSetup(t);
  const { runtime, cwd } = first;
  const session = await runtime.createSession(cwd, "claude");
  await runtime.sendPrompt(session.id, "hello");
  await answerPermission(runtime, session, "once");
  await until(() => !session.busy, "turn");
  await runtime.dispose();

  const next = restart(t, first, { claude: "load" });
  await next.ready;
  const restored = next.getSession(session.id);
  await next.sendPrompt(session.id, "again");
  assert.deepEqual(restored.link, { status: "live" });
  assert.equal(first.messages("claude", "session/load").length, 1);
  assert.equal(first.messages("claude", "session/resume").length, 0);
  await answerPermission(next, restored, "once");
  await until(() => !restored.busy, "turn after load");
  const page = await next.readEvents(session.id, { limit: 100 });
  const texts = page.events.filter(({ type }) => type === "update").map(({ update }) => update.content.text);
  assert.deepEqual(texts, ["claude:hello", "claude:again"]);
  assert.deepEqual(page.events.map(({ type }) => type).filter((type) => type === "user").length, 2);
});

test("agents that cannot resume leave persisted sessions offline without launching a process twice", async (t) => {
  const first = persistentSetup(t);
  const { runtime, cwd } = first;
  const session = await runtime.createSession(cwd, "claude");
  await runtime.dispose();

  const next = restart(t, first, {});
  await next.ready;
  const restored = next.getSession(session.id);
  await assert.rejects(next.attach(session.id), /cannot resume/i);
  assert.equal(restored.link.status, "offline");
  assert.match(restored.link.error, /cannot resume/i);
  await assert.rejects(next.sendPrompt(session.id, "hi"), /cannot resume/i);
  await assert.rejects(next.cancel(session.id), /not connected/i);
  // Only one probe process was needed to learn the capabilities.
  assert.equal(first.starts("claude").length, 2);
  // History is still readable while offline.
  const page = await next.readEvents(session.id);
  assert.deepEqual(page, { events: [], hasMore: false, nextSeq: 0 });

  // A resume that the agent rejects reports the agent's error and stays retryable.
  const later = restart(t, first, { claude: "resume" });
  await later.ready;
  first.setModes({ claude: "resume-error" });
  await assert.rejects(later.attach(session.id), /could not reconnect.*cannot resume that session/i);
  assert.equal(later.getSession(session.id).link.status, "offline");
  first.setModes({ claude: "resume" });
  await later.attach(session.id);
  assert.deepEqual(later.getSession(session.id).link, { status: "live" });
});

test("a crashed agent leaves its sessions offline and a later prompt reconnects them", async (t) => {
  const { runtime, cwd, setModes, starts, messages } = persistentSetup(t);
  setModes({ claude: "resume" });
  const session = await runtime.createSession(cwd, "claude");
  const links = [];
  session.linkListeners.add((link) => links.push(link.status));
  await runtime.sendPrompt(session.id, "exit");
  await until(() => session.link.status === "offline", "offline after exit");
  assert.match(session.link.error, /exited|closed|disconnect/i);
  assert.equal(session.events.at(-1).type, "error");
  assert.equal(starts("claude").length, 1);

  await runtime.sendPrompt(session.id, "back");
  assert.deepEqual(links, ["offline", "connecting", "live"]);
  assert.equal(starts("claude").length, 2);
  assert.equal(messages("claude", "session/resume").length, 1);
  await answerPermission(runtime, session, "once");
  await until(() => !session.busy, "turn after reconnect");
  assert.deepEqual(session.events.at(-1), { type: "turn_end", stopReason: "end_turn" });
});

test("deleting a session closes it on the agent, notifies viewers, and removes its log", async (t) => {
  const { runtime, cwd, store, storeDir, setModes, messages } = persistentSetup(t);
  setModes({ claude: "resume" });
  const session = await runtime.createSession(cwd, "claude");
  const other = await runtime.createSession(cwd, "claude");
  await runtime.sendPrompt(session.id, "hold");
  await until(() => session.pendingPermissions.size === 1, "held permission");
  let closed = 0;
  session.closeListeners.add(() => closed++);

  assert.equal(await runtime.deleteSession(session.id), true);
  assert.equal(closed, 1);
  assert.equal(runtime.getSession(session.id), undefined);
  assert.deepEqual(runtime.listSessions().map(({ id }) => id), [other.id]);
  assert.deepEqual((await store.listSessions()).map(({ id }) => id), [other.id]);
  assert.equal(existsSync(path.join(storeDir, "logs", `${session.id}.jsonl`)), false);
  assert.equal(session.pendingPermissions.size, 0);
  await until(() => messages("claude", "session/close").length === 1, "session/close");
  assert.deepEqual(messages("claude", "session/close")[0].message.params, { sessionId: "session-1" });
  assert.equal(messages("claude", "session/cancel").length, 1);
  assert.equal(await runtime.deleteSession(session.id), false);
  await assert.rejects(runtime.sendPrompt(session.id, "gone"), /no such session/i);
  // The sibling session on the same process is unaffected.
  await runtime.sendPrompt(other.id, "still here");
  await answerPermission(runtime, other, "once");
  await until(() => !other.busy, "sibling turn");
});

test("only a turn that was really cut off is closed on restart", async (t) => {
  const store = createMemorySessionStore();
  const record = (id) => ({
    id, agentId: "claude", agentName: "Claude Code", cwd: os.tmpdir(), projectId: "", createdAt: 1, lastActiveAt: 1,
    title: "t", upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] },
  });
  const usage = { type: "update", update: { sessionUpdate: "usage_update", used: 1, size: 2 } };
  const logs = {
    // Trailing usage reports after the end of a turn do not mean the turn was cut off.
    finished: [{ type: "user", text: "hi" }, { type: "turn_start" }, { type: "turn_end", stopReason: "end_turn" }, usage, usage],
    // A long turn with no end in sight was cut off, however far back its start is.
    cut: [{ type: "user", text: "hi" }, { type: "turn_start" }, ...Array.from({ length: 700 }, () => usage)],
    // A prompt that failed before the turn started is already closed by its error.
    failed: [{ type: "user", text: "hi" }, { type: "turn_start" }, { type: "error", message: "nope" }],
    empty: [],
  };
  for (const [id, events] of Object.entries(logs)) {
    await store.putSession(record(id));
    for (const [seq, event] of events.entries()) await store.appendEvent(id, { ...event, seq, ts: 0 });
  }
  const runtime = createAcpRuntime([], { store });
  t.after(() => runtime.dispose());
  await runtime.ready;
  const last = async (id) => (await runtime.readEvents(id, { limit: 1 })).events.at(-1)?.type;
  assert.equal(await last("finished"), "update");
  assert.equal(await store.eventCount("finished"), 5);
  assert.equal(await last("cut"), "error");
  assert.equal(await store.eventCount("cut"), 703);
  assert.equal(await last("failed"), "error");
  assert.equal(await store.eventCount("failed"), 3);
  assert.equal(await store.eventCount("empty"), 0);
  assert.deepEqual(runtime.listSessions().map(({ link }) => link.status), ["offline", "offline", "offline", "offline"]);
});

test("deleting a session while it reconnects does not bring it back", async (t) => {
  const first = persistentSetup(t);
  const { runtime, cwd, store } = first;
  const session = await runtime.createSession(cwd, "claude");
  await runtime.dispose();

  const next = restart(t, first, { claude: "resume" });
  await next.ready;
  const attaching = next.attach(session.id);
  assert.equal(await next.deleteSession(session.id), true);
  // Whether the reconnect finished first or was cut short, the session must be gone everywhere.
  await attaching.catch(() => {});
  assert.equal(next.getSession(session.id), undefined);
  assert.deepEqual(await store.listSessions(), []);
  // The agent process is up but holds no registration for the deleted session.
  const later = await next.createSession(cwd, "claude");
  assert.equal(first.messages("claude", "session/new").length, 2);
  await next.sendPrompt(later.id, "hello");
  await answerPermission(next, later, "once");
  await until(() => !later.busy, "turn on the replacement");
  const third = restart(t, first, { claude: "resume" });
  await third.ready;
  assert.deepEqual(third.listSessions().map(({ id }) => id), [later.id]);
});

test("a write the store rejects loses only that event", async (t) => {
  const inner = createMemorySessionStore();
  let failOnce = true;
  const store = { ...inner, appendEvent: async (id, event) => {
    if (failOnce && event.seq === 2) { failOnce = false; throw new Error("disk full"); }
    return inner.appendEvent(id, event);
  } };
  const { runtime, cwd } = setup(t, { store });
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  t.after(() => { console.error = original; });
  const session = await runtime.createSession(cwd, "claude");
  await runtime.sendPrompt(session.id, "hello");
  await answerPermission(runtime, session, "once");
  await until(() => !session.busy, "turn");
  const page = await runtime.readEvents(session.id);
  // user 0, turn_start 1, [update 2 lost], permission_request 3, permission_response 4, turn_end 5
  assert.deepEqual(page.events.map(({ seq }) => seq), [0, 1, 3, 4, 5]);
  assert.equal(page.nextSeq, 6);
  assert.equal(errors.filter((line) => /Could not save event 2/.test(line)).length, 1);
  assert.equal(errors.length, 1);
});

test("deleting a session gives up on a stalled agent instead of hanging", async (t) => {
  const { runtime, cwd, setModes, messages } = setup(t, { agentCallTimeoutMs: 200 });
  setModes({ claude: "hang-close" });
  const session = await runtime.createSession(cwd, "claude");
  const started = Date.now();
  assert.equal(await runtime.deleteSession(session.id), true);
  assert.ok(Date.now() - started < 2_000, "delete returned promptly");
  assert.equal(messages("claude", "session/close").length, 1);
  assert.equal(runtime.getSession(session.id), undefined);
});

test("list subscribers hear sessions being created, working, waiting on permission, and deleted", async (t) => {
  const { runtime, cwd } = setup(t);
  const changes = [];
  const unsubscribe = runtime.onSessionsChange((change) => changes.push(change));
  const session = await runtime.createSession(cwd, "claude");
  assert.deepEqual(changes.map(({ type }) => type), ["created"]);
  assert.equal(changes[0].session.id, session.id);
  assert.equal(changes[0].session.awaitingPermission, false);
  assert.deepEqual(runtime.listSessions().map(({ awaitingPermission }) => awaitingPermission), [false]);

  const patches = () => changes.filter(({ type }) => type === "updated").map(({ patch }) => patch);
  await runtime.sendPrompt(session.id, "hold");
  assert.equal(patches().at(-1).busy, true);
  assert.equal(patches().at(-1).title, "hold");
  await until(() => patches().some((patch) => patch.awaitingPermission), "waiting on permission");
  assert.equal(runtime.listSessions()[0].awaitingPermission, true);
  await answerPermission(runtime, session);
  assert.equal(patches().at(-1).awaitingPermission, false);
  assert.equal(patches().at(-1).busy, true);
  await runtime.cancel(session.id);
  await until(() => !session.busy, "cancellation");
  assert.deepEqual(patches().at(-1), { busy: false, awaitingPermission: false, link: { status: "live" }, title: "hold", lastActiveAt: session.lastActiveAt });

  await runtime.deleteSession(session.id);
  assert.deepEqual(changes.at(-1), { type: "deleted", id: session.id });
  unsubscribe();
  await runtime.createSession(cwd, "codex");
  assert.deepEqual(changes.at(-1), { type: "deleted", id: session.id });
});
