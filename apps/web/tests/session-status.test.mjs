import assert from "node:assert/strict";
import test from "node:test";
import { sessionStatusLabel } from "../src/lib/session-status.ts";

test("the header reads hung and background as the sidebar does, else the activity's label", () => {
  assert.equal(sessionStatusLabel("idle", "finished"), "Ready");
  assert.equal(sessionStatusLabel("working", "working"), "Working");
  assert.equal(sessionStatusLabel("waiting", "approval"), "Needs your approval");
  assert.equal(sessionStatusLabel("working", "background"), "Background");
  assert.equal(sessionStatusLabel("error", "hung"), "Hung");
  assert.equal(sessionStatusLabel("error", "offline"), "Needs attention");
  // A failed last turn still reads as needing attention while background work runs.
  assert.equal(sessionStatusLabel("error", "background"), "Needs attention");
});

test("background task titles follow the label when any run", () => {
  const tasks = [{ title: "bazel test //..." }, { title: "  " }, { title: "npm run dev" }];
  assert.equal(sessionStatusLabel("working", "background", tasks), "Background · bazel test //..., npm run dev");
  assert.equal(sessionStatusLabel("working", "working", [{ title: "tail -f log" }]), "Working · tail -f log");
  assert.equal(sessionStatusLabel("idle", "finished", []), "Ready");
});
