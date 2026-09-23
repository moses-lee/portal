import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { displayPath, readGitInfo, sameGitInfo } from "../src/lib/git-info.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).toString().trim();
}

function repo(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-git-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

test("reads the branch from HEAD, from nested directories, without spawning git", async (t) => {
  const root = repo(t);
  mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  const info = await readGitInfo(path.join(root, "src", "lib"));
  assert.deepEqual(info, { root, displayRoot: displayPath(root), branch: "main", detached: false });

  git(root, "checkout", "-q", "-b", "feature/status-bar");
  assert.equal((await readGitInfo(root)).branch, "feature/status-bar");
});

test("reports detached HEAD with an abbreviated commit", async (t) => {
  const root = repo(t);
  const sha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "--detach");
  const info = await readGitInfo(root);
  assert.equal(info.detached, true);
  assert.equal(info.branch, sha.slice(0, 7));
});

test("follows linked worktrees and ignores non-repositories", async (t) => {
  const root = repo(t);
  const linked = path.join(root, "..", `${path.basename(root)}-wt`);
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  git(root, "worktree", "add", "-q", "-b", "wt-branch", linked);
  const info = await readGitInfo(linked);
  assert.equal(info.root, realpathSync(linked));
  assert.equal(info.branch, "wt-branch");

  const plain = mkdtempSync(path.join(os.tmpdir(), "portal-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  writeFileSync(path.join(plain, ".git"), "not a pointer\n");
  assert.equal(await readGitInfo(plain), null);
});

test("compares git info by repository and branch", () => {
  const a = { root: "/r", displayRoot: "/r", branch: "main", detached: false };
  assert.ok(sameGitInfo(null, null));
  assert.ok(sameGitInfo(a, { ...a }));
  assert.ok(!sameGitInfo(a, null));
  assert.ok(!sameGitInfo(a, { ...a, branch: "dev" }));
  assert.ok(!sameGitInfo(a, { ...a, detached: true }));
});
