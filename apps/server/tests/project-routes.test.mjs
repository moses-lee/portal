import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { context } from "../src/context.ts";
import { defaultScriptSettings } from "@portal/shared/scripts";
import { temporaryDatabase } from "./helpers/db.mjs";

// git runs with the developer's config otherwise; the worktree routes shell out to it.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const EVIL = { origin: "http://evil.example" };

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...identity } }).toString().trim();
}

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

/**
 * An app over a throwaway database whose Portal home (worktrees) is a scratch folder. `sessions`
 * swaps in a fake listing so the removed-project flows can be driven without running agents.
 */
async function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-project-routes-")));
  const portalHome = path.join(root, "portal-home");
  process.env.PORTAL_HOME = portalHome;
  const database = await temporaryDatabase(t);
  const app = await buildApp({ config: { ...loadConfig(), portalHome }, database, orchestrator: false });
  const ctx = context();
  const realSessions = ctx.sessions;
  t.after(async () => {
    ctx.sessions = realSessions;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessions = [];
  const deleted = [];
  const closedTerminals = [];
  ctx.sessions = {
    ready: Promise.resolve(),
    listSessions: () => sessions,
    deleteSession: async (id) => {
      const index = sessions.findIndex((s) => s.id === id);
      if (index < 0) return false;
      sessions.splice(index, 1);
      deleted.push(id);
      return true;
    },
    dispose: () => realSessions.dispose(),
  };
  const realCloseSession = ctx.terminals.closeSession;
  ctx.terminals.closeSession = (id) => { closedTerminals.push(id); return realCloseSession(id); };
  const useScript = (overrides) => {
    ctx.settings = { ...ctx.settings, read: async () => ({ scripts: { preWorktreeDelete: { ...defaultScriptSettings, ...overrides } } }) };
  };
  const call = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });
  return { app, root, portalHome, sessions, deleted, closedTerminals, useScript, call };
}

const session = (id, projectId, cwd, at = 1) => ({ id, projectId, cwd, createdAt: at, lastActiveAt: at });

test("project CRUD: add, list, rename, remove", async (t) => {
  const { root, call } = await setup(t);
  const dir = path.join(root, "one");
  mkdirSync(dir);

  assert.deepEqual((await call("GET", "/api/projects")).json(), { projects: [] });
  for (const [payload, error] of [
    [undefined, "Expected a JSON object."],
    [[1], "Expected a JSON object."],
    [{}, "Path is required."],
    [{ path: "  " }, "Path is required."],
    [{ path: dir, name: 3 }, "Name must be a string."],
  ]) {
    const res = await call("POST", "/api/projects", payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(res.json(), { error });
  }
  const missing = await call("POST", "/api/projects", { path: path.join(root, "nope") });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /Directory not found/);
  assert.equal((await call("POST", "/api/projects", { path: "relative" })).statusCode, 400);

  const created = await call("POST", "/api/projects", { path: ` ${dir} `, name: "One" });
  assert.equal(created.statusCode, 201);
  const project = created.json();
  assert.equal(project.name, "One");
  assert.equal(project.path, dir);

  const duplicate = await call("POST", "/api/projects", { path: dir });
  assert.equal(duplicate.statusCode, 409);
  assert.deepEqual(duplicate.json(), { error: `Already added as "One".`, project });

  const listed = (await call("GET", "/api/projects")).json().projects;
  assert.deepEqual(listed, [{ ...project, displayPath: dir, git: null, exists: true }]);

  assert.deepEqual((await call("PATCH", `/api/projects/${project.id}`, { nope: 1 })).json(), { error: "Expected {name}." });
  const blank = await call("PATCH", `/api/projects/${project.id}`, { name: " " });
  assert.equal(blank.statusCode, 400);
  assert.deepEqual(blank.json(), { error: "Project name cannot be empty." });
  assert.equal((await call("PATCH", "/api/projects/nope", { name: "x" })).statusCode, 404);
  const renamed = await call("PATCH", `/api/projects/${project.id}`, { name: "First" });
  assert.equal(renamed.statusCode, 200);
  assert.deepEqual(renamed.json(), { ...project, name: "First" });

  assert.deepEqual((await call("DELETE", "/api/projects/nope")).json(), { error: "Unknown project." });
  const notWorktree = await call("DELETE", `/api/projects/${project.id}?worktree=delete`);
  assert.equal(notWorktree.statusCode, 400);
  assert.deepEqual(notWorktree.json(), { error: "This project is not a worktree." });
  const removed = await call("DELETE", `/api/projects/${project.id}`);
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");
  assert.deepEqual((await call("GET", "/api/projects")).json(), { projects: [] });
  assert.deepEqual((await call("GET", "/api/projects/removed")).json(), { removed: [] }, "no conversations, so nothing is kept");
});

