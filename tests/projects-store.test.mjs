import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathError } from "../src/lib/fs-paths.ts";
import { ProjectError, createProjectsStore, defaultProjectsFile, summarizeProject } from "../src/lib/projects-store.ts";

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
