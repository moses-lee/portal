import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import { createShellRuntime } from "../src/lib/shell-runtime.ts";
import { checkSameOrigin, parseShellCommand } from "../src/lib/shell-http.ts";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
  }
}

function bashRuntime(cwd, overrides = {}) {
  return createShellRuntime({
    cwd, shell: "/bin/bash", args: ["--noprofile", "--rcfile", fileURLToPath(new URL("./fixtures/shell.bashrc", import.meta.url)), "-i"],
    env: { ...process.env, PS1: "PORTAL_TEST> ", HISTFILE: "/dev/null" }, pollIntervalMs: 40, ...overrides,
  });
}

function setup(t) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-shell-")));
  const runtime = bashRuntime(cwd);
  const events = [];
  const unsubscribe = runtime.subscribe((event) => events.push(event), true);
  t.after(() => { unsubscribe(); runtime.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  return {
    runtime, cwd, events,
    output: () => events.filter((event) => event.type === "output").map((event) => event.data).join(""),
    write: (data) => runtime.write(runtime.getState().id, data),
    snapshot: () => {
      let snapshot;
      runtime.subscribe((event) => { snapshot = event; }, true)();
      return snapshot;
    },
  };
}

test("one real shell survives detach, shares output, and restores terminal state", native, async (t) => {
  const { runtime, output, write, snapshot } = setup(t);
  assert.equal(runtime.getState().status, "idle");
  const first = runtime.start(null);
  assert.equal(runtime.start(null).id, first.id);
  await until(() => output().includes("PORTAL_TEST>"), "shell prompt");
  const viewer = [];
  const detach = runtime.subscribe((event) => viewer.push(event), true);
  write("printf 'shared-output\\n'\r");
  await until(() => output().includes("shared-output"), "output");
  assert.ok(viewer.some((event) => event.type === "output" && event.data.includes("shared-output")));
  detach();
  write("sleep 0.1; printf 'while-hidden\\n'\r");
  await until(() => output().includes("while-hidden"), "detached command");
  assert.equal(runtime.getState().id, first.id);
  assert.match(snapshot().data, /shared-output[\s\S]*while-hidden/);

  write("printf '\\033[?1049h\\033[2J\\033[Halternate-screen'\r");
  await until(() => output().includes("alternate-screen"), "alternate screen");
  const saved = snapshot();
  const restored = new xterm.Terminal({ cols: saved.state.cols, rows: saved.state.rows, allowProposedApi: true });
  t.after(() => restored.dispose());
  await new Promise((resolve) => restored.write(saved.data, resolve));
  assert.equal(restored.buffer.active.type, "alternate");
  assert.match(restored.buffer.active.getLine(0).translateToString(), /alternate-screen/);
});

test("directory changes use the actual process, including aliases, spaces and failed cd", native, async (t) => {
  const { runtime, cwd, write, output } = setup(t);
  const target = path.join(cwd, "project with spaces");
  mkdirSync(target);
  const portalCwd = process.cwd();
  runtime.start(null);
  await until(() => output().includes("PORTAL_TEST>"), "shell prompt");
  write("alias project='cd \"project with spaces\"'\rproject\r");
  await until(async () => (await runtime.refresh()).cwd === target, "alias cd");
  assert.equal(process.cwd(), portalCwd);
  write("cd /portal-directory-that-does-not-exist\r");
  await until(() => output().includes("No such file or directory"), "failed cd");
  assert.equal((await runtime.refresh()).cwd, target);
  write("printf '\\033]7;file://localhost/fake-directory\\007'\rcd ..\r");
  await until(async () => (await runtime.refresh()).cwd === cwd, "parent directory");
  assert.equal(runtime.getState().cwdError, null);
});

test("PTY resize reaches programs, Ctrl+C interrupts, and exit requires an explicit restart", native, async (t) => {
  const { runtime, write, output, snapshot } = setup(t);
  const first = runtime.start(null);
  await until(() => output().includes("PORTAL_TEST>"), "shell prompt");
  runtime.resize(first.id, 100, 35);
  await until(() => runtime.getState().cols === 100, "resize");
  write("stty size\r");
  await until(() => output().includes("35 100"), "PTY dimensions");
  write("sleep 30\r");
  await delay(100);
  write("\u0003");
  write("printf 'interrupted-ok\\n'\r");
  await until(() => output().includes("interrupted-ok"), "Ctrl+C");
  write("exit 7\r");
  await until(() => runtime.getState().status === "exited", "exit");
  assert.equal(runtime.getState().exitCode, 7);
  assert.match(snapshot().data, /interrupted-ok/);
  assert.throws(() => runtime.write(first.id, "echo bad\r"), /no longer running/);
  assert.equal(runtime.start(null).status, "exited", "a stale page must not restart an exited shell");
  const replacement = runtime.start(first.id);
  assert.notEqual(replacement.id, first.id);
  assert.equal(runtime.start(first.id).id, replacement.id);
  assert.throws(() => runtime.write(first.id, "echo stale\r"), /no longer running/);
  assert.doesNotMatch(snapshot().data, /interrupted-ok/);
});

test("scrollback stays bounded while large output is parsed and replayed", native, async (t) => {
  const { runtime, write, output, snapshot } = setup(t);
  runtime.start(null);
  await until(() => output().includes("PORTAL_TEST>"), "shell prompt");
  write("printf 'old-marker\\n'; for ((i=0;i<2500;i++)); do printf 'line-%s\\n' \"$i\"; done; printf 'final-marker\\n'\r");
  await until(() => output().includes("final-marker"), "large output");
  const data = snapshot().data;
  assert.doesNotMatch(data, /old-marker/);
  assert.match(data, /line-2499[\s\S]*final-marker/);
});

test("shell commands reject cross-origin requests, oversized input and invalid geometry", async () => {
  const request = (body, headers = {}) => new Request("http://localhost:3000/api/shell", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  assert.equal(checkSameOrigin(request({}, { origin: "http://evil.example" })).status, 403);
  assert.equal(checkSameOrigin(request({}, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal(checkSameOrigin(request({}, { origin: "http://localhost:3000" })), null);
  assert.equal(checkSameOrigin(new Request("http://100.1.2.3:3000/api/shell", { headers: { origin: "http://100.1.2.3:3000" } })), null);
  assert.deepEqual(parseShellCommand({ action: "input", id: "abc", data: "\u0003" }), { action: "input", id: "abc", data: "\u0003" });
  for (const command of [
    null, [], { action: "input", data: "hi" }, { action: "input", id: "abc", data: "a".repeat(17000) },
    { action: "resize", id: "abc", cols: 0, rows: 24 }, { action: "resize", id: "abc", cols: 80, rows: 1.5 },
    { action: "resize", id: "abc", cols: 80, rows: 300 }, { action: "unknown", id: "abc" },
  ]) assert.throws(() => parseShellCommand(command));
});

test("tracks the repository and branch of the shell directory", native, async (t) => {
  const { runtime, cwd, output, write } = setup(t);
  const repo = path.join(cwd, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  await until(() => runtime.getState().git === null, "no repository at the launch directory");
  runtime.start(null);
  await until(() => output().includes("PORTAL_TEST>"), "shell prompt");
  write("cd repo\r");
  await until(() => runtime.getState().git?.branch === "main", "branch after cd");
  assert.equal(runtime.getState().git.root, repo);
  assert.equal(runtime.getState().cwd, repo);
  write("git checkout -q -b topic\r");
  await until(() => runtime.getState().git?.branch === "topic", "branch after checkout");
  write("cd ..\r");
  await until(() => runtime.getState().git === null && runtime.getState().cwd === cwd, "leaving the repository");
});

test("directory polling runs only while subscribed; refresh() still answers on demand", native, async (t) => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-shell-")));
  const runtime = bashRuntime(cwd);
  t.after(() => { runtime.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  const target = path.join(cwd, "sub");
  mkdirSync(target);
  runtime.start(null);
  const output = [];
  const unsubscribe = runtime.subscribe((event) => { if (event.type === "output") output.push(event.data); }, true);
  await until(() => output.join("").includes("PORTAL_TEST>"), "shell prompt");
  unsubscribe();
  runtime.write(runtime.getState().id, "cd sub\r");
  await delay(250);
  assert.equal(runtime.getState().cwd, cwd, "no poll without subscribers");
  assert.equal((await runtime.refresh()).cwd, target);
  assert.equal(runtime.getState().cwd, target);
  const detach = runtime.subscribe(() => {});
  runtime.write(runtime.getState().id, "cd ..\r");
  await until(() => runtime.getState().cwd === cwd, "poll while subscribed");
  detach();
  runtime.write(runtime.getState().id, "cd sub\r");
  await delay(250);
  assert.equal(runtime.getState().cwd, cwd, "poll stops after the last unsubscribe");
  assert.equal((await runtime.refresh()).cwd, target);
});

test("a missing launch directory fails start with a readable error and allows a retry", native, async (t) => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-shell-")));
  const runtime = bashRuntime(cwd);
  t.after(() => { runtime.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  rmSync(cwd, { recursive: true, force: true });
  assert.throws(() => runtime.start(null), new RegExp(`^Error: Could not start a terminal in ${cwd}: `));
  assert.equal(runtime.getState().status, "idle");
  assert.equal(runtime.getState().id, null);
  mkdirSync(cwd);
  assert.equal(runtime.start(null).status, "running");
});
