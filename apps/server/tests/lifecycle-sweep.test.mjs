import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { appContext, buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { DIRTY_REASON, OPEN_TERMINAL_REASON, STATUS_FAILED_REASON, createLifecycleSweeper, runLifecycleSweep } from "../src/lib/lifecycle-sweep.ts";
import { RemovalSkipped, removeProject } from "../src/projects/remove-worktree.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { fakeDeps, fakeSettings, fakeTimers, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 4, 12);
const ago = (hours) => NOW - hours * HOUR;

const worktreeProject = (id, fields = {}) => ({
  id, name: `wt-${id}`, path: `/wt/${id}`, createdAt: ago(1000), worktree: { parentId: "main", branch: `feat/${id}` },
  pinnedAt: null, keptReason: null, ...fields,
});

/**
 * Fake deps over plain arrays: `state` holds the sessions, projects, tracked rows (with `trackedAt`
 * by session id, default 0), open terminals, dirty projects, projects whose `git status` fails,
 * worktree roots by project id (default the project's path), and what the sweep did (untracked,
 * removed, removals as groups of ids, activity). `remove(projects, recheck)` replaces the removal.
 */
function fakeSweep({
  sessions = [], projects = [], tracked = [], trackedAt = {}, terminals = [], dirty = [], statusFails = [], roots = {},
  untrackAfterHours = 48, removeAfterHours = 72, remove,
} = {}) {
  const state = {
    sessions, projects, tracked: [...tracked], trackedAt, terminals: new Set(terminals), dirty: new Set(dirty), statusFails: new Set(statusFails), roots,
    settings: { untrackAfterHours, removeAfterHours }, untracked: [], removed: [], removals: [], activity: [], errors: [], keptWrites: [],
  };
  const deps = {
    now: () => NOW,
    settings: async () => state.settings,
    sessions: async () => state.sessions,
    projects: {
      list: async () => state.projects,
      async setKeptReason(id, reason) {
        state.keptWrites.push([id, reason]);
        state.projects = state.projects.map((project) => project.id === id ? { ...project, keptReason: reason } : project);
      },
    },
    tracked: {
      list: async () => state.tracked.map((sessionId) => ({ sessionId, trackedAt: state.trackedAt[sessionId] ?? 0, trackedBy: "portal" })),
      async untrack(sessionId, by, context) {
        if (!state.tracked.includes(sessionId)) return false;
        state.tracked = state.tracked.filter((id) => id !== sessionId);
        state.untracked.push({ sessionId, by, reason: context?.reason });
        state.untrackActors = [...(state.untrackActors ?? []), context?.actor];
        return true;
      },
    },
    hasOpenTerminal: (sessionId) => state.terminals.has(sessionId),
    worktreeRoot: async (project) => state.roots[project.id] ?? project.path,
    isDirty: async (project) => state.statusFails.has(project.id) ? null : state.dirty.has(project.id),
    async removeWorktreeProjects(projects, recheck) {
      state.removals.push(projects.map((project) => project.id));
      if (remove) return remove(projects, recheck);
      const ids = projects.map((project) => project.id);
      state.removed.push(...ids);
      state.projects = state.projects.filter((p) => !ids.includes(p.id));
      return { branchDeleted: false };
    },
    activity: { log: async (entry) => { state.activity.push(entry); } },
    logError: (err, message) => state.errors.push(`${message}: ${err.message}`),
  };
  return { deps, state };
}

const session = (id, projectId, idleSince) => ({ id, projectId, idleSince });

test("pass 1 untracks tracked sessions idle past the setting, never busy ones, with the reason", async () => {
  const { deps, state } = fakeSweep({
    sessions: [session("old", "p", ago(49)), session("recent", "p", ago(47)), session("busy", "p", null), session("untracked", "p", ago(100))],
    tracked: ["old", "recent", "busy", "gone"],
  });
  const result = await runLifecycleSweep(deps);
  assert.deepEqual(result, { untracked: 1, removed: 0, kept: 0 });
  assert.deepEqual(state.untracked, [{ sessionId: "old", by: "portal", reason: "idle for 48h" }]);
  assert.deepEqual(state.tracked, ["recent", "busy", "gone"]);

  // A lowered setting takes effect on the next sweep.
  state.settings.untrackAfterHours = 1;
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 1, removed: 0, kept: 0 });
  assert.deepEqual(state.untracked.at(-1), { sessionId: "recent", by: "portal", reason: "idle for 1h" });
  assert.deepEqual(state.tracked, ["busy", "gone"]);
  // The sweep's untracks are Portal's own housekeeping, logged as the system.
  assert.deepEqual(state.untrackActors, ["system", "system"]);
});

