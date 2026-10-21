import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { appContext, buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { parsePs } from "../src/lib/process-probe.ts";
import { removalAt } from "../src/lib/lifecycle-sweep.ts";
import { localDatabasePort, summarize } from "../src/monitoring/service.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const EVIL = { origin: "http://evil.example" };
const GB = 1e9;
const MB = 1024 * 1024;
const HOUR = 3_600_000;

async function until(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
  }
}

/** A probe that answers fixed numbers, as the OS probes would. */
function fakeProbe({ pressure = "normal", cwds = new Map(), container = [] } = {}) {
  return {
    platform: "darwin",
    calls: { workingFolders: [], containerPids: [] },
    async system() {
      return {
        memory: { totalBytes: 16 * GB, availableBytes: 6 * GB, usedBytes: 10 * GB },
        swap: { totalBytes: 2 * GB, usedBytes: 0.5 * GB },
        pressure: { level: pressure, raw: "1" },
      };
    },
    async processMemory() {
      return null;
    },
    async workingFolders(pids) {
      this.calls.workingFolders.push(pids);
      return new Map([...cwds].filter(([pid]) => pids.includes(pid)));
    },
    async listeningPids() {
      return [];
    },
    async containerPids(table, port, listeners) {
      this.calls.containerPids.push({ port, listeners });
      return container;
    },
  };
}

const row = (pid, ppid, pgid, mb, command) => `${pid} ${ppid} ${pgid} 01:00 0:01.00 ${Math.round(mb * 1024)} ${command}`;

/**
 * An app over a throwaway database, with a parent project and a worktree project of it on disk,
 * a fake probe and process table, and a fake stop.
 */
