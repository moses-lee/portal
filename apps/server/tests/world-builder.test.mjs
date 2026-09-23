import assert from "node:assert/strict";
import test from "node:test";
import { buildWorld, createWorldCache, groupRepos, projectForPath, repoFromOrigin } from "../src/orchestrator/world/builder.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { T0, attentionPull, fakeDeps, fakeTimers, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const origins = {
  "/code/mono": "git@github.com:acme/monorepo.git",
  "/wt/mono-feat": "git@github.com:acme/monorepo.git",
  "/code/portal": "https://github.com/moses/portal",
};

const projects = () => [
  project({ id: "p1", name: "mono", path: "/code/mono" }),
  project({ id: "w1", name: "mono-feat", path: "/wt/mono-feat", worktree: { parentId: "p1", branch: "feat" } }),
  project({ id: "p2", name: "portal", path: "/code/portal" }),
  project({ id: "p3", name: "notes", path: "/code/notes" }),
  project({ id: "p4", name: "old", path: "/gone/old" }),
];

function setup({ intents = [], jobs, ...overrides } = {}) {
  const calls = { listBranches: [] };
  const { deps, state } = fakeDeps({
    projects: projects(),
    sessions: [
      sessionMeta({ id: "s1", projectId: "p1", awaitingPermission: true, title: "Review 2367", lastActiveAt: T0 - 1000 }),
      sessionMeta({ id: "s2", projectId: "p2", title: "Portal work", lastActiveAt: T0 - 5000 }),
    ],
    pulls: [
      attentionPull({ repo: "acme/monorepo", number: 2367, headBranch: "feat", roles: ["reviewer"], title: "Big change" }),
      attentionPull({ repo: "moses/portal", number: 12, checks: "failing" }),
    ],
    terminals: [
      { id: "t1", cwd: "/wt/mono-feat/src", title: "zsh", sessionId: null },
      { id: "t2", cwd: "/tmp", title: "zsh", sessionId: "s2" },
      { id: "t3", cwd: "/elsewhere", title: "bash (exited)", sessionId: null },
    ],
    originUrl: async (dir) => origins[dir] ?? null,
    repoRootOf: async (dir) => (dir === "/wt/mono-feat" ? "/code/mono" : dir),
    listBranches: async (root) => {
      calls.listBranches.push(root);
      return { defaultBranch: root === "/code/portal" ? "trunk" : "main", branches: [] };
    },
    worktreeState: async ({ path }) => ({ exists: true, merged: false, dirty: path === "/wt/mono-feat" }),
    ...overrides,
  });
  const summarize = deps.projects.summarize;
  deps.projects.summarize = async (entry) => ({ ...(await summarize(entry)), exists: entry.path !== "/gone/old" });
  const store = createMemoryOrchestratorStore();
  const timers = fakeTimers();
  const hub = { deps, store, timers, jobs: { listIntents: async () => intents, ...(jobs ? { listJobs: async () => jobs } : {}) } };
  return { hub, deps, state, store, timers, calls };
}

