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
  await until(() => records().filter(({ message }) => message?.result?.outcome?.outcome === "selected").length === 2, "permission responses");

  for (const session of [claude, codex]) {
    assert.deepEqual(session.events.filter(({ type }) => type === "update").map(({ update }) => update.content.text), [`${session.agentId}:hold`]);
    assert.deepEqual(session.events.filter(({ type }) => type === "permission"), [{
      type: "permission", title: `${session.agentId} tool`, optionId: "always", optionName: "Always allow",
    }]);
    assert.equal(messages(session.agentId, "session/prompt")[0].message.params.sessionId, "session-1");
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
  await until(() => !second.busy, "second session response");
  assert.equal(first.busy, true);
  assert.deepEqual(second.events.at(-1), { type: "turn_end", stopReason: "end_turn" });
  assert.equal(messages("claude", "session/prompt").length, 2);
  await until(() => records().filter(({ message }) => message?.result?.outcome?.outcome === "selected").length === 2, "permission responses");
  await runtime.cancel(first.id);
  await until(() => !first.busy, "first session cancellation");
});

test("agent exit preserves its peer and never reuses disconnected sessions after restarting", async (t) => {
  const { runtime, cwd, starts, messages } = setup(t);
  const old = await runtime.createSession(cwd, "claude");
  const idle = await runtime.createSession(cwd, "claude");
  const peer = await runtime.createSession(cwd, "codex");
  await runtime.sendPrompt(old.id, "exit");
  await until(() => old.events.some(({ type }) => type === "error") && !old.busy, "agent exit");
  await assert.rejects(runtime.sendPrompt(old.id, "again"), /session|exited|disconnect/i);
  await assert.rejects(runtime.sendPrompt(idle.id, "again"), /session|exited|disconnect/i);
  await assert.rejects(runtime.cancel(old.id), /session|exited|disconnect/i);
  assert.equal(starts("claude").length, 1);

  await runtime.sendPrompt(peer.id, "still here");
  await until(() => !peer.busy, "unaffected peer response");
  assert.equal(peer.events.some(({ type }) => type === "error"), false);
  assert.equal(starts("codex").length, 1);

  const replacement = await runtime.createSession(cwd, "claude");
  assert.notEqual(replacement.id, old.id);
  assert.equal(starts("claude").length, 2);
  const oldEvents = old.events.length;
  await runtime.sendPrompt(replacement.id, "new process");
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
