import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAdapterGroupFile, killLeftoverAdapters, leftoverGroup, serverAlive } from "../src/lib/adapter-groups.ts";
import { parsePs } from "../src/lib/process-probe.ts";

const AT = 1_000_000_000;
const ADAPTER = "node /portal/claude-agent-acp";

/** A process table at `AT` from `[pid, ppid, pgid, elapsedSeconds, command]` rows. */
function table(rows) {
  const line = ([pid, ppid, pgid, elapsed, command]) => `${pid} ${ppid} ${pgid} ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")} 0:00.00 1024 ${command}`;
  return parsePs(rows.map(line).join("\n"), AT);
}

// The adapter started 100 s before the table was read; its server (pid 50) 200 s before.
const group = { pgid: 500, command: ADAPTER, startedAt: AT - 100_000, server: { pid: 50, startedAt: AT - 200_000 } };

test("serverAlive matches the pid and the start time, so a reused pid is not the server", () => {
  assert.equal(serverAlive(group.server, table([[50, 1, 50, 200, "node server"]])), true);
  assert.equal(serverAlive(group.server, table([[50, 1, 50, 30, "something else"]])), false, "same pid, started later");
  assert.equal(serverAlive(group.server, table([])), false, "gone");
});

test("a group whose server still runs is never a leftover, even orphaned", () => {
  const rows = [[50, 1, 50, 200, "node server"], [500, 1, 500, 100, ADAPTER]];
  assert.equal(leftoverGroup(group, table(rows)), null);
  // Its server gone, the same group is.
  assert.deepEqual(leftoverGroup(group, table(rows.slice(1))).map((row) => row.pid), [500]);
});

test("a live leader is a leftover only when it was orphaned and still runs the recorded command from the recorded start", () => {
  assert.notEqual(leftoverGroup(group, table([[500, 1, 500, 100, ADAPTER], [501, 500, 500, 90, "claude --resume x"]])), null);
  assert.equal(leftoverGroup(group, table([[500, 77, 500, 100, ADAPTER]])), null, "a parent still runs it");
  assert.equal(leftoverGroup(group, table([[500, 1, 500, 100, "vim notes"]])), null, "another command");
  assert.equal(leftoverGroup(group, table([[500, 1, 500, 20, ADAPTER]])), null, "started later");
  // Entries from before servers were recorded are judged on the rest.
  const { server: _server, ...unrecorded } = group;
  assert.notEqual(leftoverGroup(unrecorded, table([[500, 1, 500, 100, ADAPTER]])), null);
});

test("with the leader gone, members must be orphaned only when their parent is outside the group", () => {
  // A CLI orphaned by the adapter's death, with its own child below it.
  const rows = [[600, 1, 500, 90, "claude"], [601, 600, 500, 80, "bash -c make"]];
  assert.deepEqual(leftoverGroup(group, table(rows)).map((row) => row.pid), [600, 601]);
  // A member whose parent is a live process outside the group is not something the adapter left.
  assert.equal(leftoverGroup(group, table([...rows, [602, 77, 500, 80, "tool"]])), null);
  // Nor is one older than the adapter.
  assert.equal(leftoverGroup(group, table([[600, 1, 500, 500, "claude"]])), null);
});

test("the boot sweep keeps a running server's groups listed and untouched, and drops entries it cannot match", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portal-groups-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "adapters.json");
  const dead = { pid: 40, startedAt: AT - 300_000 };
  const live = { pid: 50, startedAt: AT - 200_000 };
  const deadFile = createAdapterGroupFile(file, () => {}, { server: dead });
  const liveFile = createAdapterGroupFile(file, () => {}, { server: live });
  deadFile.add({ pgid: 500, command: ADAPTER, startedAt: AT - 100_000 });
  // A second server on the same file adds its own entry without dropping the first.
  liveFile.add({ pgid: 700, command: ADAPTER, startedAt: AT - 100_000 });
  deadFile.add({ pgid: 800, command: ADAPTER, startedAt: AT - 100_000 });
  assert.deepEqual(liveFile.list().map(({ pgid, server }) => [pgid, server.pid]), [[500, 40], [700, 50], [800, 40]]);

  // 500 is gone, 700 is the running server's, 800 now names something else. (The pids are not this
  // test's, so the table offers nothing to kill: no signal is sent for real.)
  const rows = table([
    [50, 1, 50, 200, "node server"],
    [700, 50, 700, 100, ADAPTER],
    [800, 1, 800, 5, "sleep 30"],
  ]);
  const sweep = await killLeftoverAdapters(liveFile, { readProcesses: async () => rows, graceMs: 10 });
  assert.deepEqual(sweep, { killed: [], skipped: [800], kept: [700] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).groups.map(({ pgid }) => pgid), [700], "only the running server's group stays listed");
});
