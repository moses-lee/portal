import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWorktreeState } from "../src/orchestrator/worktree-state.ts";

// The module under test inherits process.env, so isolate it from the developer's git config too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...identity, ...env },
  }).toString().trim();
}

function commit(cwd, message) {
  const date = "@1000000 +0000";
  git(cwd, ["commit", "-q", "--allow-empty", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/**
 * A bare "origin" cloned into "main" (so origin/main exists), with a worktree "ahead" whose branch has
 * a commit main lacks and a worktree "landed" whose branch sits at the same commit as origin/main.
 */
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-wts-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  git(root, ["init", "-q", "-b", "main", seed]);
  commit(seed, "init");
  git(root, ["init", "-q", "--bare", origin]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  const main = path.join(root, "main");
  git(root, ["clone", "-q", origin, main]);
  const ahead = path.join(root, "ahead");
  git(main, ["worktree", "add", "-q", "-b", "feat/ahead", ahead]);
  commit(ahead, "ahead work");
  const landed = path.join(root, "landed");
  git(main, ["worktree", "add", "-q", "-b", "feat/landed", landed]);
  return { root, origin, main, ahead, landed };
}

test("readWorktreeState reports an unmerged clean worktree, then dirty once it has changes", async (t) => {
  const { main, ahead } = fixture(t);
  const args = { repoRoot: main, path: ahead, branch: "feat/ahead", defaultBranch: "main" };
  assert.deepEqual(await readWorktreeState(args), { exists: true, merged: false, dirty: false });

  writeFileSync(path.join(ahead, "notes.txt"), "wip\n");
  assert.deepEqual(await readWorktreeState(args), { exists: true, merged: false, dirty: true }, "an untracked file counts");
  git(ahead, ["add", "notes.txt"]);
  assert.deepEqual(await readWorktreeState(args), { exists: true, merged: false, dirty: true }, "so does a staged one");
  commit(ahead, "notes");
  assert.deepEqual(await readWorktreeState(args), { exists: true, merged: false, dirty: false });
});

test("readWorktreeState sees a branch as merged only through origin/<default>, without fetching", async (t) => {
  const { main, ahead, landed, origin } = fixture(t);
  assert.deepEqual(await readWorktreeState({ repoRoot: main, path: landed, branch: "feat/landed", defaultBranch: "main" }), {
    exists: true, merged: true, dirty: false,
  });

  // Land feat/ahead on origin's main behind this clone's back: nothing changes until someone fetches.
  const args = { repoRoot: main, path: ahead, branch: "feat/ahead", defaultBranch: "main" };
  git(ahead, ["push", "-q", origin, "feat/ahead:main"]);
  assert.equal((await readWorktreeState(args)).merged, false, "origin/main is stale locally");
  git(main, ["fetch", "-q", "origin"]);
  assert.equal((await readWorktreeState(args)).merged, true);

  // Merged into the local main only (not origin/main) does not count.
  const { main: main2, ahead: ahead2 } = fixture(t);
  git(main2, ["merge", "-q", "--ff-only", "feat/ahead"]);
  assert.equal((await readWorktreeState({ repoRoot: main2, path: ahead2, branch: "feat/ahead", defaultBranch: "main" })).merged, false);
});

test("readWorktreeState is false for a missing ref, no default branch, or the default branch itself", async (t) => {
  const { main, landed } = fixture(t);
  assert.equal((await readWorktreeState({ repoRoot: main, path: landed, branch: "feat/nope", defaultBranch: "main" })).merged, false);
  assert.equal((await readWorktreeState({ repoRoot: main, path: landed, branch: "feat/landed", defaultBranch: "trunk" })).merged, false);
  assert.equal((await readWorktreeState({ repoRoot: main, path: landed, branch: "feat/landed", defaultBranch: null })).merged, false);
  assert.equal((await readWorktreeState({ repoRoot: main, path: main, branch: "main", defaultBranch: "main" })).merged, false);
  assert.equal((await readWorktreeState({ repoRoot: main, path: landed, branch: "", defaultBranch: "main" })).merged, false);
});

test("readWorktreeState reports a missing folder without touching git", async (t) => {
  const { root, main, landed } = fixture(t);
  assert.deepEqual(await readWorktreeState({ repoRoot: main, path: path.join(root, "gone"), branch: "feat/landed", defaultBranch: "main" }), {
    exists: false, merged: false, dirty: false,
  });
  // A folder that exists but is not a repository is clean.
  writeFileSync(path.join(root, "file"), "x");
  assert.deepEqual(await readWorktreeState({ repoRoot: main, path: path.join(root, "file"), branch: "feat/landed", defaultBranch: "main" }), {
    exists: false, merged: false, dirty: false,
  }, "a file is not a folder");
  rmSync(landed, { recursive: true, force: true });
  assert.deepEqual(await readWorktreeState({ repoRoot: main, path: landed, branch: "feat/landed", defaultBranch: "main" }), {
    exists: false, merged: false, dirty: false,
  }, "a deleted worktree folder is reported missing even though the branch is merged");
});
