import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathError, errorStatus, expandHome, listDirectories, parentDirectory, resolveDirectory } from "../src/lib/fs-paths.ts";

/** dirs, files, dotfiles, symlinks (dir, file, broken) and a child git repo. */
function tree(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-fs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["alpha", "Beta", "gamma/.git", ".hidden", "zeta/nested"]) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, "file.txt"), "x");
  writeFileSync(path.join(root, ".dotfile"), "x");
  symlinkSync(path.join(root, "alpha"), path.join(root, "link-dir"));
  symlinkSync(path.join(root, "file.txt"), path.join(root, "link-file"));
  symlinkSync(path.join(root, "does-not-exist"), path.join(root, "broken"));
  return root;
}

async function rejectsWith(promise, status) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PathError, `expected PathError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(errorStatus(err), status);
    return true;
  });
}

test("expandHome handles only ~ and ~/", () => {
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~/", "/home/u"), "/home/u");
  assert.equal(expandHome("~/a/b", "/home/u"), "/home/u/a/b");
  assert.equal(expandHome("~other/x", "/home/u"), "~other/x");
  assert.equal(expandHome("/abs", "/home/u"), "/abs");
  assert.equal(expandHome("rel", "/home/u"), "rel");
  assert.equal(expandHome("~"), os.homedir());
});

test("resolveDirectory expands, realpaths, and rejects bad input with HTTP statuses", async (t) => {
  const root = tree(t);
  assert.equal(await resolveDirectory(root), root);
  assert.equal(await resolveDirectory(root + "/alpha/../Beta/"), path.join(root, "Beta"));
  assert.equal(await resolveDirectory(path.join(root, "link-dir")), path.join(root, "alpha"));
  assert.equal(await resolveDirectory("~/alpha", root), path.join(root, "alpha"));
  assert.equal(await resolveDirectory("~", root), root);
  await rejectsWith(resolveDirectory("relative/path", root), 400);
  await rejectsWith(resolveDirectory("~user/x", root), 400);
  await rejectsWith(resolveDirectory(""), 400);
  await rejectsWith(resolveDirectory(path.join(root, "file.txt")), 400);
  await rejectsWith(resolveDirectory(path.join(root, "link-file")), 400);
  await rejectsWith(resolveDirectory(path.join(root, "missing")), 404);
  await rejectsWith(resolveDirectory(path.join(root, "broken")), 404);
  await rejectsWith(resolveDirectory(path.join(root, "file.txt", "below")), 404);
});

test("listDirectories returns only directories, sorted, with git markers and parent", async (t) => {
  const root = tree(t);
  const listing = await listDirectories(root);
  assert.equal(listing.path, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["alpha", "Beta", "gamma", "link-dir", "zeta"]);
  assert.deepEqual(listing.entries.map((entry) => entry.isGitRepo), [false, false, true, false, false]);
  assert.equal(listing.entries[3].path, path.join(root, "link-dir"));

  const withHidden = await listDirectories(root, { hidden: true });
  assert.deepEqual(withHidden.entries.map((entry) => entry.name), [".hidden", "alpha", "Beta", "gamma", "link-dir", "zeta"]);

  const capped = await listDirectories(root, { limit: 2 });
  assert.deepEqual(capped.entries.map((entry) => entry.name), ["alpha", "Beta"]);

  assert.deepEqual((await listDirectories(path.join(root, "alpha"))).entries, []);
  await rejectsWith(listDirectories(path.join(root, "missing")), 404);
});

test("unreadable directories surface as 403", { skip: process.getuid?.() === 0 && "runs as root" }, async (t) => {
  const root = tree(t);
  const locked = path.join(root, "locked");
  mkdirSync(path.join(locked, "inner"), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    await rejectsWith(listDirectories(locked), 403);
    await rejectsWith(resolveDirectory(path.join(locked, "inner")), 403);
  } finally {
    chmodSync(locked, 0o755); // before tree()'s rmSync hook, which cannot empty a 000 directory
  }
});

test("parentDirectory stops at the root", () => {
  assert.equal(parentDirectory("/"), null);
  assert.equal(parentDirectory("/a"), "/");
  assert.equal(parentDirectory("/a/b"), "/a");
});

test("errorStatus only trusts HTTP-like statuses on errors", () => {
  assert.equal(errorStatus(new Error("plain")), null);
  assert.equal(errorStatus(Object.assign(new Error("odd"), { status: 12 })), null);
  assert.equal(errorStatus({ status: 404 }), null);
  assert.equal(errorStatus(Object.assign(new Error("dup"), { status: 409 })), 409);
});