test("pass 1 counts the untrack clock from when the session was tracked, if later than its idle clock", async () => {
  const { deps, state } = fakeSweep({
    sessions: [session("old-tracked-late", "p", ago(500)), session("old-tracked-early", "p", ago(500))],
    tracked: ["old-tracked-late", "old-tracked-early"],
    trackedAt: { "old-tracked-late": ago(10), "old-tracked-early": ago(49) },
  });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 1, removed: 0, kept: 0 });
  assert.deepEqual(state.tracked, ["old-tracked-late"]);
});

test("pass 1 is skipped without the tracked service", async () => {
  const { deps } = fakeSweep({ sessions: [session("old", "p", ago(100))], tracked: ["old"] });
  assert.deepEqual(await runLifecycleSweep({ ...deps, tracked: null }), { untracked: 0, removed: 0, kept: 0 });
});

test("pass 2 skips non-worktree, pinned, not idle, open-terminal, and not yet due projects; an open terminal is the kept reason", async () => {
  const { deps, state } = fakeSweep({
    projects: [
      { ...worktreeProject("plain"), worktree: undefined },
      worktreeProject("pinned", { pinnedAt: ago(500) }),
      worktreeProject("busy"),
      worktreeProject("terminal"),
      worktreeProject("young"),
      worktreeProject("fresh", { createdAt: ago(10) }),
      worktreeProject("due"),
      worktreeProject("empty"),
    ],
    sessions: [
      session("s-plain", "plain", ago(500)),
      session("s-pinned", "pinned", ago(500)),
      session("s-busy-1", "busy", ago(500)), session("s-busy-2", "busy", null),
      session("s-term", "terminal", ago(500)),
      // The newest idle clock among the sessions is the project's clock.
      session("s-young-1", "young", ago(500)), session("s-young-2", "young", ago(71)),
      session("s-due-1", "due", ago(500)), session("s-due-2", "due", ago(73)),
    ],
    terminals: ["s-term"],
  });
  const result = await runLifecycleSweep(deps);
  // "empty" has no sessions, so its clock is its creation time, long past.
  assert.deepEqual(state.removed, ["due", "empty"]);
  assert.deepEqual(result, { untracked: 0, removed: 2, kept: 1 });
  // Only the open terminal holds "terminal", so the sidebar says so.
  assert.deepEqual(state.keptWrites, [["terminal", OPEN_TERMINAL_REASON]]);
  assert.deepEqual(state.activity.map((entry) => [entry.kind, entry.refs.projectId]), [
    ["worktree.kept", "terminal"], ["worktree.removed_idle", "due"], ["worktree.removed_idle", "empty"],
  ]);
  assert.match(state.activity[1].summary, /Removed the worktree for wt-due after 72h idle/);
  assert.deepEqual(state.errors, []);

  // The terminal closes: the project goes on the next sweep.
  state.terminals.clear();
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 1, kept: 0 });
  assert.deepEqual(state.removed, ["due", "empty", "terminal"]);
});

test("a lowered removal setting brings a project due sooner", async () => {
  const { deps, state } = fakeSweep({ projects: [worktreeProject("p")], sessions: [session("s", "p", ago(2))], removeAfterHours: 1 });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 1, kept: 0 });
  assert.deepEqual(state.removed, ["p"]);
});

test("a dirty tree keeps the project with a reason, logged once across sweeps; clean later removes it", async () => {
  const { deps, state } = fakeSweep({ projects: [worktreeProject("p")], sessions: [session("s", "p", ago(100))], dirty: ["p"] });
  for (let i = 0; i < 3; i++) assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 1 });
  assert.equal(state.projects[0].keptReason, DIRTY_REASON);
  assert.deepEqual(state.keptWrites, [["p", DIRTY_REASON]]);
  assert.deepEqual(state.activity.map((entry) => entry.kind), ["worktree.kept"]);
  assert.equal(state.activity[0].summary, "Kept the idle worktree for wt-p: uncommitted changes");
  assert.deepEqual(state.removed, []);

  state.dirty.clear();
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 1, kept: 0 });
  assert.deepEqual(state.removed, ["p"]);
  assert.deepEqual(state.activity.map((entry) => entry.kind), ["worktree.kept", "worktree.removed_idle"]);
});

