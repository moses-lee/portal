import assert from "node:assert/strict";
import test from "node:test";
import { orderProjects } from "../src/lib/project-tree.ts";

function project(id, createdAt = 0, worktree) {
  return { id, name: id, path: `/repos/${id}`, createdAt, ...(worktree ? { worktree } : {}) };
}

const ids = (rows) => rows.map((p) => `${p.id}:${p.depth}`);

test("worktrees follow their parent at depth 1, oldest first", () => {
  const rows = orderProjects([
    project("a", 1),
    project("b", 2),
    project("b-new", 9, { parentId: "b", branch: "new" }),
    project("a-x", 5, { parentId: "a", branch: "x" }),
    project("b-old", 3, { parentId: "b", branch: "old" }),
  ]);
  assert.deepEqual(ids(rows), ["a:0", "a-x:1", "b:0", "b-old:1", "b-new:1"]);
});

test("projects without worktrees keep their order and get depth 0", () => {
  assert.deepEqual(ids(orderProjects([project("c"), project("a"), project("b")])), ["c:0", "a:0", "b:0"]);
  assert.deepEqual(orderProjects([]), []);
});

test("a worktree whose parent is gone stays in place at depth 0", () => {
  const rows = orderProjects([
    project("a", 1),
    project("orphan", 2, { parentId: "gone", branch: "x" }),
    project("b", 3),
  ]);
  assert.deepEqual(ids(rows), ["a:0", "orphan:0", "b:0"]);
});

test("a worktree whose parent is itself a worktree is not nested twice", () => {
  const rows = orderProjects([
    project("root", 1),
    project("child", 2, { parentId: "root", branch: "c" }),
    project("grandchild", 3, { parentId: "child", branch: "g" }),
    project("self", 4, { parentId: "self", branch: "s" }),
  ]);
  assert.deepEqual(ids(rows), ["root:0", "child:1", "grandchild:0", "self:0"]);
});

test("a worktree listed before its parent still nests under it", () => {
  const rows = orderProjects([
    project("a-x", 5, { parentId: "a", branch: "x" }),
    project("a", 1),
  ]);
  assert.deepEqual(ids(rows), ["a:0", "a-x:1"]);
});

test("keeps every field and does not mutate the input", () => {
  const input = [project("a", 1), project("a-x", 2, { parentId: "a", branch: "x" })];
  const rows = orderProjects(input);
  assert.deepEqual(rows[1].worktree, { parentId: "a", branch: "x" });
  assert.equal(rows[1].path, "/repos/a-x");
  assert.deepEqual(input.map((p) => p.id), ["a", "a-x"]);
  assert.ok(!("depth" in input[0]));
});
