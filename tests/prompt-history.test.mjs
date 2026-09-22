import assert from "node:assert/strict";
import test from "node:test";
import { appendHistory, atHistoryEdge, parseHistory } from "../src/lib/prompt-history.ts";

test("parseHistory accepts only an array of non-blank strings", () => {
  assert.deepEqual(parseHistory(null), []);
  assert.deepEqual(parseHistory("not json"), []);
  assert.deepEqual(parseHistory('{"a":1}'), []);
  assert.deepEqual(parseHistory('["one", 2, "", "  ", null, "two"]'), ["one", "two"]);
});

test("appendHistory trims, skips blanks and repeats of the newest entry", () => {
  const entries = ["a", "b"];
  assert.equal(appendHistory(entries, "   "), entries);
  assert.equal(appendHistory(entries, " b \n"), entries);
  assert.deepEqual(appendHistory(entries, "  a  "), ["a", "b", "a"]);
  assert.deepEqual(entries, ["a", "b"]);
});

test("appendHistory drops the oldest entries past the limit", () => {
  assert.deepEqual(appendHistory(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
});

test("atHistoryEdge browses only from the first line (up) or the last line (down)", () => {
  const text = "one\ntwo\nthree";
  assert.equal(atHistoryEdge(text, 2, 2, "up"), true);
  assert.equal(atHistoryEdge(text, 5, 5, "up"), false);
  assert.equal(atHistoryEdge(text, 5, 5, "down"), false);
  assert.equal(atHistoryEdge(text, 9, 9, "down"), true);
  assert.equal(atHistoryEdge(text, text.length, text.length, "down"), true);
  assert.equal(atHistoryEdge("", 0, 0, "up"), true);
  assert.equal(atHistoryEdge("", 0, 0, "down"), true);
  assert.equal(atHistoryEdge("single", 0, 6, "up"), false);
});
