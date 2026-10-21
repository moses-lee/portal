import assert from "node:assert/strict";
import test from "node:test";
import { isRemovedSession } from "../src/lib/removed-session.ts";

test("removed status requires known missing project metadata, including legacy unassigned sessions", () => {
  assert.equal(isRemovedSession(undefined), false);
  assert.equal(isRemovedSession({ projectId: "p1" }), false);
  assert.equal(isRemovedSession({ projectId: "", project: null }), true);
  assert.equal(isRemovedSession({ projectId: "p1", project: null }), true);
  assert.equal(isRemovedSession({ projectId: "p1", project: { id: "p1", name: "Restored" } }), false);
});
