import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createTerminalRegistry, info } from "../src/terminals/registry.ts";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
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

function watch(entry) {
  const output = [];
  entry.runtime.subscribe((event) => { if (event.type === "output") output.push(event.data); }, true);
  return {
    text: () => output.join(""),
    write: (data) => entry.runtime.write(entry.runtime.getState().id, data),
    pid: () => Number(/pid=(\d+)/.exec(output.join(""))?.[1]),
  };
}

test("terminals are independent PTYs grouped by session and torn down individually or all at once", native, async (t) => {
  const dirs = Array.from({ length: 3 }, () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-terminals-"))));
  const terminals = createTerminalRegistry();
  t.after(() => { terminals.disposeAll(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const create = (sessionId, cwd) => terminals.create({
    sessionId, cwd, shell: "/bin/bash",
    args: ["--noprofile", "--rcfile", fileURLToPath(new URL("./fixtures/shell.bashrc", import.meta.url)), "-i"],
  });
  const a = create("session-1", dirs[0]);
  const b = create("session-1", dirs[1]);
  const other = create("session-2", dirs[2]);
  assert.deepEqual(terminals.listBySession("session-1").map((entry) => entry.id), [a.id, b.id]);
  assert.deepEqual(terminals.listBySession("session-2"), [other]);
  assert.deepEqual(terminals.listBySession("session-3"), []);
  assert.equal(terminals.get(a.id), a);
  assert.deepEqual(info(a), { id: a.id, sessionId: "session-1", createdAt: a.createdAt, state: a.runtime.getState() });
  assert.equal(info(a).state.status, "idle", "creating a terminal must not start its PTY");

  const closed = [];
  terminals.onClose((entry) => closed.push(entry));
  const viewA = watch(a);
  const viewB = watch(b);
  a.runtime.start(null);
  b.runtime.start(null);
  await until(() => viewA.text().includes("PORTAL_TEST>") && viewB.text().includes("PORTAL_TEST>"), "prompts");
  viewA.write("printf 'pid=%s dir=%s\\n' \"$$\" \"$PWD\"\r");
  viewB.write("printf 'pid=%s dir=%s\\n' \"$$\" \"$PWD\"\r");
  await until(() => viewA.text().includes(`dir=${dirs[0]}`) && viewB.text().includes(`dir=${dirs[1]}`), "pwd output");
  assert.ok(!viewA.text().includes(dirs[1]) && !viewB.text().includes(dirs[0]), "no cross-talk between terminals");
  const pidA = viewA.pid();
  const pidB = viewB.pid();
  assert.ok(pidA && pidB && pidA !== pidB);
  assert.ok(isAlive(pidA) && isAlive(pidB));

  assert.equal(terminals.close(a.id), true);
  assert.equal(terminals.close(a.id), false);
  assert.deepEqual(closed, [a]);
  assert.equal(terminals.get(a.id), undefined);
  assert.deepEqual(terminals.listBySession("session-1"), [b]);
  await until(() => !isAlive(pidA), "terminal A to exit");
  assert.ok(isAlive(pidB), "closing one terminal must not touch its sibling");
  viewB.write("printf 'still-%s\\n' alive\r");
  await until(() => viewB.text().includes("still-alive"), "terminal B output");

  terminals.disposeAll();
  await until(() => !isAlive(pidB), "terminal B to exit after disposeAll");
  assert.equal(terminals.get(b.id), undefined);
  assert.deepEqual(terminals.listBySession("session-1"), []);
  assert.deepEqual(terminals.listBySession("session-2"), []);
  assert.equal(closed.length, 3);
  terminals.disposeAll();
  assert.throws(() => create("session-1", dirs[0]), /shutting down/);
});

test("standalone terminals belong to no session and outlive session teardown", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-terminals-")));
  const terminals = createTerminalRegistry();
  t.after(() => { terminals.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  const standalone = terminals.create({ sessionId: null, cwd: dir });
  const owned = terminals.create({ sessionId: "session-1", cwd: dir });
  assert.equal(info(standalone).sessionId, null);
  assert.deepEqual(terminals.listStandalone(), [standalone]);
  assert.deepEqual(terminals.listBySession("session-1"), [owned]);
  assert.equal(info(standalone).state.status, "idle", "creating a standalone terminal must not start its PTY");

  terminals.closeSession("session-1");
  assert.deepEqual(terminals.listStandalone(), [standalone], "closing a session must leave standalone terminals alone");
  assert.equal(terminals.get(owned.id), undefined);
  assert.equal(terminals.close(standalone.id), true);
  assert.deepEqual(terminals.listStandalone(), []);
});
