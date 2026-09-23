import assert from "node:assert/strict";
import test from "node:test";
import { dropLegacyWorktreeNames, legacyProjectsFile, parseLegacyProjectsFile } from "../src/projects/legacy.ts";

const parent = { id: "p", name: "one", path: "/home/one", createdAt: 1 };

test("legacyProjectsFile sits in the Portal home", () => {
  assert.equal(legacyProjectsFile("/custom/portal"), "/custom/portal/projects.json");
});

test("parses a version-1 file, keeping only known fields", () => {
  const wt = { id: "w", name: "feat", path: "/home/two", createdAt: 2, worktree: { parentId: "p", branch: "feat", extra: 1 }, colour: "red" };
  const gone = { id: "g", name: "g", path: "/home/g", createdAt: 0, removedAt: 5, parentPath: "/home/one", junk: true };
  const parsed = parseLegacyProjectsFile(JSON.stringify({ version: 1, projects: [parent, wt], removed: [gone] }));
  assert.deepEqual(parsed, {
    projects: [parent, { id: "w", name: "feat", path: "/home/two", createdAt: 2, worktree: { parentId: "p", branch: "feat" } }],
    removed: [{ id: "g", name: "g", path: "/home/g", createdAt: 0, removedAt: 5, parentPath: "/home/one" }],
    droppedRemoved: 0,
  });
  assert.deepEqual(parseLegacyProjectsFile(JSON.stringify({ version: 1, projects: [] })), { projects: [], removed: [], droppedRemoved: 0 });
});

test("an unreadable or wrongly shaped file is null", () => {
  assert.equal(parseLegacyProjectsFile("{ not json"), null);
  assert.equal(parseLegacyProjectsFile(JSON.stringify({ version: 2, projects: [] })), null);
  assert.equal(parseLegacyProjectsFile(JSON.stringify({ version: 1, projects: [{ id: 1 }] })), null);
  for (const worktree of [null, "x", { parentId: 1, branch: "b" }, { parentId: "p" }]) {
    assert.equal(parseLegacyProjectsFile(JSON.stringify({ version: 1, projects: [{ ...parent, worktree }] })), null, `worktree ${JSON.stringify(worktree)}`);
  }
});

test("bad removed records are dropped one by one", () => {
  const a = { id: "a", name: "a", path: "/a", createdAt: 1, removedAt: 5 };
  const b = { id: "b", name: "b", path: "/b", createdAt: 2, removedAt: 9 };
  const parsed = parseLegacyProjectsFile(JSON.stringify({ version: 1, projects: [], removed: [a, { id: "bad" }, b, { ...a, id: "c", removedAt: "x" }] }));
  assert.deepEqual(parsed.removed, [a, b]);
  assert.equal(parsed.droppedRemoved, 2);
});

test("renames legacy \"<parent> · <branch>\" worktree projects to their branch", () => {
  const legacy = { id: "w", name: "one · feat/x", path: "/two", createdAt: 2, worktree: { parentId: "p", branch: "feat/x" } };
  const custom = { id: "c", name: "my thing", path: "/sub", createdAt: 3, worktree: { parentId: "p", branch: "feat/y" } };
  const orphan = { id: "o", name: "gone · feat/z", path: "/deep", createdAt: 4, worktree: { parentId: "gone", branch: "feat/z" } };
  const renamed = dropLegacyWorktreeNames([parent, legacy, custom, orphan]);
  assert.deepEqual(renamed.map((p) => p.name), ["one", "feat/x", "my thing", "gone · feat/z"]);
  assert.equal(dropLegacyWorktreeNames(renamed), null);
  assert.equal(dropLegacyWorktreeNames([]), null);
});
