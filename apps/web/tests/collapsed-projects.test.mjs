import assert from "node:assert/strict";
import test from "node:test";
import { parseCollapsed, pruneCollapsed, serializeCollapsed } from "../src/lib/collapsed-projects.ts";

test("parseCollapsed reads a stored list and treats anything malformed as nothing collapsed", () => {
  assert.deepEqual([...parseCollapsed('["a","b"]')], ["a", "b"]);
  assert.equal(parseCollapsed(null).size, 0);
  assert.equal(parseCollapsed("").size, 0);
  assert.equal(parseCollapsed("not json").size, 0);
  assert.equal(parseCollapsed('{"a":1}').size, 0);
  assert.deepEqual([...parseCollapsed('["a",2,null,"b"]')], ["a", "b"]);
});

test("serializeCollapsed round-trips through parseCollapsed", () => {
  assert.deepEqual([...parseCollapsed(serializeCollapsed(new Set(["x", "y"])))], ["x", "y"]);
  assert.equal(serializeCollapsed([]), "[]");
});

test("pruneCollapsed drops ids of projects that are gone and keeps the set when nothing changed", () => {
  const ids = new Set(["a", "b", "c"]);
  assert.deepEqual([...pruneCollapsed(ids, ["a", "c"])], ["a", "c"]);
  assert.equal(pruneCollapsed(ids, ["a", "b", "c", "d"]), ids);
  assert.equal(pruneCollapsed(ids, []).size, 0);
});