test("the kept reason clears once the project is no longer due", async () => {
  const { deps, state } = fakeSweep({ projects: [worktreeProject("p", { keptReason: DIRTY_REASON })], sessions: [session("s", "p", null)] });
  await runLifecycleSweep(deps);
  assert.equal(state.projects[0].keptReason, null);
  assert.deepEqual(state.activity, []);
});

test("git refusing records its message as the kept reason and the sweep carries on", async () => {
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("raced"), worktreeProject("ok")],
    sessions: [session("a", "raced", ago(100)), session("b", "ok", ago(100))],
    remove: async ([project]) => {
      if (project.id === "raced") throw Object.assign(new Error("fatal: contains modified or untracked files, use --force to delete it"), { status: 409, dirty: true });
      state.removed.push(project.id);
      return { branchDeleted: true };
    },
  });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 1, kept: 1 });
  assert.equal(state.projects.find((p) => p.id === "raced").keptReason, "fatal: contains modified or untracked files, use --force to delete it");
  assert.deepEqual(state.removed, ["ok"]);
  assert.deepEqual(state.activity.map((entry) => [entry.kind, entry.refs.projectId]), [["worktree.kept", "raced"], ["worktree.removed_idle", "ok"]]);
  assert.match(state.activity[1].summary, /and its merged branch feat\/ok/);
});

test("the sweeper runs 60 s after start, then every 5 minutes, and never two sweeps at once", async () => {
  const timers = [];
  const fake = {
    setTimeout: (fn, ms) => { const h = { fn, ms, kind: "timeout" }; timers.push(h); return h; },
    setInterval: (fn, ms) => { const h = { fn, ms, kind: "interval" }; timers.push(h); return h; },
    clear: (h) => { h.cleared = true; },
  };
  let release;
  let removals = 0;
  const { deps } = fakeSweep({
    projects: [worktreeProject("p")], sessions: [session("s", "p", ago(100))],
    remove: async () => { removals++; await new Promise((resolve) => { release = resolve; }); return { branchDeleted: false }; },
  });
  const sweeper = createLifecycleSweeper(deps, { timers: fake });
  assert.deepEqual(timers.map((h) => [h.kind, h.ms]), [["timeout", 60_000]]);

  const first = sweeper.run();
  const second = sweeper.run();
  assert.equal(first, second);
  // The scheduled tick lands while the manual sweep runs: it joins rather than starting another.
  timers[0].fn();
  assert.deepEqual(timers.map((h) => [h.kind, h.ms]), [["timeout", 60_000], ["interval", 300_000]]);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await first, { untracked: 0, removed: 1, kept: 0 });
  assert.equal(removals, 1);

  await sweeper.dispose();
  assert.ok(timers.every((h) => h.cleared));
  await assert.rejects(sweeper.run(), /shutting down/);
});

test("a failed git status keeps the project rather than counting as clean", async () => {
  const { deps, state } = fakeSweep({ projects: [worktreeProject("p")], sessions: [session("s", "p", ago(100))], statusFails: ["p"] });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 1 });
  assert.equal(state.projects[0].keptReason, STATUS_FAILED_REASON);
  assert.deepEqual(state.removals, []);
});

test("a restore restarts the idle clock: the project's clock is the later of its sessions' and its revival", async () => {
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("restored", { revivedAt: ago(1) }), worktreeProject("long-ago", { revivedAt: ago(100) })],
    sessions: [session("a", "restored", ago(500)), session("b", "long-ago", ago(500))],
  });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 1, kept: 0 });
  assert.deepEqual(state.removed, ["long-ago"]);
});

