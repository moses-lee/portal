import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completePath, createRepoIndex, isPathQuery, rankHits, searchFolders, walkRepos } from "../src/lib/fs-search.ts";

/** A home folder with repositories at several depths, excluded trees, and a nested repository. */
function home(t) {
  // The folder's own name must not match the names searched for below.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pfs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    "repos/portal/.git", "repos/portal/packages/inner/.git", "repos/Portal-Docs/.git", "work/acme/api/.git",
    "node_modules/dep/.git", "Library/x/.git", ".config/secret/.git", "repos/plain", "deep/a/b/c/d/far/.git",
  ]) mkdirSync(path.join(root, dir), { recursive: true });
  // A worktree keeps `.git` as a file; it is a repository too.
  mkdirSync(path.join(root, "repos/wt"));
  writeFileSync(path.join(root, "repos/wt/.git"), "gitdir: elsewhere");
  return root;
}

test("isPathQuery reads absolute and home-relative queries as paths", () => {
  for (const q of ["/", "/usr", "~", "~/", "~/repos"]) assert.ok(isPathQuery(q), q);
  for (const q of ["", "portal", "~user", "repos/portal", "./x"]) assert.ok(!isPathQuery(q), q);
});

test("completePath lists the children of the typed folder's parent that start with its last segment", async (t) => {
  const root = home(t);
  const names = (hits) => hits.map((h) => h.name);
  assert.deepEqual(names(await completePath(path.join(root, "repos", "p"), { home: root })), ["plain", "portal", "Portal-Docs"]);
  assert.deepEqual(names(await completePath("~/repos/PORT", { home: root })), ["portal", "Portal-Docs"]);
  // A trailing slash offers the folder itself, then everything in it.
  assert.deepEqual(names(await completePath("~/repos/", { home: root })), ["repos", "plain", "portal", "Portal-Docs", "wt"]);
  const [self] = await completePath("~/repos/portal/", { home: root });
  assert.deepEqual(self, { name: "portal", path: path.join(root, "repos/portal"), displayPath: path.join(root, "repos/portal"), isGitRepo: true });
  // "~" alone names the home folder: it is offered first, then what is in it.
  assert.deepEqual(names(await completePath("~", { home: root })), [path.basename(root), "deep", "Library", "node_modules", "repos", "work"]);
  // A dot segment reveals hidden folders; a path to nothing completes to nothing.
  assert.deepEqual(names(await completePath("~/.", { home: root })), [".config"]);
  assert.deepEqual(await completePath("~/nowhere/x", { home: root }), []);
  assert.deepEqual(await completePath("relative", { home: root }), []);
  assert.equal((await completePath("~/repos/", { home: root, limit: 2 })).length, 2);
});

test("walkRepos finds repositories to the depth cap, skipping hidden and excluded trees and nested repositories", async (t) => {
  const root = home(t);
  const exclude = new Set(["node_modules", "Library"]);
  const found = await walkRepos({ root, depth: 4, exclude, maxDirs: 1000 });
  assert.deepEqual(found.map((h) => path.relative(root, h.path)).sort(), ["repos/Portal-Docs", "repos/portal", "repos/wt", "work/acme/api"]);
  assert.ok(found.every((h) => h.isGitRepo));
  const shallow = await walkRepos({ root, depth: 2, exclude, maxDirs: 1000 });
  assert.deepEqual(shallow.map((h) => path.relative(root, h.path)).sort(), ["repos/Portal-Docs", "repos/portal", "repos/wt"]);
  const deep = await walkRepos({ root, depth: 7, exclude, maxDirs: 1000 });
  assert.ok(deep.some((h) => h.path.endsWith("far")));
  // The folder cap bounds the walk: only the root is read here.
  assert.deepEqual(await walkRepos({ root, depth: 4, exclude, maxDirs: 1 }), []);
});

test("rankHits orders exact, prefix, and substring name matches before path matches", () => {
  const hit = (p) => ({ name: path.basename(p), path: p, displayPath: p, isGitRepo: true });
  const hits = [hit("/h/work/portal-tools"), hit("/h/x/myportal"), hit("/h/repos/portal"), hit("/h/portal-site/web"), hit("/h/other")];
  assert.deepEqual(rankHits(hits, "portal").map((h) => h.path), ["/h/repos/portal", "/h/work/portal-tools", "/h/x/myportal", "/h/portal-site/web"]);
  assert.deepEqual(rankHits(hits, "PORTAL site").map((h) => h.path), ["/h/portal-site/web"]);
  assert.deepEqual(rankHits(hits, "  "), []);
  assert.equal(rankHits(hits, "portal", 2).length, 2);
});

test("createRepoIndex walks once per TTL and answers stale queries from the last walk", async (t) => {
  const root = home(t);
  let clock = 0;
  const index = createRepoIndex({ root, depth: 3, exclude: new Set(["node_modules", "Library"]), ttlMs: 100, maxDirs: 1000, now: () => clock });
  assert.deepEqual(await index.search(""), []);
  assert.deepEqual((await index.search("portal")).map((h) => h.name), ["portal", "Portal-Docs"]);
  mkdirSync(path.join(root, "repos/portal-new/.git"), { recursive: true });
  // Within the TTL the new repository is not seen; past it, the stale answer is served and a walk is started.
  assert.deepEqual((await index.search("portal-new")).map((h) => h.name), []);
  clock = 200;
  assert.deepEqual((await index.search("portal-new")).map((h) => h.name), []);
  await index.refresh();
  assert.deepEqual((await index.search("portal-new")).map((h) => h.name), ["portal-new"]);
});

test("searchFolders completes paths and otherwise searches the index; a blank query only warms it", async (t) => {
  const root = home(t);
  let walks = 0;
  const index = { search: async (q) => [{ name: q, path: `/${q}`, displayPath: `/${q}`, isGitRepo: true }], refresh: async () => [], warm: () => { walks++; } };
  assert.deepEqual(await searchFolders("~/repos/po", index, { home: root }), {
    mode: "path",
    hits: [{ name: "portal", path: path.join(root, "repos/portal"), displayPath: path.join(root, "repos/portal"), isGitRepo: true }, { name: "Portal-Docs", path: path.join(root, "repos/Portal-Docs"), displayPath: path.join(root, "repos/Portal-Docs"), isGitRepo: true }],
  });
  assert.deepEqual(await searchFolders(" acme ", index, { home: root }), { mode: "name", hits: [{ name: "acme", path: "/acme", displayPath: "/acme", isGitRepo: true }] });
  assert.deepEqual(await searchFolders("", index, { home: root }), { mode: "name", hits: [] });
  assert.equal(walks, 1);
});
