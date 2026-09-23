import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathError } from "../src/lib/fs-paths.ts";
import { ProjectError, createProjectsStore, defaultProjectsFile, dropLegacyWorktreeNames, summarizeProject } from "../src/lib/projects-store.ts";

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  for (const dir of ["home/one", "home/two", "home/sub/deep"]) mkdirSync(path.join(root, dir), { recursive: true });
  // The store's parent directory (like a fresh PORTAL_HOME) does not exist yet.
  const file = path.join(root, "portal-home", "projects.json");
  return { root, home, file, open: () => createProjectsStore({ file, home }) };
}

async function rejectsWith(promise, status, check = () => {}) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    check(err);
    return true;
  });
}

test("defaultProjectsFile honours PORTAL_HOME", () => {
  const previous = process.env.PORTAL_HOME;
  try {
    delete process.env.PORTAL_HOME;
    assert.equal(defaultProjectsFile(), path.join(os.homedir(), ".portal", "projects.json"));
    process.env.PORTAL_HOME = "/custom/portal";
    assert.equal(defaultProjectsFile(), path.join("/custom/portal", "projects.json"));
  } finally {
    if (previous === undefined) delete process.env.PORTAL_HOME; else process.env.PORTAL_HOME = previous;
  }
});

test("adds, renames, removes, and reloads projects from disk", async (t) => {
  const { home, file, open } = setup(t);
  const store = open();
  await store.ready;
  assert.deepEqual(store.list(), []);

  const one = await store.add({ path: path.join(home, "one") });
  assert.equal(one.name, "one");
  assert.equal(one.path, path.join(home, "one"));
  assert.match(one.id, /^[0-9a-f-]{36}$/);
  assert.ok(typeof one.createdAt === "number");
  const two = await store.add({ path: "~/two", name: "  Second  " });
  assert.equal(two.name, "Second");
  assert.equal(two.path, path.join(home, "two"));

  assert.deepEqual(store.list().map((p) => p.id), [one.id, two.id]);
  assert.equal(store.get(one.id), one);
  assert.equal(store.findByPath(path.join(home, "two")), two);
  assert.equal(store.findByPath(path.join(home, "nope")), undefined);

  const renamed = await store.rename(one.id, "First");
  assert.equal(renamed.name, "First");
  assert.equal(store.get(one.id).name, "First");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, projects: [renamed, two] });
  assert.ok(existsSync(path.dirname(file)), "parent directory created");

  const again = open();
  await again.ready;
  assert.deepEqual(again.list(), [renamed, two]);

  await store.remove(one.id);
  assert.deepEqual(store.list(), [two]);
  const third = open();
  await third.ready;
  assert.deepEqual(third.list(), [two]);
});

test("dedupes by realpath, including through symlinks", async (t) => {
  const { root, home, open } = setup(t);
  const store = open();
  const one = await store.add({ path: path.join(home, "one") });
  await rejectsWith(store.add({ path: path.join(home, "one") + "/" }), 409, (err) => {
    assert.ok(err instanceof ProjectError);
    assert.deepEqual(err.project, one);
  });
  symlinkSync(path.join(home, "one"), path.join(root, "one-link"));
  await rejectsWith(store.add({ path: path.join(root, "one-link"), name: "Alias" }), 409, (err) => {
    assert.deepEqual(err.project, one);
  });
  assert.equal(store.list().length, 1);
});

test("rejects bad paths, unknown ids, and empty names", async (t) => {
  const { home, open } = setup(t);
  const store = open();
  await rejectsWith(store.add({ path: "relative" }), 400, (err) => assert.ok(err instanceof PathError));
  await rejectsWith(store.add({ path: path.join(home, "missing") }), 404);
  writeFileSync(path.join(home, "file"), "x");
  await rejectsWith(store.add({ path: path.join(home, "file") }), 400);
  await rejectsWith(store.rename("nope", "x"), 404, (err) => assert.ok(err instanceof ProjectError));
  await rejectsWith(store.remove("nope"), 404);
  const one = await store.add({ path: "~/sub/deep" });
  assert.equal(one.path, path.join(home, "sub", "deep"));
  await rejectsWith(store.rename(one.id, "   "), 400);
  assert.equal(store.get(one.id).name, "deep");
});

