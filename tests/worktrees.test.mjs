import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WorktreeError, ensureWorktree, getPull, listBranches, listPulls, mainWorktreeOf, portalWorktreesDir,
  removeWorktree, repoRootOf, sanitizeBranchForPath,
} from "../src/lib/worktrees.ts";

// The module under test inherits process.env, so isolate it from the developer's git config too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...identity, ...env },
  }).toString().trim();
}

/** Commit an empty change at a fixed second so ordering by committer date is deterministic. */
function commit(cwd, message, seconds) {
  const date = `@${seconds} +0000`;
  git(cwd, ["commit", "-q", "--allow-empty", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/**
 * A bare "origin" cloned into "main" (so origin/HEAD exists), with a local-only branch, an
 * origin-only branch, a branch checked out in a linked worktree, and a merged branch.
 */
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-wt-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  git(root, ["init", "-q", "-b", "main", seed]);
  commit(seed, "init", 1_000_000);
  git(root, ["init", "-q", "--bare", origin]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  const main = path.join(root, "main");
  git(root, ["clone", "-q", origin, main]);

  git(main, ["branch", "-q", "merged-branch"]);            // same commit as main → fully merged
  git(main, ["checkout", "-q", "-b", "local/only"]);
  commit(main, "local work", 1_000_200);
  git(main, ["checkout", "-q", "-b", "remote-only"]);
  commit(main, "remote work", 1_000_100);
  git(main, ["push", "-q", "origin", "remote-only"]);
  git(main, ["checkout", "-q", "main"]);
  git(main, ["branch", "-q", "-D", "remote-only"]);
  const wt = path.join(root, "wt");
  git(main, ["worktree", "add", "-q", "-b", "wt-branch", wt]);
  commit(wt, "worktree work", 1_000_300);
  const worktreesDir = path.join(root, "portal-home", "worktrees");
  return { root, origin, main, wt, worktreesDir, target: (branch) => path.join(worktreesDir, "main", sanitizeBranchForPath(branch)) };
}

async function rejectsWith(promise, status, check = () => {}) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof WorktreeError, `expected WorktreeError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    check(err);
    return true;
  });
}

test("portalWorktreesDir honours PORTAL_HOME", () => {
  const previous = process.env.PORTAL_HOME;
  try {
    delete process.env.PORTAL_HOME;
    assert.equal(portalWorktreesDir("/home/x"), path.join("/home/x", ".portal", "worktrees"));
    process.env.PORTAL_HOME = "/custom";
    assert.equal(portalWorktreesDir("/home/x"), path.join("/custom", "worktrees"));
  } finally {
    if (previous === undefined) delete process.env.PORTAL_HOME; else process.env.PORTAL_HOME = previous;
  }
});

test("sanitizeBranchForPath keeps safe characters and replaces the rest", () => {
  assert.equal(sanitizeBranchForPath("feat/foo"), "feat-foo");
  assert.equal(sanitizeBranchForPath("release-1.2_x"), "release-1.2_x");
  assert.equal(sanitizeBranchForPath("a b/c#d@e"), "a-b-c-d-e");
});

test("listBranches merges local and origin branches, excludes the default, and reports checkouts", async (t) => {
  const { main, wt } = fixture(t);
  const listing = await listBranches(main);
  assert.equal(listing.defaultBranch, "main");
  assert.deepEqual(listing.branches.map((b) => b.name), ["wt-branch", "local/only", "remote-only", "merged-branch"]);
  const byName = Object.fromEntries(listing.branches.map((b) => [b.name, b]));
  assert.deepEqual(byName["local/only"], { name: "local/only", local: true, remote: false, committedAt: 1_000_200_000, worktreePath: null });
  assert.deepEqual(byName["remote-only"], { name: "remote-only", local: false, remote: true, committedAt: 1_000_100_000, worktreePath: null });
  assert.equal(byName["wt-branch"].worktreePath, wt);
  assert.equal(byName["wt-branch"].local, true);
  assert.equal(byName["wt-branch"].remote, false);
  assert.equal(byName["merged-branch"].committedAt, 1_000_000_000);
});

test("listBranches falls back to main/master without origin/HEAD and reports no default otherwise", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-wt-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q", "-b", "master"]);
  commit(root, "init", 1_000_000);
  git(root, ["branch", "-q", "dev"]);
  assert.deepEqual(await listBranches(root), {
    defaultBranch: "master",
    branches: [{ name: "dev", local: true, remote: false, committedAt: 1_000_000_000, worktreePath: null }],
  });
  git(root, ["branch", "-m", "master", "trunk"]);
  const listing = await listBranches(root);
  assert.equal(listing.defaultBranch, null);
  assert.deepEqual(listing.branches.map((b) => b.name), ["dev", "trunk"]);
  assert.equal(listing.branches[1].worktreePath, root);
});

test("repoRootOf and mainWorktreeOf locate the repository", async (t) => {
  const { root, main, wt } = fixture(t);
  mkdirSync(path.join(main, "sub"));
  assert.equal(await repoRootOf(path.join(main, "sub")), main);
  assert.equal(await repoRootOf(wt), wt);
  await rejectsWith(repoRootOf(path.join(root, "nope")), 409);
  const plain = path.join(root, "plain");
  mkdirSync(plain);
  await rejectsWith(repoRootOf(plain), 409);
  assert.equal(await mainWorktreeOf(wt), main);
  assert.equal(await mainWorktreeOf(main), main);
});

test("ensureWorktree reuses existing checkouts without touching git", async (t) => {
  const { main, wt, worktreesDir } = fixture(t);
  assert.deepEqual(await ensureWorktree({ repoRoot: main, branch: "wt-branch", worktreesDir }), { path: wt, created: false });
  assert.deepEqual(await ensureWorktree({ repoRoot: main, branch: "main", worktreesDir }), { path: main, created: false });
  assert.ok(!existsSync(worktreesDir));
});

test("ensureWorktree checks out a local branch and reuses it afterwards", async (t) => {
  const { main, worktreesDir, target } = fixture(t);
  const first = await ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir });
  assert.deepEqual(first, { path: target("local/only"), created: true });
  assert.equal(git(first.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "local/only");
  assert.deepEqual(await ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir }), { path: first.path, created: false });
  assert.equal((await listBranches(main)).branches.find((b) => b.name === "local/only").worktreePath, first.path);
});

test("ensureWorktree fetches an origin-only branch and tracks it", async (t) => {
  const { main, worktreesDir, target } = fixture(t);
  const result = await ensureWorktree({ repoRoot: main, branch: "remote-only", worktreesDir });
  assert.deepEqual(result, { path: target("remote-only"), created: true });
  assert.equal(git(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "remote-only");
  assert.equal(git(result.path, ["rev-parse", "--abbrev-ref", "remote-only@{upstream}"]), "origin/remote-only");
  assert.equal(git(result.path, ["rev-parse", "HEAD"]), git(main, ["rev-parse", "origin/remote-only"]));
});

test("ensureWorktree creates a new branch from origin's default branch", async (t) => {
  const { main, origin, worktreesDir, target } = fixture(t);
  // Advance origin/main behind the clone's back: create must fetch first.
  const other = path.join(path.dirname(main), "other");
  git(path.dirname(main), ["clone", "-q", origin, other]);
  commit(other, "upstream work", 1_000_500);
  git(other, ["push", "-q", "origin", "main"]);
  const upstream = git(other, ["rev-parse", "HEAD"]);

  const result = await ensureWorktree({ repoRoot: main, branch: "feat/new", create: true, worktreesDir });
  assert.deepEqual(result, { path: target("feat/new"), created: true });
  assert.equal(git(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "feat/new");
  assert.equal(git(result.path, ["rev-parse", "HEAD"]), upstream);
  assert.throws(() => git(result.path, ["rev-parse", "--abbrev-ref", "feat/new@{upstream}"]), /no upstream/);
  // The main checkout was not moved.
  assert.notEqual(git(main, ["rev-parse", "main"]), upstream);
});

test("ensureWorktree validates names and refuses to create existing branches", async (t) => {
  const { main, worktreesDir } = fixture(t);
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "bad..name", create: true, worktreesDir }), 400);
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "-flag", create: true, worktreesDir }), 400);
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "@{-1}", worktreesDir }), 400);
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "", worktreesDir }), 400);
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "local/only", create: true, worktreesDir }), 409);
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "remote-only", create: true, worktreesDir }), 409, (err) => {
    assert.match(err.message, /already exists on origin/);
  });
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "nothing-here", worktreesDir }), 404, (err) => {
    assert.equal(err.message, "Branch nothing-here does not exist.");
  });
  assert.ok(!existsSync(worktreesDir));
});

test("ensureWorktree refuses a leftover folder git does not know about, but prunes stale registrations", async (t) => {
  const { main, worktreesDir, target } = fixture(t);
  mkdirSync(target("local/only"), { recursive: true });
  await rejectsWith(ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir }), 409, (err) => {
    assert.match(err.message, /not a worktree/);
  });
  rmSync(target("local/only"), { recursive: true });

  const created = await ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir });
  rmSync(created.path, { recursive: true });
  // The registration is stale now; git would otherwise refuse the branch as "already checked out".
  assert.equal((await listBranches(main)).branches.find((b) => b.name === "local/only").worktreePath, null);
  assert.deepEqual(await ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir }), { path: created.path, created: true });
  assert.ok(existsSync(path.join(created.path, ".git")));
});

test("removeWorktree removes a clean tree and deletes the branch only when merged", async (t) => {
  const { main, worktreesDir } = fixture(t);
  const merged = await ensureWorktree({ repoRoot: main, branch: "merged-branch", worktreesDir });
  assert.deepEqual(await removeWorktree({ repoRoot: main, path: merged.path, branch: "merged-branch" }), { branchDeleted: true });
  assert.ok(!existsSync(merged.path));
  assert.ok(!(await listBranches(main)).branches.some((b) => b.name === "merged-branch"));

  const unmerged = await ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir });
  assert.deepEqual(await removeWorktree({ repoRoot: main, path: unmerged.path, branch: "local/only" }), { branchDeleted: false });
  assert.ok(!existsSync(unmerged.path));
  assert.ok((await listBranches(main)).branches.some((b) => b.name === "local/only"));
  assert.ok(!git(main, ["worktree", "list", "--porcelain"]).includes(unmerged.path));
});

test("removeWorktree reports a dirty tree as 409 dirty and honours force", async (t) => {
  const { main, worktreesDir } = fixture(t);
  const created = await ensureWorktree({ repoRoot: main, branch: "local/only", worktreesDir });
  writeFileSync(path.join(created.path, "scratch.txt"), "wip");
  await rejectsWith(removeWorktree({ repoRoot: main, path: created.path, branch: "local/only" }), 409, (err) => {
    assert.equal(err.dirty, true);
    assert.match(err.message, /untracked|modified/);
  });
  assert.ok(existsSync(created.path), "kept on refusal");
  assert.deepEqual(await removeWorktree({ repoRoot: main, path: created.path, branch: "local/only", force: true }), { branchDeleted: false });
  assert.ok(!existsSync(created.path));
});

test("removeWorktree prunes when the folder is already gone", async (t) => {
  const { main, worktreesDir } = fixture(t);
  const created = await ensureWorktree({ repoRoot: main, branch: "merged-branch", worktreesDir });
  rmSync(created.path, { recursive: true });
  assert.ok(git(main, ["worktree", "list", "--porcelain"]).includes(created.path));
  assert.deepEqual(await removeWorktree({ repoRoot: main, path: created.path, branch: "merged-branch" }), { branchDeleted: true });
  assert.ok(!git(main, ["worktree", "list", "--porcelain"]).includes(created.path));
});

const openPr = { number: 12, title: "Add thing", headRefName: "feat/thing", updatedAt: "2026-09-01T10:00:00Z", isCrossRepository: false, state: "OPEN" };
const forkPr = { number: 7, title: "From a fork", headRefName: "fix", updatedAt: "2026-09-02T10:00:00Z", isCrossRepository: true, state: "OPEN" };

function fakeGh(handler) {
  const calls = [];
  const gh = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    return handler(args);
  };
  return { gh, calls };
}

function ghError(stderr, code) {
  return Object.assign(new Error(`gh failed: ${stderr}`), { stderr, code });
}

test("listPulls maps gh output and sorts by update time", async () => {
  const { gh, calls } = fakeGh(() => ({ stdout: JSON.stringify([openPr, forkPr]), stderr: "" }));
  const result = await listPulls("/repo", gh);
  assert.deepEqual(result, {
    pulls: [
      { number: 7, title: "From a fork", branch: "fix", state: "open", updatedAt: Date.parse(forkPr.updatedAt), fork: true },
      { number: 12, title: "Add thing", branch: "feat/thing", state: "open", updatedAt: Date.parse(openPr.updatedAt), fork: false },
    ],
    pullsError: null,
  });
  assert.deepEqual(calls, [{ args: ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName,updatedAt,isCrossRepository,state"], cwd: "/repo" }]);
});

test("listPulls explains why gh could not answer", async () => {
  const cases = [
    [ghError("", "ENOENT"), "gh is not installed"],
    [ghError("To get started with GitHub CLI, please run:  gh auth login"), "gh is not logged in"],
    [ghError("none of the git remotes configured for this repository point to a known GitHub host"), "origin is not a GitHub repository"],
    [ghError("could not determine base repo"), "origin is not a GitHub repository"],
    [ghError("GraphQL: something odd\nsecond line"), "GraphQL: something odd"],
  ];
  for (const [err, reason] of cases) {
    const { gh } = fakeGh(() => { throw err; });
    assert.deepEqual(await listPulls("/repo", gh), { pulls: null, pullsError: reason });
  }
  const { gh } = fakeGh(() => ({ stdout: "not json", stderr: "" }));
  assert.deepEqual(await listPulls("/repo", gh), { pulls: null, pullsError: "gh returned unexpected output" });
});

test("getPull returns any state, 404 when missing, and 409 when gh is unavailable", async () => {
  const { gh, calls } = fakeGh(() => ({ stdout: JSON.stringify({ ...openPr, state: "MERGED" }), stderr: "" }));
  assert.deepEqual(await getPull("/repo", 12, gh), {
    number: 12, title: "Add thing", branch: "feat/thing", state: "merged", updatedAt: Date.parse(openPr.updatedAt), fork: false,
  });
  assert.deepEqual(calls[0].args, ["pr", "view", "12", "--json", "number,title,headRefName,updatedAt,isCrossRepository,state"]);

  const missing = fakeGh(() => { throw ghError("GraphQL: Could not resolve to a PullRequest with the number of 999."); });
  await rejectsWith(getPull("/repo", 999, missing.gh), 404, (err) => assert.equal(err.message, "PR #999 not found."));
  const loggedOut = fakeGh(() => { throw ghError("gh auth login required"); });
  await rejectsWith(getPull("/repo", 1, loggedOut.gh), 409, (err) => assert.equal(err.message, "gh is not logged in"));
});
