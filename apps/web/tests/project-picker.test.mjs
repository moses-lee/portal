import assert from "node:assert/strict";
import test from "node:test";
import { matchesProject, rankProjectRows, rowHeading } from "../src/lib/project-picker.ts";

const project = (id, name, path, extra = {}) => ({
  id, name, path, displayPath: path.replace("/home/me", "~"), createdAt: 1, pinnedAt: null, keptReason: null, git: null, exists: true, ...extra,
});
const hit = (path) => ({ name: path.split("/").pop(), path, displayPath: path, isGitRepo: true });

const portal = project("p1", "portal", "/home/me/repos/portal");
const wt = project("p2", "improve-chat", "/home/me/.portal/worktrees/portal/improve-chat", { worktree: { parentId: "p1", branch: "feat/improve-chat" } });
const docs = project("p3", "Docs", "/home/me/work/docs");

test("matchesProject matches every word against the name, paths, and worktree branch", () => {
  assert.ok(matchesProject(portal, ""));
  assert.ok(matchesProject(portal, "port"));
  assert.ok(matchesProject(portal, "repos portal"));
  assert.ok(matchesProject(docs, "work doc"));
  assert.ok(matchesProject(wt, "feat/improve"));
  assert.ok(!matchesProject(portal, "docs"));
});

test("rankProjectRows keeps the given order, sections pinned projects, and appends unlisted folders", () => {
  const rows = rankProjectRows([docs, portal, wt], { p3: 1 }, "", [hit("/home/me/repos/portal"), hit("/home/me/repos/other")]);
  assert.deepEqual(rows.map((r) => (r.kind === "project" ? `${r.section}:${r.project.id}` : `folder:${r.hit.name}`)), [
    "pinned:p3", "recent:p1", "recent:p2", "folder:other",
  ]);
  const filtered = rankProjectRows([docs, portal, wt], {}, "  PORTAL ", [hit("/home/me/repos/portal-site"), hit("/home/me/repos/portal-site")]);
  assert.deepEqual(filtered.map((r) => (r.kind === "project" ? r.project.id : r.hit.name)), ["p1", "p2", "portal-site"]);
  assert.deepEqual(rankProjectRows([], {}, "x", []), []);
});

test("rowHeading opens Pinned/Recent sections for a blank query and Projects/Folders otherwise", () => {
  const rows = rankProjectRows([docs, portal], { p3: 1 }, "", [hit("/x/y")]);
  assert.deepEqual(rows.map((row, i) => rowHeading(row, rows[i - 1], "")), ["Pinned", "Recent", "Folders"]);
  const searched = rankProjectRows([docs, portal], { p3: 1 }, "o", [hit("/x/o")]);
  assert.deepEqual(searched.map((row, i) => rowHeading(row, searched[i - 1], "o")), ["Projects", null, "Folders"]);
});