test("projects in one worktree folder are judged together: one held keeps all, all due go together", async () => {
  const shared = { root: "/wt/x", sub: "/wt/x" };
  const projects = [
    worktreeProject("sub", { path: "/wt/x/apps/web", name: "web" }),
    worktreeProject("root", { path: "/wt/x", name: "x", pinnedAt: ago(1) }),
  ];
  const { deps, state } = fakeSweep({
    projects, roots: shared,
    sessions: [session("a", "root", ago(500)), session("b", "sub", ago(500))],
  });
  // The pinned root holds the folder; the idle subfolder project says why it stays.
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 1 });
  assert.deepEqual(state.removals, []);
  assert.deepEqual(state.keptWrites, [["sub", "shares its worktree with x, which is pinned"]]);
  assert.equal(state.projects.find((p) => p.id === "root").keptReason, null);

  // A busy root holds it too.
  state.projects = state.projects.map((p) => p.id === "root" ? { ...p, pinnedAt: null } : p);
  state.sessions = [session("a", "root", null), session("b", "sub", ago(500))];
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 1 });
  assert.equal(state.projects.find((p) => p.id === "sub").keptReason, "shares its worktree with x, which is in use");

  // Both idle: one removal for the folder, the root project first, both logged.
  state.sessions = [session("a", "root", ago(100)), session("b", "sub", ago(500))];
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 2, kept: 0 });
  assert.deepEqual(state.removals, [["root", "sub"]]);
  assert.deepEqual(state.activity.filter((e) => e.kind === "worktree.removed_idle").map((e) => e.refs.projectId), ["root", "sub"]);
});

test("a plain project inside a worktree folder holds it", async () => {
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("wt", { path: "/wt/x" }), { ...worktreeProject("plain", { path: "/wt/x/docs", name: "docs" }), worktree: undefined }],
    sessions: [session("a", "wt", ago(500))],
  });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 1 });
  assert.equal(state.projects[0].keptReason, "shares its worktree with docs, which is not a worktree project");
});

test("the sweep judges each project again on live data before removing it", async () => {
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("p")], sessions: [session("s", "p", ago(100))],
  });
  // The session starts a turn while the sweep checks git status.
  deps.isDirty = async () => {
    state.sessions = [session("s", "p", null)];
    return false;
  };
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 0 });
  assert.deepEqual(state.removals, []);

  // Pinned meanwhile.
  state.sessions = [session("s", "p", ago(100))];
  deps.isDirty = async () => {
    state.projects = state.projects.map((p) => ({ ...p, pinnedAt: NOW }));
    return false;
  };
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 0 });
  assert.deepEqual(state.removals, []);
});

test("the recheck hook cancels a removal after the pre-delete script when the project changed", async () => {
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("p")], sessions: [session("s", "p", ago(100))],
    // The script runs, a terminal opens meanwhile, and the recheck before git says no.
    remove: async (_projects, recheck) => {
      state.terminals.add("s");
      if (!(await recheck())) throw new RemovalSkipped();
      return { branchDeleted: false };
    },
  });
  assert.deepEqual(await runLifecycleSweep(deps), { untracked: 0, removed: 0, kept: 0 });
  assert.deepEqual(state.activity, []);
  assert.equal(state.projects[0].keptReason, null);
  assert.deepEqual(state.errors, []);
});

test("removeProject runs io.recheck after the pre-delete script and before git", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-recheck-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let answer = false;
  const io = {
    getProject: () => ({ id: "main", name: "main", path: root, createdAt: 1, pinnedAt: null, keptReason: null }),
    gitRoot: async () => root,
    mainWorktreeOf: async () => root,
    runScript: async () => { calls.push("script"); },
    removeWorktree: async () => { calls.push("git"); return { branchDeleted: false }; },
    hasSessions: () => false,
    removeProject: async () => { calls.push("entry"); },
    recheck: async () => { calls.push("recheck"); return answer; },
  };
  const project = worktreeProject("p", { path: root });
  await assert.rejects(removeProject(io, project, { deleteWorktree: true }), RemovalSkipped);
  assert.deepEqual(calls, ["script", "recheck"]);
  calls.length = 0;
  answer = true;
  await removeProject(io, project, { deleteWorktree: true });
  assert.deepEqual(calls, ["script", "recheck", "git", "entry"]);
});

test("a failed removal that is not a dirty tree is not retried until the clock moves; its reason is one short line", async () => {
  let attempts = 0;
  const long = `Pre-delete script failed: ${"x".repeat(300)}\nsecond line\nthird`;
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("p")], sessions: [session("s", "p", ago(100))],
    remove: async () => { attempts++; throw new Error(long); },
  });
  const failedAt = new Map();
  for (let i = 0; i < 3; i++) assert.deepEqual(await runLifecycleSweep(deps, { failedAt }), { untracked: 0, removed: 0, kept: 1 });
  assert.equal(attempts, 1);
  const reason = state.projects[0].keptReason;
  assert.equal(reason, long.split("\n")[0].slice(0, 200));
  assert.equal(reason.length, 200);
  assert.deepEqual(state.activity.map((entry) => entry.kind), ["worktree.kept"]);

  // New activity in a session moves the clock: the next due sweep tries again.
  state.sessions = [session("s", "p", ago(90))];
  await runLifecycleSweep(deps, { failedAt });
  assert.equal(attempts, 2);
  // Same failure, same reason: Activity is not told again.
  assert.deepEqual(state.activity.map((entry) => entry.kind), ["worktree.kept"]);
});