test("serializes concurrent adds and leaves no temp files behind", async (t) => {
  const { home, file, open } = setup(t);
  const dirs = Array.from({ length: 20 }, (_, i) => {
    const dir = path.join(home, `p${String(i).padStart(2, "0")}`);
    mkdirSync(dir);
    return dir;
  });
  const store = open();
  const added = await Promise.all(dirs.map((dir) => store.add({ path: dir })));
  assert.equal(new Set(added.map((p) => p.id)).size, 20);
  assert.equal(store.list().length, 20);
  assert.deepEqual(readdirSync(path.dirname(file)), ["projects.json"]);
  const reloaded = open();
  await reloaded.ready;
  assert.deepEqual(reloaded.list().map((p) => p.path).sort(), dirs);
});

test("a corrupt file loads empty, warns, and is backed up on the first write", async (t) => {
  const { home, file, open } = setup(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "{ not json");
  const warn = t.mock.method(console, "warn", () => {});
  const store = open();
  await store.ready;
  assert.deepEqual(store.list(), []);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(readdirSync(path.dirname(file)), ["projects.json"], "nothing is written until a change");

  const one = await store.add({ path: path.join(home, "one") });
  const names = readdirSync(path.dirname(file)).sort();
  assert.equal(names.length, 2);
  const backup = names.find((name) => name.startsWith("projects.json.bad-"));
  assert.ok(backup, `expected a .bad- backup in ${names}`);
  assert.equal(readFileSync(path.join(path.dirname(file), backup), "utf8"), "{ not json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, projects: [one] });

  // A well-formed file with the wrong shape is treated the same way.
  writeFileSync(file, JSON.stringify({ version: 2, projects: [{ id: 1 }] }));
  const other = open();
  await other.ready;
  assert.deepEqual(other.list(), []);
  assert.equal(warn.mock.callCount(), 2);
});

test("summarizeProject reports display path, git state, and existence", async (t) => {
  const { home, open } = setup(t);
  const store = open();
  const one = await store.add({ path: path.join(home, "one") });
  const summary = await summarizeProject(one);
  assert.deepEqual(summary, { ...one, displayPath: one.path, git: null, exists: true });
  rmSync(one.path, { recursive: true });
  assert.deepEqual(await summarizeProject(one), { ...one, displayPath: one.path, git: null, exists: false });
});

test("persists worktree metadata and rejects malformed worktree values on load", async (t) => {
  const { home, file, open } = setup(t);
  const store = open();
  const parent = await store.add({ path: path.join(home, "one") });
  const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat", extra: "ignored" } });
  assert.deepEqual(wt.worktree, { parentId: parent.id, branch: "feat" });
  assert.equal(parent.worktree, undefined);
  assert.ok(!("worktree" in parent), "plain projects carry no worktree key");
  const reloaded = open();
  await reloaded.ready;
  assert.deepEqual(reloaded.get(wt.id), wt);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).projects[1].worktree, { parentId: parent.id, branch: "feat" });

  const warn = t.mock.method(console, "warn", () => {});
  for (const worktree of [null, "x", { parentId: 1, branch: "b" }, { parentId: "p" }]) {
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ ...parent, worktree }] }));
    const bad = open();
    await bad.ready;
    assert.deepEqual(bad.list(), [], `worktree ${JSON.stringify(worktree)} should be rejected`);
  }
  assert.equal(warn.mock.callCount(), 4);
  // Unknown extra keys on a project are still tolerated.
  writeFileSync(file, JSON.stringify({ version: 1, projects: [{ ...parent, colour: "red" }] }));
  const lenient = open();
  await lenient.ready;
  assert.equal(lenient.list().length, 1);
});

test("renames legacy \"<parent> · <branch>\" worktree projects to their branch on load", async (t) => {
  const { home, file, open } = setup(t);
  const parent = { id: "p", name: "one", path: path.join(home, "one"), createdAt: 1 };
  const legacy = { id: "w", name: "one · feat/x", path: path.join(home, "two"), createdAt: 2, worktree: { parentId: "p", branch: "feat/x" } };
  const custom = { id: "c", name: "my thing", path: path.join(home, "sub"), createdAt: 3, worktree: { parentId: "p", branch: "feat/y" } };
  const orphan = { id: "o", name: "gone · feat/z", path: path.join(home, "sub", "deep"), createdAt: 4, worktree: { parentId: "gone", branch: "feat/z" } };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, projects: [parent, legacy, custom, orphan] }));

  const store = open();
  await store.ready;
  assert.deepEqual(store.list().map((p) => p.name), ["one", "feat/x", "my thing", "gone · feat/z"]);
  // The rename is persisted, so the next load has nothing to do.
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).projects.map((p) => p.name), ["one", "feat/x", "my thing", "gone · feat/z"]);
  assert.equal(dropLegacyWorktreeNames(store.list()), null);
  assert.equal(dropLegacyWorktreeNames([]), null);
});

