import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathError } from "../src/lib/fs-paths.ts";
import { createPgProjectsStore } from "../src/projects/pg-store.ts";
import { ProjectError, createMemoryProjectsStore, summarizeProject } from "../src/projects/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

function folders(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  for (const dir of ["home/one", "home/two", "home/sub/deep"]) mkdirSync(path.join(root, dir), { recursive: true });
  return { root, home };
}

/**
 * Each backend gives `open()` for a store over its records; `reopen` is set where a second store
 * sees what the first wrote (Postgres), so persistence is checked there.
 */
const backends = [
  ["memory", async (t, home) => {
    const store = createMemoryProjectsStore({ home });
    return { open: () => store, reopen: null };
  }],
  ["postgres", async (t, home) => {
    const { db } = await temporaryDatabase(t);
    return { open: () => createPgProjectsStore({ db, home }), reopen: () => createPgProjectsStore({ db, home }), db };
  }],
];

async function rejectsWith(promise, status, check = () => {}) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    check(err);
    return true;
  });
}

async function opened(make) {
  const store = make();
  await store.ready;
  return store;
}

test("memory store: seeded records are listed in creation order", async () => {
  const a = { id: "a", name: "a", path: "/a", createdAt: 2 };
  const b = { id: "b", name: "b", path: "/b", createdAt: 1 };
  const gone = { id: "g", name: "g", path: "/g", createdAt: 0, removedAt: 3 };
  const store = createMemoryProjectsStore({ projects: [a, b], removed: [gone] });
  await store.ready;
  assert.deepEqual(store.list(), [b, a]);
  assert.equal(store.get("a"), a);
  assert.deepEqual(store.listRemoved(), [gone]);
});