test("a full build maps projects to repos (worktrees under their repo, main checkout first), sessions, terminals, and PRs to their checkouts", async () => {
  const { hub, store, state } = setup({
    intents: [{ id: "i1", text: "Monitor #12 until merged", status: "active", lastCheckedAt: null }],
    jobs: [
      { id: "j2", kind: "helper", title: "Later", status: "active", nextRunAt: T0 + 60_000 },
      { id: "j1", kind: "tick", title: "Tick", status: "active", nextRunAt: T0 + 1000 },
      { id: "j3", kind: "helper", title: "Paused", status: "paused", nextRunAt: null },
    ],
  });
  const open = await store.createItem({ kind: "custom", title: "Open one", body: "", links: {}, actions: [], fingerprint: "a" });
  const done = await store.createItem({ kind: "custom", title: "Done", body: "", links: {}, actions: [], fingerprint: "b" });
  await store.updateItem(done.id, { status: "resolved" });

  const world = await buildWorld({ hub, previous: null, mode: "full" });
  assert.deepEqual(world.errors, []);
  assert.equal(world.at, T0);
  assert.equal(world.login, "moses-lee");
  assert.deepEqual(world.repos, [
    { repo: "acme/monorepo", defaultBranch: "main", projectIds: ["p1", "w1"] },
    { repo: "moses/portal", defaultBranch: "trunk", projectIds: ["p2"] },
  ]);
  const byId = Object.fromEntries(world.projects.map((p) => [p.id, p]));
  assert.deepEqual(byId.w1, {
    id: "w1", name: "mono-feat", path: "/wt/mono-feat", repo: "acme/monorepo", defaultBranch: "main",
    worktree: { parentId: "p1", branch: "feat", dirty: true, merged: false }, missing: false, branch: "main",
  });
  assert.equal(byId.p3.repo, null, "a folder without an origin has no repo");
  assert.equal(byId.p4.missing, true);
  assert.equal(byId.p4.branch, null);
  assert.deepEqual(world.sessions.map((s) => [s.id, s.activity]), [["s1", "waiting"], ["s2", "idle"]]);
  assert.deepEqual(world.terminals.map((t) => [t.id, t.projectId]), [["t1", "w1"], ["t2", "p2"], ["t3", null]]);
  const pull = world.pulls.find((p) => p.number === 2367);
  assert.equal(pull.localProjectId, "p1");
  assert.equal(pull.worktreeProjectId, "w1");
  assert.equal(world.pulls.find((p) => p.number === 12).localProjectId, "p2");
  assert.deepEqual(world.intents, [{ id: "i1", text: "Monitor #12 until merged", status: "active", lastCheckedAt: null }]);
  assert.deepEqual(world.jobs.map((j) => j.id), ["j1", "j2"], "active jobs, soonest first");
  assert.deepEqual(world.items, [{ id: open.id, kind: "custom", title: "Open one", status: "open" }]);
  // The digest's slice rides along, from the same reads.
  assert.deepEqual(Object.keys(world.snapshot.pulls).sort(), ["acme/monorepo#2367", "moses/portal#12"]);
  assert.deepEqual(world.snapshot.missingProjects, ["p4"]);
  assert.equal(world.snapshot.worktrees.w1.dirty, true);
  assert.equal(state.searches.length, 1);
});

test("a failing source keeps its previous slice and says so; the rest is rebuilt", async () => {
  const { hub, deps, state } = setup();
  const first = await buildWorld({ hub, previous: null, mode: "full" });
  deps.github.searchAttentionPulls = async () => ({ pulls: [], error: "gh is not logged in" });
  deps.sessions.list = async () => { throw new Error("runtime down"); };
  deps.terminals.list = async () => { throw new Error("pty gone"); };
  deps.github.login = async () => { throw new Error("offline"); };
  state.projects = state.projects.filter((p) => p.id !== "p3");
  hub.timers.tick(10_000);
  const second = await buildWorld({ hub, previous: first, mode: "full" });
  assert.deepEqual(second.pulls, first.pulls, "the PRs from before");
  assert.deepEqual(second.sessions, first.sessions);
  assert.deepEqual(second.terminals, first.terminals);
  assert.equal(second.login, "moses-lee");
  assert.ok(!second.projects.some((p) => p.id === "p3"), "projects were read afresh");
  assert.ok(second.errors.some((line) => /GitHub search failed \(gh is not logged in\)/.test(line)), second.errors.join("\n"));
  assert.ok(second.errors.some((line) => /Sessions could not be listed/.test(line)));
  assert.ok(second.errors.some((line) => /Terminals could not be read \(pty gone\)/.test(line)));
  assert.ok(second.errors.some((line) => /GitHub login could not be read/.test(line)));
  assert.equal(second.errors.filter((line) => /Sessions/.test(line)).length, 1, "one line per failure");
});