test("remove with keep leaves a restorable record; restore brings the project back under its id", async (t) => {
  const { home, file, open } = setup(t);
  const store = open();
  const parent = await store.add({ path: path.join(home, "one") });
  const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });

  await store.remove(wt.id, { keep: true });
  assert.deepEqual(store.list(), [parent]);
  assert.equal(store.get(wt.id), undefined);
  const record = store.getRemoved(wt.id);
  assert.ok(record && typeof record.removedAt === "number");
  assert.deepEqual({ ...record, removedAt: undefined }, { ...wt, parentPath: parent.path, removedAt: undefined });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).removed, [record]);

  const reloaded = open();
  await reloaded.ready;
  assert.deepEqual(reloaded.listRemoved(), [record]);

  const restored = await reloaded.restore(wt.id);
  assert.deepEqual(restored, wt, "the restored project carries no removal fields");
  assert.deepEqual(reloaded.list(), [parent, wt]);
  assert.deepEqual(reloaded.listRemoved(), []);
  assert.equal("removed" in JSON.parse(readFileSync(file, "utf8")), false, "an empty removed list is not written");
});

test("remove without keep forgets the project; restore and forget on unknown ids", async (t) => {
  const { home, open } = setup(t);
  const store = open();
  const one = await store.add({ path: path.join(home, "one") });
  await store.remove(one.id);
  assert.deepEqual(store.listRemoved(), []);
  await rejectsWith(store.restore(one.id), 404);
  assert.equal(await store.forgetRemoved(one.id), false);
});

test("restore refuses a missing folder or a path another project now covers; forgetRemoved drops the record", async (t) => {
  const { home, open } = setup(t);
  const store = open();
  const one = await store.add({ path: path.join(home, "one") });
  await store.remove(one.id, { keep: true });
  rmSync(one.path, { recursive: true });
  await rejectsWith(store.restore(one.id), 409, (err) => assert.match(err.message, /folder is missing/));
  mkdirSync(one.path);
  const other = await store.add({ path: one.path, name: "Other" });
  // Re-adding the same folder revives the removed record instead of creating a new project.
  assert.equal(other.id, one.id);
  assert.equal(other.name, "Other");
  assert.deepEqual(store.listRemoved(), []);

  await store.remove(other.id, { keep: true });
  assert.equal(await store.forgetRemoved(other.id), true);
  assert.deepEqual(store.listRemoved(), []);
  assert.equal(store.get(other.id), undefined);
});

test("adding a worktree at a removed project's path revives it with the new worktree details", async (t) => {
  const { home, open } = setup(t);
  const store = open();
  const parent = await store.add({ path: path.join(home, "one") });
  const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
  await store.remove(wt.id, { keep: true });
  const again = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
  assert.deepEqual(again, wt);
  assert.deepEqual(store.list().map((p) => p.id), [parent.id, wt.id]);
});

test("restore can point a worktree at a re-added parent; plain add keeps a revived worktree's details", async (t) => {
  const { home, open } = setup(t);
  const store = open();
  const parent = await store.add({ path: path.join(home, "one") });
  const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
  await store.remove(wt.id, { keep: true });
  const restored = await store.restore(wt.id, { worktree: { parentId: "new-parent", branch: "feat" } });
  assert.deepEqual(restored.worktree, { parentId: "new-parent", branch: "feat" });

  await store.remove(wt.id, { keep: true });
  const revived = await store.add({ path: path.join(home, "two") });
  assert.equal(revived.id, wt.id);
  assert.deepEqual(revived.worktree, { parentId: "new-parent", branch: "feat" });
});

test("removed records are sorted newest first and bad ones are dropped on load", async (t) => {
  const { home, file, open } = setup(t);
  const a = { id: "a", name: "a", path: path.join(home, "one"), createdAt: 1, removedAt: 5 };
  const b = { id: "b", name: "b", path: path.join(home, "two"), createdAt: 2, removedAt: 9 };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, projects: [], removed: [a, { id: "bad" }, b, { ...a, id: "c", removedAt: "x" }] }));
  const warn = t.mock.method(console, "warn", () => {});
  const store = open();
  await store.ready;
  assert.deepEqual(store.listRemoved(), [b, a]);
  assert.equal(warn.mock.callCount(), 2);
});
