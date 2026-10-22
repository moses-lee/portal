import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDiskSurveyor, liveDu } from "../src/monitoring/disk.ts";

const KiB = 1024;

function scratch(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-disk-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const folders = [
    "worktrees/repo/feature/services/api", "worktrees/repo/left-over", "blobs", "sessions", "orchestrator",
  ];
  for (const folder of folders) mkdirSync(path.join(home, folder), { recursive: true });
  for (const folder of ["cache-a", "cache-b"]) mkdirSync(path.join(root, "watched", folder), { recursive: true });
  writeFileSync(path.join(home, "server.key"), "k");
  writeFileSync(path.join(root, "watched", "loose-file"), "x".repeat(10));
  utimesSync(path.join(root, "watched", "cache-a"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  return { root, home };
}

/** A `du` that answers fixed sizes by folder name and records its calls, failing if two ever overlap. */
function fakeDu(sizes) {
  const calls = [];
  let running = 0;
  let gate = null;
  const du = async (folder, signal) => {
    running++;
    assert.equal(running, 1, "never two du at once");
    calls.push(folder);
    try {
      await delay(1);
      if (gate) await gate;
      if (signal.aborted) return null;
      const name = path.basename(folder);
      return name in sizes ? sizes[name] : 4 * KiB;
    } finally {
      running--;
    }
  };
  return { du, calls, hold(promise) { gate = promise; } };
}

function surveyor(home, du, { worktrees, watched = [], database } = {}) {
  let clock = 1_000;
  return createDiskSurveyor({
    now: () => (clock += 100),
    portalHome: home,
    worktrees: () => worktrees ?? [{ projectId: "p1", name: "feature", path: path.join(home, "worktrees/repo/feature") }],
    watchedFolders: async () => watched,
    database: database ?? (async () => ({ bytes: 50 * KiB * KiB, tables: [{ name: "session_events", bytes: 40 * KiB * KiB }] })),
    du,
  });
}

test("a survey splits the home, measures each worktree once, and lists the largest items", async (t) => {
  const { home } = scratch(t);
  const fake = fakeDu({ feature: 900 * KiB * KiB, "left-over": 300 * KiB * KiB, api: 100 * KiB * KiB, blobs: 60 * KiB * KiB, sessions: 2 * KiB, orchestrator: 3 * KiB });
  const disk = surveyor(home, fake.du, {
    worktrees: [
      { projectId: "p1", name: "feature", path: path.join(home, "worktrees/repo/feature") },
      { projectId: "p2", name: "feature api", path: path.join(home, "worktrees/repo/feature/services/api") },
    ],
  });
  assert.equal(disk.current(), null);
  const survey = await disk.start();
  assert.equal(disk.current(), survey);
  assert.equal(disk.running(), false);

  assert.equal(fake.calls.filter((folder) => folder.endsWith("/feature")).length, 1, "the worktree folder is measured once for the home and its project");
  assert.ok(!fake.calls.includes(home), "the home is never measured whole");
  assert.equal(survey.home.path, home);
  assert.equal(survey.home.worktreesBytes, 1200 * KiB * KiB);
  assert.equal(survey.home.blobsBytes, 60 * KiB * KiB);
  assert.equal(survey.home.logsBytes, 0, "a missing logs folder takes no space");
  assert.ok(survey.home.otherBytes >= 5 * KiB, "sessions, orchestrator and the key file");
  assert.deepEqual(survey.worktrees.map(({ projectId, bytes }) => [projectId, bytes]), [["p1", 900 * KiB * KiB], ["p2", 100 * KiB * KiB]]);
  assert.deepEqual(survey.strayWorktrees, [{ path: path.join(home, "worktrees/repo/left-over"), bytes: 300 * KiB * KiB }]);
  assert.deepEqual(survey.database, { bytes: 50 * KiB * KiB, tables: [{ name: "session_events", bytes: 40 * KiB * KiB }] });
  assert.deepEqual(survey.largest.map((entry) => entry.label), ["feature", "left-over (no project)", "Portal images", "Database", "Portal home, other"],
    "largest first; the subfolder project is part of its worktree");
  assert.ok(survey.finishedAt > survey.startedAt);
});

test("watched folders list their 10 largest children with sizes and times, and a missing one says so", async (t) => {
  const { home, root } = scratch(t);
  const watchedRoot = path.join(root, "watched");
  for (let i = 0; i < 12; i++) mkdirSync(path.join(watchedRoot, `extra-${i}`));
  const sizes = { "cache-a": 500 * KiB, "cache-b": 200 * KiB };
  for (let i = 0; i < 12; i++) sizes[`extra-${i}`] = (i + 1) * KiB;
  const fake = fakeDu(sizes);
  const missing = path.join(root, "nope");
  const disk = surveyor(home, fake.du, { watched: [watchedRoot, missing] });
  const survey = await disk.start();
  const [watched, gone] = survey.watched;
  assert.equal(watched.path, watchedRoot);
  assert.equal(watched.exists, true);
  assert.equal(watched.children.length, 10);
  assert.deepEqual(watched.children.slice(0, 2).map((child) => [child.name, child.bytes]), [["cache-a", 500 * KiB], ["cache-b", 200 * KiB]]);
  assert.equal(watched.children[0].modifiedAt, 1_700_000_000_000);
  assert.ok(watched.bytes > 778 * KiB, "the sum of every child, the small ones and the loose file included");
  assert.ok(!fake.calls.includes(watchedRoot), "the watched folder itself is not measured a second time");
  assert.deepEqual(gone, { path: missing, exists: false, bytes: null, children: [] });
  assert.ok(survey.largest.some((entry) => entry.label === watchedRoot));
});

test("a survey is never started twice at once, and dispose stops a running one", async (t) => {
  const { home } = scratch(t);
  const fake = fakeDu({});
  const gate = Promise.withResolvers();
  fake.hold(gate.promise);
  const disk = surveyor(home, fake.du);
  const first = disk.start();
  const second = disk.start();
  assert.equal(first, second, "the running survey is answered");
  assert.equal(disk.running(), true);
  gate.resolve();
  const survey = await first;
  assert.ok(survey);
  assert.equal(disk.running(), false);

  const again = Promise.withResolvers();
  fake.hold(again.promise);
  const third = disk.start();
  await delay(5);
  const disposed = disk.dispose();
  again.resolve();
  await disposed;
  assert.equal(await third, survey, "a stopped survey keeps the previous result");
  assert.equal(disk.current(), survey);
});

test("a database that cannot be asked leaves its part null", async (t) => {
  const { home } = scratch(t);
  const disk = surveyor(home, fakeDu({}).du, { database: async () => { throw new Error("pool closed"); } });
  const survey = await disk.start();
  assert.equal(survey.database, null);
  assert.ok(!survey.largest.some((entry) => entry.label === "Database"));
});

test("the live du measures a folder in kilobytes", { skip: process.platform === "win32" }, async (t) => {
  const { home } = scratch(t);
  writeFileSync(path.join(home, "blobs", "big"), Buffer.alloc(256 * KiB, 1));
  const bytes = await liveDu(path.join(home, "blobs"), new AbortController().signal);
  assert.ok(bytes >= 256 * KiB && bytes < 1024 * KiB, String(bytes));
  assert.equal(await liveDu(path.join(home, "missing"), new AbortController().signal), null);
});