async function setup(t, { probe = fakeProbe(), table, agents, monitoring = {} } = {}) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-monitoring-")));
  const portalHome = path.join(scratch, "home");
  const repo = path.join(scratch, "repo");
  const worktree = path.join(portalHome, "worktrees", "repo", "feature");
  for (const folder of [repo, worktree, path.join(portalHome, "blobs")]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(worktree, "file"), "x".repeat(4096));
  const database = await temporaryDatabase(t);
  const stops = [];
  const app = await buildApp({
    config: { ...loadConfig(), portalHome },
    database,
    orchestrator: false,
    lifecycle: { start: false },
    searchBackfill: { start: false },
    ...(agents ? { sessions: { agents, initializeTimeoutMs: 2_000 } } : {}),
    monitoring: {
      probe,
      start: false,
      serverPid: table ? 500 : process.pid,
      ...(table ? { readTable: async () => parsePs(table(worktree).join("\n"), Date.now()) } : {}),
      du: async (folder) => (folder === worktree ? 7 * GB : 1024),
      terminate: (targets, options) => {
        stops.push({ targets, options });
        return { done: Promise.resolve(), hurry() {} };
      },
      ...monitoring,
    },
  });
  t.after(async () => {
    await app.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const ctx = appContext(app);
  const parent = await ctx.projects.add({ path: repo, name: "repo" });
  const project = await ctx.projects.add({ path: worktree, name: "feature", worktree: { parentId: parent.id, branch: "feature" } });
  return { app, ctx, project, worktree, scratch, stops };
}

const TABLE = (worktree) => [
  row(1, 0, 1, 18, "/sbin/launchd"),
  row(500, 1, 500, 120, "node apps/server/src/index.ts"),
  row(550, 500, 500, 10, "/bin/zsh -l"),
  row(800, 1, 800, 2600, `server --workspace_directory=${worktree}`),
  row(801, 800, 800, 30, "child of the worktree server"),
  row(820, 1, 820, 300, "node watcher"),
  row(840, 1, 840, 4000, "Google Chrome"),
];

test("GET /api/monitoring answers the sample, history, attributed processes, worktree rows, and starts a disk survey", async (t) => {
  const probe = fakeProbe({ cwds: new Map([[820, "/elsewhere"]]) });
  const { app, ctx, project, worktree } = await setup(t, { probe, table: TABLE });
  await ctx.monitoring.sampler.sample();

  const first = await app.inject({ method: "GET", url: "/api/monitoring" });
  assert.equal(first.statusCode, 200);
  const snapshot = first.json();
  assert.equal(snapshot.supported, true);
  assert.deepEqual(snapshot.levels, { warnFreeGb: 30, criticalFreeGb: 15 });
  assert.equal(snapshot.sample.memory.usedBytes, 10 * GB);
  assert.equal(snapshot.sample.volumes[0].path, ctx.config.portalHome, "Portal's home volume comes first");
  assert.ok(["normal", "warning", "critical"].includes(snapshot.diskLevel));
  assert.equal(snapshot.history.length, 1);
  assert.deepEqual(Object.keys(snapshot.history[0]).sort(), ["at", "diskFreeBytes", "memoryUsedBytes", "pressure", "swapUsedBytes"]);
  assert.ok(snapshot.processesAt > 0);

  const byPid = Object.fromEntries(snapshot.processes.map((entry) => [entry.pid, entry]));
  assert.deepEqual(byPid[800].owner, { kind: "worktree", projectId: project.id });
  assert.equal(byPid[800].orphan, true);
  assert.deepEqual([byPid[800].inheritedFrom, byPid[800].stoppable, byPid[800].stopBlockedReason], [null, true, null]);
  assert.deepEqual(byPid[801].owner, { kind: "worktree", projectId: project.id }, "inherited from the worktree's server");
  assert.deepEqual([byPid[801].inheritedFrom, byPid[801].stoppable, byPid[801].stopBlockedReason], [800, false, "inherited from pid 800; stop that process"]);
  assert.deepEqual(byPid[500].owner, { kind: "portal", role: "server" });
  assert.deepEqual(byPid[840].owner, { kind: "none" }, "the largest unattributed processes are listed too");
  assert.deepEqual(snapshot.processes.map((entry) => entry.memoryBytes), [...snapshot.processes.map((entry) => entry.memoryBytes)].sort((a, b) => b - a), "largest first");
  assert.deepEqual(probe.calls.workingFolders.at(-1).sort((a, b) => a - b), [800, 801, 820, 840], "only unclaimed processes above 20 MB");

  assert.deepEqual(snapshot.sessions, []);
  assert.equal(snapshot.worktrees.length, 1);
  const [wt] = snapshot.worktrees;
  assert.deepEqual({ ...wt, pids: [...wt.pids].sort() }, {
    projectId: project.id, name: "feature", path: worktree, branch: "feature", sizeBytes: null, sessionCount: 0,
    pids: [800, 801], memoryBytes: 2630 * MB, processCount: 2, pinned: false,
    removalAt: project.createdAt + 72 * HOUR, keptReason: null, keptSince: null,
  });
  assert.equal(snapshot.disk.survey, null);
  assert.equal(snapshot.disk.running, true, "the first read starts a survey");

  await until(() => !ctx.monitoring.disk.running(), "the survey");
  const second = (await app.inject({ method: "GET", url: "/api/monitoring" })).json();
  assert.equal(second.worktrees[0].sizeBytes, 7 * GB);
  assert.equal(second.disk.running, false, "a fresh survey is not started again");
  assert.ok(second.disk.ageMs >= 0);
  assert.ok(second.disk.survey.largest.some((entry) => entry.label === "feature" && entry.bytes === 7 * GB));
  assert.ok(second.disk.survey.database.bytes > 0, "database sizes come from the pool");
  assert.ok(second.disk.survey.database.tables.length > 0 && second.disk.survey.database.tables.length <= 5);
});

test("the worktree rows show pins and the kept-for reason with its time", async (t) => {
  const { app, ctx, project } = await setup(t, { table: TABLE });
  await ctx.projects.setKeptReason(project.id, "uncommitted changes");
  let [wt] = (await app.inject({ method: "GET", url: "/api/monitoring" })).json().worktrees;
  assert.equal(wt.keptReason, "uncommitted changes");
  assert.equal(wt.keptSince, wt.removalAt);
  await ctx.projects.setPinned(project.id, Date.now());
  [wt] = (await app.inject({ method: "GET", url: "/api/monitoring" })).json().worktrees;
  assert.equal(wt.pinned, true);
  assert.equal(wt.removalAt, null);
});

test("the process table is read at most once per 5 s, whoever asks", async (t) => {
  let reads = 0;
  const { app } = await setup(t, {
    table: (worktree) => {
      reads++;
      return TABLE(worktree);
    },
  });
  await Promise.all([app.inject({ method: "GET", url: "/api/monitoring" }), app.inject({ method: "GET", url: "/api/monitoring" })]);
  await app.inject({ method: "GET", url: "/api/monitoring" });
  assert.equal(reads, 1);
});

test("POST /api/monitoring/processes/:pid/stop stops attributed processes and refuses the rest", async (t) => {
  const { app, stops } = await setup(t, { table: TABLE });
  const stop = (pid, headers = {}) => app.inject({ method: "POST", url: `/api/monitoring/processes/${pid}/stop`, headers });
  await app.inject({ method: "GET", url: "/api/monitoring" });

  assert.equal((await stop(800, EVIL)).statusCode, 403, "origin-checked");
  assert.equal((await stop("abc")).statusCode, 400);
  assert.equal((await stop(-5)).statusCode, 400);
  const unknown = await stop(4242);
  assert.equal(unknown.statusCode, 404);
  assert.match(unknown.json().error, /not in the latest process table/);
  const chrome = await stop(840);
  assert.equal(chrome.statusCode, 403);
  assert.match(chrome.json().error, /not attributed/);
  const server = await stop(500);
  assert.equal(server.statusCode, 403);
  assert.match(server.json().error, /process 500: part of the Portal server/);
  // A terminal's shell in the server's own group, and a process that only inherited its worktree.
  assert.match((await stop(550)).json().error, /part of the Portal server/);
  const inherited = await stop(801);
  assert.equal(inherited.statusCode, 403);
  assert.match(inherited.json().error, /inherited from pid 800; stop that process/);
  assert.deepEqual(stops, [], "no refusal sent a signal");

  const leader = await stop(800);
  assert.equal(leader.statusCode, 200);
  assert.deepEqual(leader.json(), { pid: 800, target: "group" });
  assert.deepEqual(stops.at(-1), { targets: [{ pgid: 800 }], options: { graceMs: 5_000 } });
});

test("the stop decides on a table at most 5 s old, and signals only the process it decided on", async (t) => {
  let clock = Date.now();
  let reads = 0;
  // What `ps` shows, changed by the test between reads: per pid, a replacement row or null (gone).
  const changes = new Map();
  const { app, stops, project } = await setup(t, {
    table: (worktree) => {
      reads++;
      return TABLE(worktree).flatMap((line) => {
        const pid = Number(line.split(" ")[0]);
        if (!changes.has(pid)) return [line];
        return changes.get(pid) === null ? [] : [changes.get(pid)];
      });
    },
    monitoring: { now: () => clock },
  });
  const stop = (pid) => app.inject({ method: "POST", url: `/api/monitoring/processes/${pid}/stop` });
  await app.inject({ method: "GET", url: "/api/monitoring" });
  assert.equal(reads, 1);
  const server800 = (worktree) => TABLE(worktree).find((line) => line.startsWith("800 "));

  // Each case decides on the table the view showed (read anew after a refusal), then `ps` shows a change.
  const cases = [
    ["gone", () => null, 404, /no longer running/],
    ["its pid now another command's", () => row(800, 1, 800, 2600, "something else entirely"), 409, /changed since/],
    ["the same command started since", (worktree) => server800(worktree).replace(" 01:00 ", " 00:02 "), 409, /changed since/],
    ["no longer its group's leader", (worktree) => server800(worktree).replace("800 1 800 ", "800 1 1 "), 409, /changed since/],
  ];
  for (const [what, changed, status, message] of cases) {
    changes.clear();
    await app.inject({ method: "GET", url: "/api/monitoring" });
    changes.set(800, changed(project.path));
    const response = await stop(800);
    assert.equal(response.statusCode, status, what);
    assert.match(response.json().error, message, what);
  }
  assert.deepEqual(stops, [], "nothing was signalled");

  // A table older than 5 s is read again first: there 800 is attributed to nothing, so it is refused.
  changes.clear();
  clock += 6_000;
  const before = reads;
  changes.set(800, row(800, 1, 800, 2600, "server --workspace_directory=/not/a/worktree"));
  const stale = await stop(800);
  assert.equal(stale.statusCode, 403);
  assert.match(stale.json().error, /not attributed/);
  assert.equal(reads, before + 1, "one fresh read; the refusal needs no second");
  assert.deepEqual(stops, []);

  // Unchanged: decided, checked again, signalled.
  changes.clear();
  clock += 6_000;
  const ok = await stop(800);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(stops.at(-1).targets, [{ pgid: 800 }]);
});

test("the database's container is looked up even when no listener was seen on its port", async (t) => {
  const probe = fakeProbe({ container: [820] });
  const { app, ctx } = await setup(t, { probe, table: TABLE });
  const byPid = Object.fromEntries((await app.inject({ method: "GET", url: "/api/monitoring" })).json().processes.map((entry) => [entry.pid, entry]));
  assert.deepEqual(probe.calls.containerPids, [{ port: localDatabasePort(ctx.config.databaseUrl), listeners: [] }]);
  assert.deepEqual(byPid[820].owner, { kind: "portal", role: "database" });
  assert.deepEqual([byPid[820].stoppable, byPid[820].stopBlockedReason], [false, "Portal's database"]);
});

test("POST /api/monitoring/disk/refresh starts a survey and is origin-checked", async (t) => {
  const { app, ctx } = await setup(t, { table: TABLE });
  assert.equal((await app.inject({ method: "POST", url: "/api/monitoring/disk/refresh", headers: EVIL })).statusCode, 403);
  assert.equal(ctx.monitoring.disk.running(), false);
  const response = await app.inject({ method: "POST", url: "/api/monitoring/disk/refresh" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().disk.running, true);
  await until(() => ctx.monitoring.disk.current() !== null, "the survey");
});

test("every sample is published as the stream's summary", async (t) => {
  const { app, ctx } = await setup(t, { probe: fakeProbe({ pressure: "warning" }), table: TABLE });
  assert.equal(ctx.monitoring.summary(), null);
  const summaries = [];
  ctx.monitoring.subscribe((summary) => summaries.push(summary));
  await app.inject({ method: "PATCH", url: "/api/settings", payload: { monitoring: { disk: { warnFreeGb: 10_000, criticalFreeGb: 9_999 } } } });
  await ctx.monitoring.sampler.sample();
  await until(() => summaries.length === 1, "the summary");
  const [summary] = summaries;
  assert.equal(summary.pressure, "warning");
  assert.deepEqual(summary.memory, { usedBytes: 10 * GB, totalBytes: 16 * GB });
  assert.deepEqual(summary.swap, { usedBytes: 0.5 * GB, totalBytes: 2 * GB });
  assert.equal(summary.disk.path, ctx.config.portalHome);
  assert.equal(summary.disk.level, "critical", "the configured levels apply");
  assert.deepEqual(summary.largest, []);
  assert.equal(summary.surveyedAt, null);
  assert.deepEqual(ctx.monitoring.summary(), summary);
});

test("an OS without a probe answers supported: false", async (t) => {
  const { app, ctx } = await setup(t, { probe: null });
  const snapshot = (await app.inject({ method: "GET", url: "/api/monitoring" })).json();
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.sample, null);
  assert.deepEqual(snapshot.processes, []);
  assert.equal(ctx.monitoring.sampler, null);
  assert.equal(ctx.monitoring.summary(), null);
});

test("a session with a live agent gets a row with its idle stop time", async (t) => {
  const logPath = path.join(os.tmpdir(), `portal-monitoring-agent-${process.pid}.jsonl`);
  const configPath = `${logPath}.json`;
  writeFileSync(logPath, "");
  writeFileSync(configPath, "{}");
  t.after(() => {
    rmSync(logPath, { force: true });
    rmSync(configPath, { force: true });
  });
  const agents = [{ id: "claude", name: "Claude Code", command: process.execPath, args: [fixturePath, "claude", logPath, configPath], authHint: "" }];
  const { app, ctx, project } = await setup(t, { agents });
  const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { projectId: project.id } });
  assert.equal(created.statusCode, 200, created.body);
  const { id } = created.json();
  await until(() => ctx.sessions.getSession(id)?.link.status === "live", "the agent to attach");

  await app.inject({ method: "PATCH", url: "/api/settings", payload: { sessions: { idleStop: { afterMinutes: 30 } } } });
  const snapshot = (await app.inject({ method: "GET", url: "/api/monitoring" })).json();
  assert.equal(snapshot.sessions.length, 1);
  const [session] = snapshot.sessions;
  const live = ctx.sessions.getSession(id);
  assert.equal(session.sessionId, id);
  assert.equal(session.projectName, "feature");
  assert.equal(session.state, "finished");
  assert.equal(session.attachedAt, live.attachedAt);
  assert.equal(session.idleSince, live.idleSince);
  assert.equal(session.idleStopAt, Math.max(live.idleSince, live.attachedAt) + 30 * 60_000);
  assert.equal(snapshot.worktrees[0].sessionCount, 1);
  const adapter = snapshot.processes.find((entry) => entry.pid === live.process.proc.pid);
  assert.deepEqual(adapter?.owner, { kind: "portal", role: "adapter" }, "the adapter is Portal's");

  await app.inject({ method: "PATCH", url: "/api/settings", payload: { sessions: { idleStop: { enabled: false } } } });
  assert.equal((await app.inject({ method: "GET", url: "/api/monitoring" })).json().sessions[0].idleStopAt, null, "off means never");
});