test("an aborted sweep stops before the next project, and dispose does not wait for the rest", async () => {
  let release;
  const { deps, state } = fakeSweep({
    projects: [worktreeProject("a"), worktreeProject("b")],
    sessions: [session("sa", "a", ago(100)), session("sb", "b", ago(100))],
    remove: async ([project]) => {
      await new Promise((resolve) => { release = resolve; });
      state.removed.push(project.id);
      return { branchDeleted: false };
    },
  });
  const sweeper = createLifecycleSweeper(deps, { start: false });
  const running = sweeper.run();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const disposed = sweeper.dispose();
  release();
  await disposed;
  assert.deepEqual(await running, { untracked: 0, removed: 1, kept: 0 });
  assert.deepEqual(state.removed, ["a"]);
  assert.deepEqual(state.removals, [["a"]]);

  // A signal aborted up front sweeps nothing, not even pass 1.
  const controller = new AbortController();
  controller.abort();
  const fresh = fakeSweep({ projects: [worktreeProject("c")], sessions: [session("sc", "c", ago(100))], tracked: ["sc"] });
  assert.deepEqual(await runLifecycleSweep(fresh.deps, { signal: controller.signal }), { untracked: 0, removed: 0, kept: 0 });
  assert.deepEqual(fresh.state.removals, []);
});

// --- Through the app: the route, the live deps, real git ---------------------------------------------

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...identity } }).toString().trim();

/** A bare origin and a clone of it at `main`, so `origin/main` exists for new branches. */
function repo(root) {
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  git(root, ["init", "-q", "-b", "main", seed]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(root, ["init", "-q", "--bare", origin]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  const main = path.join(root, "main");
  git(root, ["clone", "-q", origin, main]);
  return main;
}

function sessionRecord(id, projectId, idleSince) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId, createdAt: 1, lastActiveAt: 1, title: `Session ${id}`,
    upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false, idleSince, turnEndedAt: idleSince,
  };
}

test("POST /api/lifecycle/sweep untracks through the tracked service and logs to Activity; cross-origin is refused", async (t) => {
  const database = await temporaryDatabase(t);
  const store = createPgSessionStore({ db: database.db });
  const now = Date.now();
  await store.putSession(sessionRecord("s1", "p1", now - 49 * HOUR));
  await store.putSession(sessionRecord("s2", "p1", null));
  // The tracked service names sessions (and checks they exist) through the orchestrator's deps.
  const { deps } = fakeDeps({ sessions: [sessionMeta({ id: "s1", title: "Session s1" }), sessionMeta({ id: "s2", title: "Session s2" })] });
  const model = new MockLanguageModelV3({});
  const app = await buildApp({
    database, orchestrator: { settingsStore: fakeSettings(), deps, timers: fakeTimers(), model: () => model },
    lifecycle: { start: false },
  });
  t.after(() => app.close());
  const ctx = appContext(app);
  await ctx.orchestrator.ready;
  for (const id of ["s1", "s2"]) await ctx.orchestrator.hub.tracked.track(id, "user");

  const refused = await app.inject({ method: "POST", url: "/api/lifecycle/sweep", headers: { origin: "http://evil.example" } });
  assert.equal(refused.statusCode, 403);

  const swept = await app.inject({ method: "POST", url: "/api/lifecycle/sweep" });
  assert.equal(swept.statusCode, 200, swept.body);
  assert.deepEqual(swept.json(), { untracked: 1, removed: 0, kept: 0 });
  assert.deepEqual((await ctx.orchestrator.hub.tracked.list()).map((row) => row.sessionId), ["s2"]);
  const [entry] = await ctx.orchestrator.hub.activity.list({ kind: "session.untracked" });
  assert.equal(entry.summary, `Untracked "Session s1": idle for 48h`);
  assert.equal(entry.actor, "system");
  assert.deepEqual(entry.detail, { trackedBy: "portal", reason: "idle for 48h" });
});

