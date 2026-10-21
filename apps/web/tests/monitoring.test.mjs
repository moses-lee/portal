import assert from "node:assert/strict";
import test from "node:test";
import {
  agentsTotal,
  canStop,
  chartModels,
  commandName,
  formatBytes,
  levelTones,
  linePath,
  measuredText,
  otherRows,
  portalRows,
  pressureBands,
  processTree,
  sessionRows,
  summaryTiles,
  worktreeLifecycle,
  worktreeRows,
} from "../src/lib/monitoring.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const now = 1_800_000_000_000;

const proc = (pid, owner, memoryBytes, extra = {}) => ({
  pid,
  ppid: 1,
  pgid: pid,
  elapsedSeconds: 60,
  cpuSeconds: 1,
  memoryBytes,
  command: `/usr/bin/p${pid}`,
  cwd: null,
  owner,
  orphan: false,
  ...extra,
});

const session = (id, extra = {}) => ({
  sessionId: id,
  title: `Session ${id}`,
  projectId: "p1",
  projectName: "portal",
  agentId: "claude",
  agentName: "Claude",
  busy: false,
  awaitingPermission: false,
  state: "finished",
  rootPid: 100,
  pids: [100],
  memoryBytes: 350 * MiB,
  processCount: 1,
  idleSince: now - 30 * MIN,
  attachedAt: now - 40 * MIN,
  idleStopAt: now + 90 * MIN,
  ...extra,
});

const worktree = (extra = {}) => ({
  projectId: "w1",
  name: "feature",
  path: "/home/.portal/worktrees/portal/feature",
  branch: "feature",
  sizeBytes: 12e9,
  sessionCount: 1,
  pids: [],
  memoryBytes: 0,
  processCount: 0,
  pinned: false,
  removalAt: null,
  keptReason: null,
  keptSince: null,
  ...extra,
});

function snapshot(extra = {}) {
  return {
    supported: true,
    now,
    levels: { warnFreeGb: 30, criticalFreeGb: 15 },
    sample: {
      at: now,
      memory: { totalBytes: 16 * GiB, availableBytes: 4 * GiB, usedBytes: 12 * GiB },
      swap: { totalBytes: 4 * GiB, usedBytes: 1 * GiB },
      pressure: { level: "warning", raw: "2" },
      volumes: [{ path: "/Users/me/.portal", totalBytes: 460e9, freeBytes: 22e9 }],
    },
    diskLevel: "warning",
    history: [],
    processesAt: now,
    processes: [],
    sessions: [],
    worktrees: [],
    disk: { survey: null, ageMs: null, running: false },
    ...extra,
  };
}