for (const [name, make] of backends) {
  test(`${name} store: adds, renames, removes, and reloads projects`, async (t) => {
    const { home } = folders(t);
    const { open, reopen } = await make(t, home);
    const store = await opened(open);
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
    assert.deepEqual(store.list(), [renamed, two], "a rename keeps the list order");

    if (reopen) {
      const again = await opened(reopen);
      assert.deepEqual(again.list(), [renamed, two]);
    }

    await store.remove(one.id);
    assert.deepEqual(store.list(), [two]);
    if (reopen) assert.deepEqual((await opened(reopen)).list(), [two]);
  });

  test(`${name} store: dedupes by realpath, including through symlinks`, async (t) => {
    const { root, home } = folders(t);
    const store = await opened((await make(t, home)).open);
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

  test(`${name} store: rejects bad paths, unknown ids, and empty names`, async (t) => {
    const { home } = folders(t);
    const store = await opened((await make(t, home)).open);
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

  test(`${name} store: serializes concurrent adds of distinct and duplicate folders`, async (t) => {
    const { home } = folders(t);
    const dirs = Array.from({ length: 20 }, (_, i) => {
      const dir = path.join(home, `p${String(i).padStart(2, "0")}`);
      mkdirSync(dir);
      return dir;
    });
    const { open, reopen } = await make(t, home);
    const store = open();
    const added = await Promise.all(dirs.map((dir) => store.add({ path: dir })));
    assert.equal(new Set(added.map((p) => p.id)).size, 20);
    assert.equal(store.list().length, 20);
    // Racing adds of one folder: exactly one wins, the rest get the winner back on a 409.
    const races = await Promise.allSettled(Array.from({ length: 5 }, () => store.add({ path: path.join(home, "one") })));
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(races.every((r) => r.status === "fulfilled" || r.reason.status === 409));
    if (reopen) assert.deepEqual((await opened(reopen)).list().map((p) => p.path).sort(), [...dirs, path.join(home, "one")].sort());
  });

  test(`${name} store: summarizeProject reports display path, git state, and existence`, async (t) => {
    const { home } = folders(t);
    const store = await opened((await make(t, home)).open);
    const one = await store.add({ path: path.join(home, "one") });
    assert.deepEqual(await summarizeProject(one), { ...one, displayPath: one.path, git: null, exists: true });
    rmSync(one.path, { recursive: true });
    assert.deepEqual(await summarizeProject(one), { ...one, displayPath: one.path, git: null, exists: false });
  });

  test(`${name} store: persists worktree metadata without extra keys`, async (t) => {
    const { home } = folders(t);
    const { open, reopen } = await make(t, home);
    const store = await opened(open);
    const parent = await store.add({ path: path.join(home, "one") });
    const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat", extra: "ignored" } });
    assert.deepEqual(wt.worktree, { parentId: parent.id, branch: "feat" });
    assert.ok(!("worktree" in parent), "plain projects carry no worktree key");
    if (reopen) {
      const reloaded = await opened(reopen);
      assert.deepEqual(reloaded.get(wt.id), wt);
      assert.ok(!("worktree" in reloaded.get(parent.id)), "a null column comes back as no key");
    }
  });

  test(`${name} store: remove with keep leaves a restorable record; restore brings the project back under its id`, async (t) => {
    const { home } = folders(t);
    const { open, reopen } = await make(t, home);
    const store = await opened(open);
    const parent = await store.add({ path: path.join(home, "one") });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
    await tick();
    const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
    // Distinct creation times: the list is ordered by them, ties falling back to insertion order.
    await tick();
    const later = await store.add({ path: path.join(home, "sub") });

    await store.remove(wt.id, { keep: true });
    assert.deepEqual(store.list(), [parent, later]);
    assert.equal(store.get(wt.id), undefined);
    const record = store.getRemoved(wt.id);
    assert.ok(record && typeof record.removedAt === "number");
    assert.deepEqual({ ...record, removedAt: undefined }, { ...wt, parentPath: parent.path, removedAt: undefined });

    const target = reopen ? await opened(reopen) : store;
    assert.deepEqual(target.listRemoved(), [record]);
    const restored = await target.restore(wt.id);
    assert.deepEqual(restored, wt, "the restored project carries no removal fields");
    assert.deepEqual(target.list(), [parent, wt, later], "a restored project returns to its original slot");
    assert.deepEqual(target.listRemoved(), []);
    if (reopen) {
      const third = await opened(reopen);
      assert.deepEqual(third.list(), [parent, wt, later]);
      assert.deepEqual(third.listRemoved(), []);
    }
  });

  test(`${name} store: remove without keep forgets the project; restore and forget on unknown ids`, async (t) => {
    const { home } = folders(t);
    const store = await opened((await make(t, home)).open);
    const one = await store.add({ path: path.join(home, "one") });
    await store.remove(one.id);
    assert.deepEqual(store.listRemoved(), []);
    await rejectsWith(store.restore(one.id), 404);
    assert.equal(await store.forgetRemoved(one.id), false);
  });

  test(`${name} store: restore refuses a missing folder or a covered path; forgetRemoved drops the record`, async (t) => {
    const { home } = folders(t);
    const { open, reopen } = await make(t, home);
    const store = await opened(open);
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
    if (reopen) {
      const reloaded = await opened(reopen);
      assert.deepEqual(reloaded.list(), []);
      assert.deepEqual(reloaded.listRemoved(), []);
    }
  });

  test(`${name} store: adding a worktree at a removed project's path revives it with the new worktree details`, async (t) => {
    const { home } = folders(t);
    const store = await opened((await make(t, home)).open);
    const parent = await store.add({ path: path.join(home, "one") });
    const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
    await store.remove(wt.id, { keep: true });
    const again = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
    assert.deepEqual(again, wt);
    assert.deepEqual(store.list().map((p) => p.id), [parent.id, wt.id]);
  });

  test(`${name} store: restore can point a worktree at a re-added parent; plain add keeps a revived worktree's details`, async (t) => {
    const { home } = folders(t);
    const { open, reopen } = await make(t, home);
    const store = await opened(open);
    const parent = await store.add({ path: path.join(home, "one") });
    const wt = await store.add({ path: path.join(home, "two"), name: "feat", worktree: { parentId: parent.id, branch: "feat" } });
    await store.remove(wt.id, { keep: true });
    const restored = await store.restore(wt.id, { worktree: { parentId: "new-parent", branch: "feat" } });
    assert.deepEqual(restored.worktree, { parentId: "new-parent", branch: "feat" });

    await store.remove(wt.id, { keep: true });
    assert.equal(store.getRemoved(wt.id).parentPath, undefined, "no listed parent, so no parent path");
    const revived = await store.add({ path: path.join(home, "two") });
    assert.equal(revived.id, wt.id);
    assert.deepEqual(revived.worktree, { parentId: "new-parent", branch: "feat" });
    if (reopen) assert.deepEqual((await opened(reopen)).get(wt.id), revived);
  });

  test(`${name} store: removed records are listed newest first`, async (t) => {
    const { home } = folders(t);
    const { open, reopen } = await make(t, home);
    const store = await opened(open);
    const ids = [];
    for (const dir of ["one", "two", "sub"]) {
      const project = await store.add({ path: path.join(home, dir) });
      ids.push(project.id);
      await store.remove(project.id, { keep: true });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    assert.deepEqual(store.listRemoved().map((r) => r.id), ids.reverse());
    if (reopen) assert.deepEqual((await opened(reopen)).listRemoved().map((r) => r.id), ids);
  });
}

test("postgres store: a failed write leaves the cache untouched", async (t) => {
  const { home } = folders(t);
  const { db } = await temporaryDatabase(t);
  const store = await opened(() => createPgProjectsStore({ db, home }));
  const one = await store.add({ path: path.join(home, "one") });
  await db.execute("alter table projects add constraint no_renames check (name <> 'Forbidden')");
  await assert.rejects(store.rename(one.id, "Forbidden"));
  assert.equal(store.get(one.id).name, "one");
  // The chain recovers: later writes still go through.
  assert.equal((await store.rename(one.id, "Fine")).name, "Fine");
});