test("the live sweep keeps a dirty worktree, then removes it clean through the shared removal path", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-lifecycle-")));
  const portalHome = path.join(root, "portal-home");
  const database = await temporaryDatabase(t);
  let now = Date.now();
  const app = await buildApp({
    config: { ...loadConfig(), portalHome }, database, orchestrator: false, lifecycle: { start: false, deps: { now: () => now } },
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (method, url, payload) => app.inject({ method, url, payload });
  const main = repo(root);
  const parent = (await call("POST", "/api/projects", { path: main })).json();
  const created = await call("POST", `/api/projects/${parent.id}/worktrees`, { branch: "feat/x", create: true });
  assert.equal(created.statusCode, 201, created.body);
  const wt = created.json().project;

  // Not due yet: created moments ago.
  assert.deepEqual((await call("POST", "/api/lifecycle/sweep")).json(), { untracked: 0, removed: 0, kept: 0 });

  now += 73 * HOUR;
  writeFileSync(path.join(wt.path, "scratch.txt"), "work in progress\n");
  assert.deepEqual((await call("POST", "/api/lifecycle/sweep")).json(), { untracked: 0, removed: 0, kept: 1 });
  const listed = (await call("GET", "/api/projects")).json().projects;
  assert.equal(listed.find((p) => p.id === wt.id).keptReason, DIRTY_REASON);
  // The parent checkout is not a worktree project and is never touched.
  assert.equal(listed.find((p) => p.id === parent.id).keptReason, null);

  rmSync(path.join(wt.path, "scratch.txt"));
  assert.deepEqual((await call("POST", "/api/lifecycle/sweep")).json(), { untracked: 0, removed: 1, kept: 0 });
  assert.equal(existsSync(wt.path), false);
  assert.deepEqual((await call("GET", "/api/projects")).json().projects.map((p) => p.id), [parent.id]);
  // The branch never moved off origin/main, so it counts as merged and goes with the folder.
  assert.equal(git(main, ["branch", "--list", "feat/x"]), "");
});

test("the live sweep keeps a shared worktree while its root project is pinned, then removes both projects together", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-lifecycle-")));
  const portalHome = path.join(root, "portal-home");
  const database = await temporaryDatabase(t);
  let now = Date.now();
  const app = await buildApp({
    config: { ...loadConfig(), portalHome }, database, orchestrator: false, lifecycle: { start: false, deps: { now: () => now } },
  });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (method, url, payload) => app.inject({ method, url, payload });
  const main = repo(root);
  mkdirSync(path.join(main, "apps", "web"), { recursive: true });
  writeFileSync(path.join(main, "apps", "web", "index.txt"), "web\n");
  git(main, ["add", "."]);
  git(main, ["commit", "-q", "-m", "web"]);
  git(main, ["push", "-q", "origin", "main"]);
  const parent = (await call("POST", "/api/projects", { path: main })).json();
  const parentWeb = (await call("POST", "/api/projects", { path: path.join(main, "apps", "web"), name: "web" })).json();
  const wtRoot = (await call("POST", `/api/projects/${parent.id}/worktrees`, { branch: "feat/x", create: true })).json().project;
  const created = await call("POST", `/api/projects/${parentWeb.id}/worktrees`, { branch: "feat/x" });
  assert.equal(created.statusCode, 201, created.body);
  const wtWeb = created.json().project;
  assert.equal(wtWeb.path, path.join(wtRoot.path, "apps", "web"));
  assert.equal((await call("PATCH", `/api/projects/${wtRoot.id}`, { pinned: true })).statusCode, 200);

  now += 73 * HOUR;
  // The idle subfolder project would take the pinned root's folder with it: both stay.
  assert.deepEqual((await call("POST", "/api/lifecycle/sweep")).json(), { untracked: 0, removed: 0, kept: 1 });
  assert.equal(existsSync(wtRoot.path), true);
  const listed = (await call("GET", "/api/projects")).json().projects;
  assert.equal(listed.find((p) => p.id === wtWeb.id).keptReason, "shares its worktree with feat/x, which is pinned");

  assert.equal((await call("PATCH", `/api/projects/${wtRoot.id}`, { pinned: false })).statusCode, 200);
  assert.deepEqual((await call("POST", "/api/lifecycle/sweep")).json(), { untracked: 0, removed: 2, kept: 0 });
  assert.equal(existsSync(wtRoot.path), false);
  assert.deepEqual((await call("GET", "/api/projects")).json().projects.map((p) => p.id).sort(), [parent.id, parentWeb.id].sort());
});