test("when projects cannot be listed the previous projects, repos, and PR links are kept", async () => {
  const { hub, deps } = setup();
  const first = await buildWorld({ hub, previous: null, mode: "full" });
  deps.projects.list = async () => { throw new Error("db down"); };
  const second = await buildWorld({ hub, previous: first, mode: "full" });
  assert.deepEqual(second.projects, first.projects);
  assert.deepEqual(second.repos, first.repos);
  assert.equal(second.pulls.find((p) => p.number === 2367).worktreeProjectId, "w1");
  assert.ok(second.errors.some((line) => /Projects could not be listed/.test(line)));
});

test("a local build asks neither GitHub nor git for worktree state, reuses the PRs, and refreshes sessions", async () => {
  const { hub, state } = setup();
  let worktreeReads = 0;
  const full = await buildWorld({ hub, previous: null, mode: "full" });
  hub.deps.git.worktreeState = async () => { worktreeReads++; return { exists: true, merged: true, dirty: false }; };
  state.sessions.push(sessionMeta({ id: "s3", projectId: "p3", title: "New one", lastActiveAt: T0 + 1 }));
  hub.timers.tick(120_000);
  const local = await buildWorld({ hub, previous: full, mode: "local" });
  assert.equal(state.searches.length, 1, "no second search");
  assert.equal(worktreeReads, 0);
  assert.equal(local.at, T0 + 120_000);
  assert.deepEqual(local.pulls, full.pulls);
  assert.deepEqual(local.snapshot, full.snapshot, "the digest's slice waits for a full build");
  assert.equal(local.sessions[0].id, "s3");
  assert.equal(local.projects.find((p) => p.id === "w1").worktree.dirty, true, "worktree state from the last full build");
  assert.equal(local.login, "moses-lee");
});

test("default branches are read once per repository and cached across builds", async () => {
  const { hub, calls } = setup();
  const cache = createWorldCache();
  const first = await buildWorld({ hub, previous: null, mode: "full", cache });
  await buildWorld({ hub, previous: first, mode: "full", cache });
  assert.deepEqual([...calls.listBranches].sort(), ["/code/mono", "/code/portal"]);
});

test("a missing folder keeps the repo it had, so it still maps", async () => {
  const { hub, deps } = setup();
  const first = await buildWorld({ hub, previous: null, mode: "full" });
  const summarize = deps.projects.summarize;
  deps.projects.summarize = async (entry) => ({ ...(await summarize(entry)), exists: entry.id !== "p2" && entry.path !== "/gone/old" });
  const second = await buildWorld({ hub, previous: first, mode: "full" });
  const portal = second.projects.find((p) => p.id === "p2");
  assert.equal(portal.missing, true);
  assert.equal(portal.repo, "moses/portal");
  assert.ok(second.repos.some((r) => r.repo === "moses/portal"));
});

test("helpers: repo from origin, project for a path, repo grouping", () => {
  assert.equal(repoFromOrigin("git@github.com:acme/app.git"), "acme/app");
  assert.equal(repoFromOrigin("https://gitlab.com/acme/app"), null);
  assert.equal(repoFromOrigin(null), null);
  const list = [{ id: "a", path: "/code/app" }, { id: "b", path: "/code/app/packages/x" }, { id: "c", path: "/code/app2" }];
  assert.equal(projectForPath(list, "/code/app/packages/x/src"), "b");
  assert.equal(projectForPath(list, "/code/app/src"), "a");
  assert.equal(projectForPath(list, "/code/app2"), "c");
  assert.equal(projectForPath(list, "/code/ap"), null);
  const base = { path: "/x", defaultBranch: null, missing: false, branch: null };
  const repos = groupRepos([
    { ...base, id: "w", name: "w", repo: "Acme/App", worktree: { parentId: "m", branch: "f", dirty: null, merged: null } },
    { ...base, id: "m", name: "m", repo: "acme/app", worktree: null },
    { ...base, id: "z", name: "z", repo: "zed/one", worktree: null },
  ]);
  assert.deepEqual(repos.map((r) => [r.repo, r.projectIds]), [["acme/app", ["m", "w"]], ["zed/one", ["z"]]]);
});