test("the directory browser lists subfolders, marks repositories, and reports bad paths", async (t) => {
  const { root, call } = await setup(t);
  const base = path.join(root, "browse");
  for (const dir of ["b", "A", ".hidden", "repo/.git"]) mkdirSync(path.join(base, dir), { recursive: true });
  writeFileSync(path.join(base, "file.txt"), "x");

  const res = await call("GET", `/api/fs/dirs?path=${encodeURIComponent(base)}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    path: base,
    parent: root,
    entries: [
      { name: "A", path: path.join(base, "A"), isGitRepo: false },
      { name: "b", path: path.join(base, "b"), isGitRepo: false },
      { name: "repo", path: path.join(base, "repo"), isGitRepo: true },
    ],
  });
  const hidden = (await call("GET", `/api/fs/dirs?path=${encodeURIComponent(base)}&hidden=1`)).json();
  assert.deepEqual(hidden.entries.map((e) => e.name), [".hidden", "A", "b", "repo"]);
  assert.equal((await call("GET", "/api/fs/dirs")).json().path, realpathSync(os.homedir()), "no path means home");

  const missing = await call("GET", `/api/fs/dirs?path=${encodeURIComponent(path.join(base, "gone"))}`);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error, /Directory not found/);
  const relative = await call("GET", "/api/fs/dirs?path=relative");
  assert.equal(relative.statusCode, 400);
  assert.deepEqual(relative.json(), { error: "Path must be absolute (or start with ~/)." });
  assert.equal((await call("GET", `/api/fs/dirs?path=${encodeURIComponent(path.join(base, "file.txt"))}`)).statusCode, 400);
});

test("every project route refuses cross-origin requests", async (t) => {
  const { root, call } = await setup(t);
  mkdirSync(path.join(root, "one"));
  const project = (await call("POST", "/api/projects", { path: path.join(root, "one") })).json();
  const routes = [
    ["GET", "/api/fs/dirs"],
    ["GET", "/api/projects"],
    ["POST", "/api/projects", { path: path.join(root, "one") }],
    ["PATCH", `/api/projects/${project.id}`, { name: "x" }],
    ["DELETE", `/api/projects/${project.id}`],
    ["GET", `/api/projects/${project.id}/branches`],
    ["GET", `/api/projects/${project.id}/pulls/1`],
    ["GET", `/api/projects/${project.id}/github`],
    ["GET", `/api/projects/${project.id}/github/log?before=x`],
    ["POST", `/api/projects/${project.id}/github/pull`],
    ["POST", `/api/projects/${project.id}/worktrees`, { branch: "x" }],
    ["GET", "/api/projects/removed"],
    ["DELETE", "/api/projects/removed/x"],
    ["POST", "/api/projects/removed/x/restore"],
  ];
  for (const [method, url, payload] of routes) {
    const res = await call(method, url, payload, EVIL);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: "Cross-origin requests are not allowed." });
  }
  const site = await call("GET", "/api/projects", undefined, { "sec-fetch-site": "cross-site" });
  assert.equal(site.statusCode, 403);
  assert.deepEqual(site.json(), { error: "Cross-site requests are not allowed." });
  // A same-origin browser request goes through.
  assert.equal((await call("GET", "/api/projects", undefined, { origin: "http://localhost:3000", host: "localhost:3000" })).statusCode, 200);
  assert.equal(context().projects.get(project.id).name, "one", "the refused rename did not happen");
});

test("per-project routes validate their input and answer 404 for unknown projects", async (t) => {
  const { root, call } = await setup(t);
  mkdirSync(path.join(root, "plain"));
  const plain = (await call("POST", "/api/projects", { path: path.join(root, "plain") })).json();

  for (const raw of ["0", "-1", "abc", "1.5", "99999999999999999999"]) {
    const res = await call("GET", `/api/projects/${plain.id}/pulls/${raw}`);
    assert.equal(res.statusCode, 400, raw);
    assert.deepEqual(res.json(), { error: "PR number must be a positive integer." });
  }
  const noCursor = await call("GET", `/api/projects/${plain.id}/github/log`);
  assert.equal(noCursor.statusCode, 400);
  assert.deepEqual(noCursor.json(), { error: "before must be a log cursor from a previous page." });

  for (const [method, url, payload] of [
    ["GET", "/api/projects/nope/branches"],
    ["GET", "/api/projects/nope/pulls/1"],
    ["GET", "/api/projects/nope/github"],
    ["GET", "/api/projects/nope/github/log?before=x"],
    ["POST", "/api/projects/nope/github/pull"],
    ["POST", "/api/projects/nope/worktrees", { branch: "x" }],
  ]) {
    const res = await call(method, url, payload);
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: "Unknown project." });
  }

  for (const [payload, error] of [
    [undefined, "Expected a JSON object."],
    [{ branch: " " }, "Branch is required."],
    [{ branch: "x", create: "yes" }, "create must be a boolean."],
  ]) {
    const res = await call("POST", `/api/projects/${plain.id}/worktrees`, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(res.json(), { error });
  }
  // Not a repository: git-backed routes answer 409 with the reason.
  const branches = await call("GET", `/api/projects/${plain.id}/branches`);
  assert.equal(branches.statusCode, 409);
  assert.deepEqual(branches.json(), { error: "The project is not in a git repository." });
  assert.equal((await call("POST", `/api/projects/${plain.id}/worktrees`, { branch: "x" })).statusCode, 409);
});

test("worktrees: create, reuse, list branches, and delete with the pre-deletion script", async (t) => {
  const { root, portalHome, call, useScript } = await setup(t);
  process.env.LOG = path.join(root, "script.log");
  const main = repo(root);
  const project = (await call("POST", "/api/projects", { path: main })).json();

  const created = await call("POST", `/api/projects/${project.id}/worktrees`, { branch: " feat/x ", create: true });
  assert.equal(created.statusCode, 201, created.body);
  const wt = created.json().project;
  const wtPath = realpathSync(path.join(portalHome, "worktrees", "main", "feat-x"));
  assert.equal(wt.path, wtPath);
  assert.equal(wt.name, "feat/x");
  assert.deepEqual(wt.worktree, { parentId: project.id, branch: "feat/x" });
  assert.equal(wt.exists, true);
  assert.equal(wt.git.branch, "feat/x");

  const again = await call("POST", `/api/projects/${project.id}/worktrees`, { branch: "feat/x" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().project.id, wt.id);
  // From the worktree itself, a new worktree still belongs to the original project.
  const nested = await call("POST", `/api/projects/${wt.id}/worktrees`, { branch: "feat/y", create: true });
  assert.equal(nested.statusCode, 201);
  assert.equal(nested.json().project.worktree.parentId, project.id);
  const exists = await call("POST", `/api/projects/${project.id}/worktrees`, { branch: "feat/y", create: true });
  assert.equal(exists.statusCode, 409);
  const unknown = await call("POST", `/api/projects/${project.id}/worktrees`, { branch: "nope" });
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: "Branch nope does not exist." });

  const listing = await call("GET", `/api/projects/${wt.id}/branches`);
  assert.equal(listing.statusCode, 200, listing.body);
  const body = listing.json();
  assert.equal(body.defaultBranch, "main");
  assert.ok(body.branches.some((b) => b.name === "feat/x" && b.worktreePath === wtPath), JSON.stringify(body.branches));
  // The origin is a local folder, so gh has no GitHub repository to ask and answers offline.
  assert.equal(body.pulls, null);
  assert.equal(typeof body.pullsError, "string");
  assert.equal(body.repoWorktreesDir, path.join(portalHome, "worktrees", "main"));

  // A failing script with abortOnFailure stops the deletion and keeps the worktree.
  useScript({ command: "echo refusing >&2; exit 4" });
  const refused = await call("DELETE", `/api/projects/${wt.id}?worktree=delete`);
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error, /exited with code 4\.\nrefusing/);
  assert.ok(existsSync(wtPath));
  assert.ok(context().projects.get(wt.id));

  // Uncommitted changes: git refuses, the answer is marked dirty, and a forced retry goes through.
  useScript({ command: 'echo "$PORTAL_BRANCH $PORTAL_WORKTREE_PATH $PORTAL_REPO_ROOT $(pwd)" >> "$LOG"' });
  writeFileSync(path.join(wtPath, "untracked.txt"), "x");
  const dirty = await call("DELETE", `/api/projects/${wt.id}?worktree=delete`);
  assert.equal(dirty.statusCode, 409);
  assert.equal(dirty.json().dirty, true);
  const forced = await call("DELETE", `/api/projects/${wt.id}?worktree=delete&force=1`);
  assert.equal(forced.statusCode, 204, forced.body);
  assert.ok(!existsSync(wtPath));
  assert.equal(context().projects.get(wt.id), undefined);
  const runs = readFileSync(process.env.LOG, "utf8").trim().split("\n");
  assert.deepEqual(runs, Array(2).fill(`feat/x ${wtPath} ${main} ${wtPath}`), "runs in the worktree project's folder, again on the forced retry");
});

test("github routes read the checkout: summary, a bad log cursor, and a fast-forward pull", async (t) => {
  const { root, call } = await setup(t);
  const main = repo(root);
  const project = (await call("POST", "/api/projects", { path: main })).json();
  const summary = await call("GET", `/api/projects/${project.id}/github`);
  assert.equal(summary.statusCode, 200, summary.body);
  assert.equal(typeof summary.json().summary, "object");
  const log = await call("GET", `/api/projects/${project.id}/github/log?before=not-a-cursor`);
  assert.ok(log.statusCode >= 400 && log.statusCode < 500, log.body);
  assert.equal(typeof log.json().error, "string");
  const pulled = await call("POST", `/api/projects/${project.id}/github/pull`);
  assert.equal(pulled.statusCode, 200, pulled.body);
  assert.equal(typeof pulled.json().summary, "object");
});

test("removed projects: kept while conversations point at them, listed, restored, and deleted", async (t) => {
  const { root, portalHome, call, sessions, deleted, closedTerminals } = await setup(t);
  const main = repo(root);
  const project = (await call("POST", "/api/projects", { path: main })).json();
  const wt = (await call("POST", `/api/projects/${project.id}/worktrees`, { branch: "feat", create: true })).json().project;
  // Unmerged work, so deleting the worktree keeps the branch and the record stays restorable.
  git(wt.path, ["commit", "-q", "--allow-empty", "-m", "work"]);
  sessions.push(session("s1", wt.id, wt.path, 10), session("s2", wt.id, wt.path, 20), session("s3", "vanished", "/old/place", 5), session("s4", "", "/tmp/free", 6));

  // Deleting the worktree while conversations use it keeps a removed record.
  assert.equal((await call("DELETE", `/api/projects/${wt.id}?worktree=delete`)).statusCode, 204);
  assert.ok(!existsSync(wt.path));
  const listed = await call("GET", "/api/projects/removed");
  assert.equal(listed.statusCode, 200);
  const [row, ...orphans] = listed.json().removed;
  assert.deepEqual({ ...row, removedAt: typeof row.removedAt }, {
    id: wt.id, name: "feat", path: wt.path, displayPath: wt.path, worktree: { parentId: project.id, branch: "feat" },
    removedAt: "number", exists: false, parentName: project.name, sessionCount: 2, lastActiveAt: 20, restorable: true, reason: null,
  });
  assert.deepEqual(orphans.map((o) => [o.id, o.name, o.restorable]), [["vanished", "place", false], ["unassigned", "free", false]]);

  assert.deepEqual((await call("POST", "/api/projects/removed/nope/restore")).json(), { error: "Unknown removed project." });
  const restored = await call("POST", `/api/projects/removed/${wt.id}/restore`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().project.id, wt.id);
  assert.equal(restored.json().project.exists, true, "the worktree was recreated at its old folder");
  assert.ok(existsSync(path.join(portalHome, "worktrees", "main", "feat")));

  const listedAgain = await call("DELETE", `/api/projects/removed/${wt.id}`);
  assert.equal(listedAgain.statusCode, 409);
  assert.deepEqual(listedAgain.json(), { error: "This project is still listed." });

  // A plain project whose folder is gone cannot come back.
  const gone = path.join(root, "gone");
  mkdirSync(gone);
  const plain = (await call("POST", "/api/projects", { path: gone })).json();
  sessions.push(session("s5", plain.id, gone));
  assert.equal((await call("DELETE", `/api/projects/${plain.id}`)).statusCode, 204);
  rmSync(gone, { recursive: true });
  const blocked = await call("POST", `/api/projects/removed/${plain.id}/restore`);
  assert.equal(blocked.statusCode, 409);
  assert.deepEqual(blocked.json(), { error: `Project folder is missing: ${gone}` });
  const gonerow = (await call("GET", "/api/projects/removed")).json().removed.find((r) => r.id === plain.id);
  assert.equal(gonerow.reason, "The project folder is missing.");

  // Deleting a removed row deletes its conversations (closing their terminals) and forgets it.
  const forgot = await call("DELETE", `/api/projects/removed/${plain.id}`);
  assert.equal(forgot.statusCode, 204);
  assert.deepEqual(deleted, ["s5"]);
  assert.deepEqual(closedTerminals, ["s5"]);
  assert.equal(context().projects.getRemoved(plain.id), undefined);
  // The unassigned row stands for sessions with an empty project id.
  assert.equal((await call("DELETE", "/api/projects/removed/unassigned")).statusCode, 204);
  assert.deepEqual(deleted, ["s5", "s4"]);
  assert.deepEqual((await call("GET", "/api/projects/removed")).json().removed.map((r) => r.id), ["vanished"]);
});