test("bytes read in binary units for memory and decimal ones for disk", () => {
  assert.equal(formatBytes(16 * GiB, "memory"), "16 GB");
  assert.equal(formatBytes(350 * MiB, "memory"), "350 MB");
  assert.equal(formatBytes(9.84 * GiB, "memory"), "9.8 GB");
  assert.equal(formatBytes(22e9), "22 GB");
  assert.equal(formatBytes(1.5e12), "1.5 TB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(null), "—");
});

test("levels colour neutral, amber and red", () => {
  assert.deepEqual(levelTones, { normal: "neutral", warning: "amber", critical: "rose" });
});

test("the summary tiles follow pressure, the disk level, and leave agents neutral", () => {
  const tiles = summaryTiles(snapshot({
    sessions: [session("s1"), session("s2", { memoryBytes: 150 * MiB })],
    processes: [proc(9, { kind: "portal", role: "adapter" }, 500 * MiB), proc(10, { kind: "portal", role: "server" }, 200 * MiB)],
  }));
  assert.deepEqual(tiles.map((tile) => [tile.key, tile.level]), [["memory", "warning"], ["swap", "warning"], ["disk", "warning"], ["agents", "normal"]]);
  assert.equal(tiles[0].value, "12 GB of 16 GB");
  assert.equal(tiles[0].detail, "Pressure warning");
  assert.equal(tiles[1].value, "1 GB of 4 GB");
  assert.equal(tiles[1].detail, "25 % used");
  assert.equal(tiles[2].value, "22 GB free");
  assert.equal(tiles[2].detail, "of 460 GB on /Users/me/.portal");
  // Two sessions (350 + 150 MB) plus the adapter (500 MB); the server is Portal's, not an agent's.
  assert.equal(tiles[3].value, "2 live CLIs");
  assert.equal(tiles[3].detail, "1000 MB combined");
  assert.equal(summaryTiles(snapshot({ sample: null })), null);
});

test("a critical disk turns its tile red while memory stays normal", () => {
  const base = snapshot();
  const tiles = summaryTiles({ ...base, sample: { ...base.sample, pressure: { level: "normal", raw: "1" }, swap: { totalBytes: 0, usedBytes: 0 } }, diskLevel: "critical" });
  assert.equal(tiles.find((t) => t.key === "disk").level, "critical");
  assert.equal(tiles.find((t) => t.key === "memory").level, "normal");
  assert.equal(tiles.find((t) => t.key === "swap").detail, "No swap in use");
});

test("agents count adapters once, not per session", () => {
  assert.deepEqual(agentsTotal({ sessions: [], processes: [proc(9, { kind: "portal", role: "adapter" }, 10)] }), { count: 0, memoryBytes: 10 });
});

test("Stop follows the server's stoppable flag, else the same rule; a hint says why not", async () => {
  const { stopHint } = await import("../src/lib/monitoring.ts");
  assert.equal(canStop(proc(1, { kind: "none" }, 1)), false);
  assert.equal(canStop(proc(1, { kind: "session", sessionId: "s1" }, 1)), true);
  assert.equal(canStop(proc(1, { kind: "worktree", projectId: "w1" }, 1)), true);
  assert.equal(canStop(proc(1, { kind: "portal", role: "adapter" }, 1)), true);
  for (const role of ["server", "web", "database"]) assert.equal(canStop(proc(1, { kind: "portal", role }, 1)), false, role);
  assert.equal(canStop(proc(1, { kind: "worktree", projectId: "w1" }, 1, { stoppable: false, stopBlockedReason: "Inherited from pid 7." })), false);
  assert.equal(canStop(proc(1, { kind: "portal", role: "database" }, 1, { stoppable: true })), true);
  assert.equal(stopHint(proc(1, { kind: "worktree", projectId: "w1" }, 1, { stoppable: false, stopBlockedReason: "Inherited from pid 7." })), "Inherited from pid 7.");
  assert.equal(stopHint(proc(1, { kind: "portal", role: "server" }, 1)), "Part of Portal itself; restart Portal instead.");
  assert.equal(stopHint(proc(1, { kind: "session", sessionId: "s1" }, 1)), null);
});

test("a session's pids become an indented tree; missing pids are skipped", () => {
  const owner = { kind: "session", sessionId: "s1" };
  const processes = [proc(100, owner, 1), proc(101, owner, 1, { ppid: 100 }), proc(102, owner, 1, { ppid: 101 }), proc(103, owner, 1, { ppid: 100 })];
  assert.deepEqual(processTree(processes, [100, 101, 102, 103, 999]).map((row) => [row.process.pid, row.depth]), [[100, 0], [101, 1], [102, 2], [103, 1]]);
});

test("commands shorten to the program and its arguments", () => {
  assert.equal(commandName("/opt/homebrew/bin/node /x/server.js --port 3000"), "node /x/server.js --port 3000");
  assert.equal(commandName("claude"), "claude");
});

test("session rows say how long they have idled and when the stop fires", () => {
  const rows = sessionRows({
    sessions: [
      session("idle"),
      session("busy", { idleSince: null, idleStopAt: null, memoryBytes: 900 * MiB }),
      session("off", { idleStopAt: null }),
      session("due", { idleStopAt: now - MIN }),
    ],
  }, now);
  assert.deepEqual(rows.map((row) => row.sessionId), ["busy", "idle", "off", "due"]);
  assert.deepEqual(rows.map((row) => [row.idleText, row.stopText]), [["active", "—"], ["idle 30m", "in 1h 30m"], ["idle 30m", "off"], ["idle 30m", "soon"]]);
});

test("worktree lifecycle reads pinned, removal, kept, and highlights a week kept", () => {
  assert.deepEqual(worktreeLifecycle(worktree({ pinned: true, removalAt: now + HOUR }), now), { lifecycle: "pinned", stale: false });
  assert.deepEqual(worktreeLifecycle(worktree({ removalAt: now + 31 * HOUR }), now), { lifecycle: "removal in 1d 7h", stale: false });
  assert.deepEqual(worktreeLifecycle(worktree({ removalAt: now - MIN }), now), { lifecycle: "removal soon", stale: false });
  assert.deepEqual(worktreeLifecycle(worktree({ keptReason: "uncommitted changes", keptSince: now - 9 * DAY }), now), { lifecycle: "kept: uncommitted changes for 9 days", stale: true });
  assert.deepEqual(worktreeLifecycle(worktree({ keptReason: "uncommitted changes", keptSince: now - 3 * DAY }), now), { lifecycle: "kept: uncommitted changes for 3 days", stale: false });
  assert.deepEqual(worktreeLifecycle(worktree({ keptReason: "uncommitted changes" }), now), { lifecycle: "kept: uncommitted changes", stale: false });
  assert.deepEqual(worktreeLifecycle(worktree(), now), { lifecycle: "in use", stale: false });
});

test("a worktree is busy while one of its live sessions is not idle", () => {
  const rows = worktreeRows({ worktrees: [worktree(), worktree({ projectId: "w2" })], sessions: [session("s1", { projectId: "w1", idleSince: null }), session("s2", { projectId: "w2" })] }, now);
  assert.deepEqual(rows.map((row) => [row.projectId, row.busy]), [["w1", true], ["w2", false]]);
});

test("Portal rows come in role order; other rows are the largest unattributed, at most 15", () => {
  const processes = [
    proc(1, { kind: "portal", role: "database" }, 5),
    proc(2, { kind: "portal", role: "server" }, 1),
    proc(3, { kind: "portal", role: "adapter" }, 2),
    proc(4, { kind: "portal", role: "adapter" }, 9),
    proc(5, { kind: "portal", role: "web" }, 3),
    ...Array.from({ length: 20 }, (_, i) => proc(100 + i, { kind: "none" }, i)),
  ];
  assert.deepEqual(portalRows(processes).map((row) => [row.role, row.pid]), [["server", 2], ["web", 5], ["adapter", 4], ["adapter", 3], ["database", 1]]);
  const others = otherRows(processes);
  assert.equal(others.length, 15);
  assert.equal(others[0].pid, 119);
});

test("measured text tracks the survey's age", () => {
  assert.equal(measuredText({ survey: null, ageMs: null, running: true }, now), "measuring…");
  assert.equal(measuredText({ survey: null, ageMs: null, running: false }, now), "not measured yet");
  assert.equal(measuredText({ survey: {}, ageMs: 4 * MIN, running: false }, now), "measured 4 min ago");
  assert.equal(measuredText({ survey: {}, ageMs: 4 * MIN, running: true }, now), "measuring again · last measured 4 min ago");
});

test("pressure bands merge consecutive samples at the same level", () => {
  const points = ["normal", "warning", "warning", "critical", "normal", "warning"].map((pressure, i) => ({ at: i * MIN, memoryUsedBytes: 0, swapUsedBytes: 0, diskFreeBytes: 0, pressure }));
  assert.deepEqual(pressureBands(points), [
    { from: MIN, to: 3 * MIN, level: "warning" },
    { from: 3 * MIN, to: 4 * MIN, level: "critical" },
    { from: 5 * MIN, to: 6 * MIN, level: "warning" },
  ]);
});

test("charts scale to the totals and draw the disk levels as bands", () => {
  const history = [0, 1, 2].map((i) => ({ at: now - (2 - i) * MIN, memoryUsedBytes: 10 * GiB, swapUsedBytes: GiB, diskFreeBytes: i === 1 ? null : 25e9, pressure: "normal" }));
  const [memory, swap, disk] = chartModels({ ...snapshot(), history });
  assert.equal(memory.yMax, 16 * GiB);
  assert.equal(swap.yMax, 4 * GiB);
  // Free disk scales to its readings and the warning level, not the whole volume.
  assert.equal(disk.yMax, 30e9 * 1.25);
  assert.deepEqual(disk.valueBands, [{ min: 0, max: 15e9, level: "critical" }, { min: 15e9, max: 30e9, level: "warning" }]);
  assert.deepEqual(disk.points.map((p) => p.value), [25e9, null, 25e9]);
});

test("line paths map time across and value up, breaking at a missing reading", () => {
  const frame = { from: 0, to: 100, yMax: 10, width: 200, height: 50 };
  assert.equal(linePath([{ at: 0, value: 0 }, { at: 50, value: 10 }, { at: 75, value: null }, { at: 100, value: 5 }], frame), "M0,50L100,0M200,25");
  assert.equal(linePath([], frame), "");
});

test("the cleanup script's outcome reads in one line", async () => {
  const { cleanupSummary } = await import("../src/lib/monitoring.ts");
  const base = { ran: true, ok: true, code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 3_600 };
  assert.equal(cleanupSummary(base), "Finished in 4 s");
  assert.equal(cleanupSummary({ ...base, ok: false, code: 2, durationMs: 200 }), "Exited with code 2 after 1 s");
  assert.equal(cleanupSummary({ ...base, ok: false, code: null, timedOut: true, durationMs: 300_000 }), "Timed out after 300 s");
});

test("watched folders the survey found missing are named as configured", async () => {
  const { missingWatchedFolders } = await import("../src/lib/monitoring.ts");
  const survey = { watched: [
    { path: "/Users/me/.codex", exists: true, bytes: 1, children: [] },
    { path: "/Users/me/gone", exists: false, bytes: null, children: [] },
    { path: "/tmp/old", exists: false, bytes: null, children: [] },
  ] };
  assert.deepEqual(missingWatchedFolders(["~/.codex", "~/gone", "/tmp/old", "/tmp/new"], survey), ["~/gone", "/tmp/old"]);
  assert.deepEqual(missingWatchedFolders(["~/gone"], null), []);
});
