import assert from "node:assert/strict";
import test from "node:test";
import { emptyScope } from "../src/orchestrator/types.ts";
import { widenScope } from "../src/orchestrator/turn.ts";

const world = {
  sessions: [{ id: "s1", projectId: "p2" }, { id: "s2", projectId: "" }],
  projects: [{ id: "p1", repo: "acme/app" }, { id: "p2", repo: "acme/web" }, { id: "p3", repo: null }],
};

test("widenScope adds the projects behind sessions and the repos behind projects and pulls, and drops nothing", () => {
  const scope = { ...emptyScope(), sessionIds: ["s1", "s2", "gone"], projectIds: ["p1", "p3"], pulls: [{ repo: "acme/api", number: 7, url: "u" }], people: ["someone"] };
  const wide = widenScope(scope, world);
  assert.deepEqual(wide.projectIds, ["p1", "p3", "p2"]);
  assert.deepEqual(wide.repos, ["acme/app", "acme/web", "acme/api"]);
  assert.deepEqual(wide.sessionIds, ["s1", "s2", "gone"]);
  assert.deepEqual(wide.people, ["someone"]);
  assert.deepEqual(widenScope(emptyScope(), world), emptyScope());
});
