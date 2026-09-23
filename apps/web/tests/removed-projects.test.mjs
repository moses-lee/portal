import assert from "node:assert/strict";
import test from "node:test";
import { UNASSIGNED_ID, parentOf, projectIdOfRow, restoreBlocker, summarizeOrphans, summarizeRemoved } from "../src/lib/removed-projects.ts";

const parent = { id: "p", name: "monorepo", path: "/repos/monorepo", createdAt: 1 };
const worktree = {
  id: "w", name: "feat/x", path: "/portal/worktrees/monorepo/feat-x", createdAt: 2,
  worktree: { parentId: "p", branch: "feat/x" }, removedAt: 10,
};
const plain = { id: "q", name: "tools", path: "/repos/tools", createdAt: 3, removedAt: 20 };
const lookup = (projects = [parent], removed = []) => ({
  project: (id) => projects.find((p) => p.id === id),
  projectByPath: (path) => projects.find((p) => p.path === path),
  removed: (id) => removed.find((p) => p.id === id),
  displayPath: (dir) => dir.replace("/repos", "~/repos"),
});
const facts = (overrides = {}) => ({ exists: false, branchExists: null, parentExists: null, ...overrides });
const session = (projectId, lastActiveAt, cwd = "/x") => ({ projectId, lastActiveAt, createdAt: lastActiveAt, cwd });

test("a removed project whose folder still exists is restorable", () => {
  assert.equal(restoreBlocker(plain, facts({ exists: true }), lookup()), null);
  assert.equal(restoreBlocker(worktree, facts({ exists: true, branchExists: false }), lookup()), null);
});

test("a plain project with a missing folder cannot be restored", () => {
  assert.equal(restoreBlocker(plain, facts(), lookup()), "The project folder is missing.");
});

test("a missing worktree needs its listed parent and its branch", () => {
  assert.equal(restoreBlocker(worktree, facts({ parentExists: true, branchExists: true }), lookup()), null);
  assert.equal(restoreBlocker(worktree, facts(), lookup([])), "Its original project was removed from Portal.");
  assert.equal(restoreBlocker(worktree, facts(), lookup([], [{ ...parent, removedAt: 5 }])), "Restore monorepo first.");
  assert.equal(restoreBlocker(worktree, facts({ parentExists: false }), lookup()), "The folder of monorepo is missing.");
  assert.equal(restoreBlocker(worktree, facts({ parentExists: true, branchExists: false }), lookup()), "Branch feat/x no longer exists in monorepo.");
});

test("a re-added parent is found by its recorded folder when the id no longer matches", () => {
  const readded = { ...parent, id: "p2" };
  const withPath = { ...worktree, parentPath: parent.path };
  assert.equal(parentOf(withPath, lookup([readded])), readded);
  assert.equal(parentOf(worktree, lookup([readded])), undefined);
  assert.equal(restoreBlocker(withPath, facts({ parentExists: true, branchExists: true }), lookup([readded])), null);
  assert.equal(summarizeRemoved(withPath, facts(), [], lookup([readded])).parentName, "monorepo");
});

test("summarizeRemoved carries the record, parent name, session count, and newest activity", () => {
  const summary = summarizeRemoved(worktree, facts({ parentExists: true, branchExists: true }), [session("w", 5), session("w", 9)], lookup());
  assert.deepEqual(summary, {
    id: "w", name: "feat/x", path: worktree.path, displayPath: worktree.path,
    worktree: { parentId: "p", branch: "feat/x" }, removedAt: 10, exists: false, parentName: "monorepo",
    sessionCount: 2, lastActiveAt: 9, restorable: true, reason: null,
  });
  const none = summarizeRemoved(plain, facts({ exists: true }), [], lookup());
  assert.equal(none.sessionCount, 0);
  assert.equal(none.lastActiveAt, null);
  assert.equal(none.displayPath, "~/repos/tools");
  assert.ok(!("worktree" in none));
});

test("orphaned sessions group by project id into unrestorable rows named after their folder", () => {
  const rows = summarizeOrphans(
    [session("p", 1, "/repos/monorepo"), session("gone", 3, "/old/a"), session("gone", 7, "/old/b"), session("", 2, "/repos/loose")],
    (id) => id === "p",
    (dir) => dir,
  );
  assert.deepEqual(rows.map((row) => [row.id, row.name, row.path, row.sessionCount, row.lastActiveAt]), [
    ["gone", "b", "/old/b", 2, 7],
    [UNASSIGNED_ID, "loose", "/repos/loose", 1, 2],
  ]);
  for (const row of rows) {
    assert.equal(row.restorable, false);
    assert.equal(row.removedAt, null);
    assert.equal(row.reason, "Portal has no record of this project.");
  }
  assert.equal(projectIdOfRow(UNASSIGNED_ID), "");
  assert.equal(projectIdOfRow("gone"), "gone");
});
