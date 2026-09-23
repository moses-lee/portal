import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execCommand } from "../src/lib/exec-command.ts";
import { ScriptError, describeFailure, runConfiguredScript, runScript } from "../src/lib/script-runner.ts";
import { defaultScriptSettings, scriptDefinitions } from "../src/lib/scripts.ts";

const settings = (overrides = {}) => ({ ...defaultScriptSettings, command: "true", ...overrides });

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-script-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Collect console.warn calls made while `fn` runs. */
async function capturingWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("a blank command means the script is off: nothing runs", async (t) => {
  const cwd = tempDir(t);
  let calls = 0;
  const exec = async () => { calls++; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  assert.deepEqual(await runScript("preWorktreeDelete", settings({ command: "" }), { cwd }, exec), { ran: false });
  assert.deepEqual(await runScript("preWorktreeDelete", settings({ command: "   " }), { cwd }, exec), { ran: false });
  assert.equal(calls, 0);
});

test("runs the command in cwd with the user's environment, the kind, and the caller's variables", async (t) => {
  const cwd = tempDir(t);
  const outcome = await runScript(
    "preWorktreeDelete",
    settings({ command: "pwd; echo $PORTAL_SCRIPT; echo $PORTAL_BRANCH; echo $HOME" }),
    { cwd, env: { PORTAL_BRANCH: "feat/x" } },
  );
  assert.equal(outcome.ran, true);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 0);
  assert.deepEqual(outcome.stdout.trim().split("\n"), [cwd, "preWorktreeDelete", "feat/x", os.homedir()]);
});

test("the runner hands execCommand the timeout in milliseconds and a bounded output size", async (t) => {
  const cwd = tempDir(t);
  const seen = [];
  const exec = async (command, opts) => { seen.push({ command, opts }); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  await runScript("preWorktreeDelete", settings({ command: "make clean", timeoutSeconds: 7 }), { cwd }, exec);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, "make clean");
  assert.equal(seen[0].opts.cwd, cwd);
  assert.equal(seen[0].opts.timeoutMs, 7000);
  assert.ok(seen[0].opts.maxBytes > 0);
  assert.equal(seen[0].opts.env.PORTAL_SCRIPT, "preWorktreeDelete");
  assert.equal(seen[0].opts.shell, process.env.SHELL || true, "runs in the user's login shell");
});

test("a caller's maxTimeoutSeconds caps the configured timeout, and the failure message names the cap", async (t) => {
  const cwd = tempDir(t);
  const seen = [];
  const exec = async (command, opts) => { seen.push(opts); return { code: null, stdout: "", stderr: "", timedOut: true }; };
  await assert.rejects(
    runScript("preWorktreeDelete", settings({ timeoutSeconds: 3600 }), { cwd, maxTimeoutSeconds: 240 }, exec),
    (err) => { assert.match(err.message, /did not finish within 240 seconds/); return true; },
  );
  assert.equal(seen[0].timeoutMs, 240_000);
  // A cap above the configured timeout changes nothing.
  await runScript("preWorktreeDelete", settings({ timeoutSeconds: 10, abortOnFailure: false }), { cwd, maxTimeoutSeconds: 240 }, async (c, opts) => { seen.push(opts); return { code: 0, stdout: "", stderr: "", timedOut: false }; });
  assert.equal(seen[1].timeoutMs, 10_000);
});

test("scriptShell prefers $SHELL and falls back to the platform shell", async () => {
  const { scriptShell } = await import("../src/lib/script-runner.ts");
  assert.equal(scriptShell({ SHELL: "/bin/zsh" }), "/bin/zsh");
  assert.equal(scriptShell({}), true);
});

test("a failure with abortOnFailure throws a 409 ScriptError quoting the exit code and the output", async (t) => {
  const cwd = tempDir(t);
  await assert.rejects(
    runScript("preWorktreeDelete", settings({ command: "echo starting; echo 'disk is full' >&2; exit 3" }), { cwd }),
    (err) => {
      assert.ok(err instanceof ScriptError);
      assert.equal(err.status, 409);
      assert.equal(err.script, "preWorktreeDelete");
      assert.equal(err.outcome.code, 3);
      assert.match(err.message, /"before deleting a worktree" script exited with code 3/);
      assert.match(err.message, /disk is full/);
      assert.doesNotMatch(err.message, /starting/, "stderr is preferred over stdout when present");
      return true;
    },
  );
});

test("a failure without abortOnFailure is returned and warned about, not thrown", async (t) => {
  const cwd = tempDir(t);
  const { result, warnings } = await capturingWarnings(() =>
    runScript("preWorktreeDelete", settings({ command: "echo nope; exit 1", abortOnFailure: false }), { cwd }));
  assert.equal(result.ran, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Continuing after a script failure/);
  assert.match(warnings[0], /nope/);
});

test("a timeout is a failure: the process group is killed and the message names the limit", async (t) => {
  const cwd = tempDir(t);
  const started = Date.now();
  await assert.rejects(
    runScript("preWorktreeDelete", settings({ command: "sleep 30", timeoutSeconds: 1 }), { cwd }),
    (err) => {
      assert.ok(err instanceof ScriptError);
      assert.equal(err.outcome.timedOut, true);
      assert.equal(err.outcome.code, null);
      assert.match(err.message, /did not finish within 1 seconds/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, "did not wait for sleep to finish");
});

test("describeFailure quotes only the tail of long output", () => {
  const long = `${"x".repeat(5000)}THE END`;
  const message = describeFailure("preWorktreeDelete", settings(), { ran: true, ok: false, code: 2, stdout: long, stderr: "", timedOut: false });
  assert.ok(message.length < 1500);
  assert.ok(message.endsWith("THE END"));
  assert.ok(message.startsWith(`The "${scriptDefinitions.preWorktreeDelete.label.toLowerCase()}" script exited with code 2.`));
});

test("a missing cwd is reported as a failure rather than an exception", async (t) => {
  const root = tempDir(t);
  const result = await execCommand("true", { cwd: path.join(root, "gone"), timeoutMs: 5000, maxBytes: 1000 });
  assert.equal(result.code, null);
  await assert.rejects(runScript("preWorktreeDelete", settings(), { cwd: path.join(root, "gone") }), ScriptError);
});

test("runConfiguredScript runs the script the settings source holds for the kind", async (t) => {
  const cwd = tempDir(t);
  let reads = 0;
  const source = {
    read: async () => {
      reads++;
      return { scripts: { preWorktreeDelete: settings({ command: "echo configured > ran.txt", timeoutSeconds: 30 }) } };
    },
  };
  const outcome = await runConfiguredScript("preWorktreeDelete", { cwd }, source);
  assert.equal(reads, 1);
  assert.equal(outcome.ran, true);
  assert.equal(outcome.ok, true);
  assert.equal(readFileSync(path.join(cwd, "ran.txt"), "utf8").trim(), "configured");

  // A script that is off in the settings runs nothing.
  const off = { read: async () => ({ scripts: { preWorktreeDelete: settings({ command: "" }) } }) };
  assert.deepEqual(await runConfiguredScript("preWorktreeDelete", { cwd }, off), { ran: false });
});
