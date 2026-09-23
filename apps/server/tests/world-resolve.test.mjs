import assert from "node:assert/strict";
import test from "node:test";
import { resolvePull, resolveRepo, resolveSession } from "../src/orchestrator/world/resolve.ts";
import { T0, attentionPull } from "./fixtures/orchestrator-fakes.mjs";

function worldProject(overrides = {}) {
  return { id: "p1", name: "app", path: "/code/app", repo: null, defaultBranch: null, worktree: null, missing: false, branch: "main", ...overrides };
}

function worldSession(overrides = {}) {
  return {
    id: "s1", title: "Fix login", projectId: "p1", agentId: "claude", agentName: "Claude Code", activity: "idle", link: "live",
    createdAt: T0 - 60_000, lastActiveAt: T0 - 30_000, ...overrides,
  };
}

/** The user's Portal: a monorepo with a worktree, their own portal repo, a web repo and its legacy fork, and a loose folder. */
function world(overrides = {}) {
  const projects = [
    worldProject({ id: "mono-main-0000", name: "platform", path: "/code/platform", repo: "acme/monorepo", defaultBranch: "main" }),
    worldProject({ id: "mono-wt-0000", name: "platform-feat", path: "/wt/platform-feat", repo: "acme/monorepo", worktree: { parentId: "mono-main-0000", branch: "feat", dirty: false, merged: false } }),
    worldProject({ id: "portal-0000", name: "Portal", path: "/code/portal", repo: "moses/portal", defaultBranch: "main" }),
    worldProject({ id: "web-0000", name: "web", path: "/code/web", repo: "acme/web" }),
    worldProject({ id: "legacy-0000", name: "web-legacy", path: "/code/web-legacy", repo: "acme/web-legacy" }),
    worldProject({ id: "notes-0000", name: "notes", path: "/code/notes" }),
  ];
  return {
    at: T0, login: "moses-lee", projects,
    repos: [
      { repo: "acme/monorepo", defaultBranch: "main", projectIds: ["mono-main-0000", "mono-wt-0000"] },
      { repo: "acme/web", defaultBranch: "main", projectIds: ["web-0000"] },
      { repo: "acme/web-legacy", defaultBranch: "main", projectIds: ["legacy-0000"] },
      { repo: "moses/portal", defaultBranch: "main", projectIds: ["portal-0000"] },
    ],
    sessions: [
      worldSession({ id: "11111111-aaaa", title: "Review PR 2367", projectId: "mono-wt-0000", activity: "working", lastActiveAt: T0 - 1000 }),
      worldSession({ id: "22222222-bbbb", title: "Fix the login bug", projectId: "portal-0000", activity: "waiting", lastActiveAt: T0 - 2000 }),
      worldSession({ id: "33333333-cccc", title: "Refactor login form", projectId: "web-0000", lastActiveAt: T0 - 3000 }),
    ],
    terminals: [], intents: [], jobs: [], items: [], errors: [],
    pulls: [
      attentionPull({ repo: "acme/monorepo", number: 2367, headBranch: "feat", roles: ["reviewer"], localProjectId: "mono-main-0000", worktreeProjectId: "mono-wt-0000" }),
      attentionPull({ repo: "acme/web", number: 50, localProjectId: "web-0000" }),
      attentionPull({ repo: "moses/portal", number: 50, localProjectId: "portal-0000" }),
    ],
    snapshot: { at: T0, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [] },
    ...overrides,
  };
}

const notFound = (number) => Object.assign(new Error(`PR #${number} not found.`), { status: 404 });