test("helpers: the database port, the removal clock, the summary of a sample", () => {
  assert.equal(localDatabasePort("postgres://u:p@127.0.0.1:5433/portal"), 5433);
  assert.equal(localDatabasePort("postgres://u:p@localhost/portal"), 5432);
  assert.equal(localDatabasePort("postgres://u:p@db.example.com:5432/portal"), null, "a remote database has no local processes");
  assert.equal(localDatabasePort("not a url"), null);

  const project = { createdAt: 1_000, pinnedAt: null, revivedAt: null };
  assert.equal(removalAt(project, [], 72), 1_000 + 72 * HOUR, "no sessions: from creation");
  assert.equal(removalAt(project, [{ idleSince: 5_000 }, { idleSince: 9_000 }], 1), 9_000 + HOUR, "the newest idle session");
  assert.equal(removalAt(project, [{ idleSince: 5_000 }, { idleSince: null }], 1), null, "a session in use stops the clock");
  assert.equal(removalAt({ ...project, revivedAt: 20_000 }, [{ idleSince: 5_000 }], 1), 20_000 + HOUR, "a restore restarts it");
  assert.equal(removalAt({ ...project, pinnedAt: 1 }, [], 1), null);

  const sample = {
    at: 1, memory: { totalBytes: 16, availableBytes: 6, usedBytes: 10 }, swap: { totalBytes: 2, usedBytes: 1 }, pressure: { level: "critical", raw: "4" },
    volumes: [{ path: "/home", totalBytes: 500 * GB, freeBytes: 20 * GB }, { path: "/other", totalBytes: 1, freeBytes: 0 }],
  };
  const largest = [{ label: "a", path: "/a", bytes: 3 }];
  assert.deepEqual(summarize(sample, { warnFreeGb: 30, criticalFreeGb: 15 }, { largest, finishedAt: 7 }), {
    at: 1, pressure: "critical", memory: { usedBytes: 10, totalBytes: 16 }, swap: { usedBytes: 1, totalBytes: 2 },
    disk: { path: "/home", freeBytes: 20 * GB, totalBytes: 500 * GB, level: "warning" }, largest, surveyedAt: 7,
  });
  assert.equal(summarize({ ...sample, volumes: [] }, { warnFreeGb: 30, criticalFreeGb: 15 }, null).disk, null);
});
