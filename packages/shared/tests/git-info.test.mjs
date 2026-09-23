import assert from "node:assert/strict";
import test from "node:test";
import { sameGitInfo } from "../src/git-info.ts";

test("compares git info by repository and branch", () => {
  const a = { root: "/r", displayRoot: "/r", branch: "main", detached: false };
  assert.ok(sameGitInfo(null, null));
  assert.ok(sameGitInfo(a, { ...a }));
  assert.ok(!sameGitInfo(a, null));
  assert.ok(!sameGitInfo(a, { ...a, branch: "dev" }));
  assert.ok(!sameGitInfo(a, { ...a, detached: true }));
});