/** `getPull` answering from a table of repo root → PR numbers; records every call. */
function fakeGit(table, extra = {}) {
  const calls = [];
  return {
    calls,
    git: {
      repoRootOf: async (dir) => dir,
      getPull: async (root, number) => {
        calls.push([root, number]);
        if (extra[root]) return extra[root](number);
        const pull = table[root]?.[number];
        if (!pull) throw notFound(number);
        return { number, title: pull.title ?? `PR ${number}`, branch: pull.branch ?? "topic", state: pull.state ?? "open", updatedAt: T0, fork: false };
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// resolve_pull
// ---------------------------------------------------------------------------------------------

test("a PR in the world resolves at once to its repo, checkout, and worktree, without asking GitHub", async () => {
  const { git, calls } = fakeGit({});
  const result = await resolvePull(world(), { git }, { number: 2367 });
  assert.equal(result.source, "world");
  assert.deepEqual(result.match, {
    repo: "acme/monorepo", number: 2367, url: "https://github.com/acme/monorepo/pull/2367", title: "Add thing", author: "moses-lee", state: "open",
    headBranch: "feat", baseBranch: "main", projectId: "mono-main-0000", worktreeProjectId: "mono-wt-0000",
  });
  assert.deepEqual(calls, []);
});

test("one of the user's PRs in a repo Portal does not have resolves from the world too", async () => {
  const { git, calls } = fakeGit({});
  const outside = attentionPull({ repo: "other/tool", number: 812, roles: ["reviewer"] });
  const result = await resolvePull(world({ pulls: [...world().pulls, outside] }), { git }, { number: 812 });
  assert.equal(result.source, "world");
  assert.equal(result.match.repo, "other/tool");
  assert.equal(result.match.projectId, null);
  assert.deepEqual(calls, []);
  // Naming a Portal repo still narrows to Portal repos.
  assert.equal((await resolvePull(world({ pulls: [outside] }), { git }, { number: 812, repo: "web" })).match, null);
});

test("the same number open in two repos gives both as candidates; a repo hint picks one", async () => {
  const { git } = fakeGit({});
  const both = await resolvePull(world(), { git }, { number: 50 });
  assert.equal(both.match, null);
  assert.deepEqual(both.candidates.map((c) => c.repo).sort(), ["acme/web", "moses/portal"]);
  assert.match(both.reason, /ask the user/);
  const hinted = await resolvePull(world(), { git }, { number: 50, repo: "portal" });
  assert.equal(hinted.match.repo, "moses/portal");
  assert.equal(hinted.match.projectId, "portal-0000");
});

test("a PR the world does not list is found by asking each repo; the worktree on its branch is reported", async () => {
  const { git, calls } = fakeGit({ "/code/platform": { 999: { title: "Hidden", branch: "feat" } } });
  const result = await resolvePull(world(), { git }, { number: 999 });
  assert.equal(result.source, "github");
  assert.equal(result.match.repo, "acme/monorepo");
  assert.equal(result.match.title, "Hidden");
  assert.equal(result.match.projectId, "mono-main-0000");
  assert.equal(result.match.worktreeProjectId, "mono-wt-0000");
  assert.equal(result.match.url, "https://github.com/acme/monorepo/pull/999");
  assert.deepEqual(calls.map(([root]) => root).sort(), ["/code/platform", "/code/portal", "/code/web", "/code/web-legacy"], "one lookup per repo");
});

test("several repos with that number give candidates; none gives a reason naming repos that could not be asked", async () => {
  const { git } = fakeGit({ "/code/web": { 7: {} }, "/code/portal": { 7: { state: "merged" } } });
  const several = await resolvePull(world(), { git }, { number: 7 });
  assert.equal(several.match, null);
  assert.deepEqual(several.candidates.map((c) => c.repo), ["acme/web", "moses/portal"], "open first");
  const failing = fakeGit({}, { "/code/web": async () => { throw Object.assign(new Error("gh is not logged in"), { status: 409 }); } });
  const none = await resolvePull(world(), { git: failing.git }, { number: 4242 });
  assert.equal(none.match, null);
  assert.deepEqual(none.candidates, []);
  assert.match(none.reason, /No repo in Portal has PR #4242; 1 repo\(s\) could not be checked/);
  assert.deepEqual(none.failed, ["acme/web: gh is not logged in"]);
});

test("lookups run with a concurrency cap and give up on a repo after the timeout", async () => {
  let inFlight = 0;
  let peak = 0;
  const git = {
    repoRootOf: async (dir) => dir,
    getPull: async (root, number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (root === "/code/web-legacy") return new Promise(() => {});
      throw notFound(number);
    },
  };
  const result = await resolvePull(world(), { git }, { number: 1 }, { concurrency: 2, timeoutMs: 30 });
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(result.match, null);
  assert.deepEqual(result.failed, ["acme/web-legacy: no answer within 30ms"]);
});

test("a repo hint that names no Portal repo is reported, not guessed", async () => {
  const { git, calls } = fakeGit({});
  const unknown = await resolvePull(world(), { git }, { number: 3, repo: "zzzzzz" });
  assert.match(unknown.reason, /No repo in Portal matches "zzzzzz"/);
  const outside = await resolvePull(world(), { git }, { number: 3, repo: "other/thing" });
  assert.match(outside.reason, /other\/thing has no Portal project/);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------------------------
// resolve_repo
// ---------------------------------------------------------------------------------------------

test("resolve_repo matches owner/name, name, project and folder names, and loose phrasings", () => {
  const w = world();
  const repoOf = (query) => {
    const result = resolveRepo(w, query);
    assert.ok(result.match, `${query}: ${result.reason}`);
    return result.match.repo;
  };
  assert.equal(repoOf("acme/monorepo"), "acme/monorepo");
  assert.equal(repoOf("https://github.com/acme/monorepo.git"), "acme/monorepo");
  assert.equal(repoOf("monorepo"), "acme/monorepo");
  assert.equal(repoOf("the monorepo"), "acme/monorepo");
  assert.equal(repoOf("platform"), "acme/monorepo", "by project name");
  assert.equal(repoOf("platform-feat"), "acme/monorepo", "a worktree's name leads to its repo");
  assert.equal(repoOf("PORTAL"), "moses/portal");
  assert.equal(repoOf("the portal repo"), "moses/portal");
  assert.equal(repoOf("mono repo"), "acme/monorepo");
  assert.equal(repoOf("portl"), "moses/portal", "a typo");
  assert.equal(repoOf("web"), "acme/web", "an exact name beats a longer one containing it");
  const match = resolveRepo(w, "monorepo").match;
  assert.equal(match.projectId, "mono-main-0000");
  assert.deepEqual(match.projects.map((p) => p.id), ["mono-main-0000", "mono-wt-0000"]);
  assert.equal(match.defaultBranch, "main");
});

test("resolve_repo returns candidates when a loose query fits several, a project without a repo, or nothing", () => {
  const w = world();
  const several = resolveRepo(w, "acme");
  assert.equal(several.match, null);
  assert.deepEqual(several.candidates.map((c) => c.repo).sort(), ["acme/monorepo", "acme/web", "acme/web-legacy"]);
  const notes = resolveRepo(w, "notes");
  assert.equal(notes.match.repo, null);
  assert.equal(notes.match.projectId, "notes-0000");
  const none = resolveRepo(w, "kubernetes");
  assert.equal(none.match, null);
  assert.deepEqual(none.candidates, []);
  assert.match(none.reason, /No repo matches/);
});

// ---------------------------------------------------------------------------------------------
// resolve_session
// ---------------------------------------------------------------------------------------------

test("resolve_session finds by id, id prefix, title, activity, project, and title words", () => {
  const w = world();
  const idOf = (query) => {
    const result = resolveSession(w, query);
    assert.ok(result.match, `${query}: ${result.reason}`);
    return result.match.id;
  };
  assert.equal(idOf("22222222-bbbb"), "22222222-bbbb");
  assert.equal(idOf("2222"), "22222222-bbbb");
  assert.equal(idOf("Review PR 2367"), "11111111-aaaa");
  assert.equal(idOf("the review session"), "11111111-aaaa");
  assert.equal(idOf("waiting"), "22222222-bbbb");
  assert.equal(idOf("Portal"), "22222222-bbbb", "by project");
  assert.equal(idOf("refactor form"), "33333333-cccc");
  const match = resolveSession(w, "2367").match;
  assert.deepEqual(match, { id: "11111111-aaaa", title: "Review PR 2367", projectId: "mono-wt-0000", projectName: "platform-feat", activity: "working", lastActiveAt: T0 - 1000 });
});

test("resolve_session gives candidates, most recent first, or a reason", () => {
  const w = world();
  const login = resolveSession(w, "login");
  assert.equal(login.match, null);
  assert.deepEqual(login.candidates.map((c) => c.id), ["22222222-bbbb", "33333333-cccc"]);
  const none = resolveSession(w, "kubernetes upgrade");
  assert.equal(none.match, null);
  assert.match(none.reason, /No session matches/);
});
