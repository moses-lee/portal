import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PINS, parsePins, partitionPinned, pinnedFirst, prunePins, togglePin } from "../src/lib/pins.ts";

test("parsePins accepts only an object of finite numbers", () => {
  assert.deepEqual(parsePins(null), {});
  assert.deepEqual(parsePins(""), {});
  assert.deepEqual(parsePins("not json"), {});
  assert.deepEqual(parsePins("[1,2]"), {});
  assert.deepEqual(parsePins('{"a":1,"b":"x","c":null,"d":2.5}'), { a: 1, d: 2.5 });
});

test("togglePin pins with a timestamp and unpins again without mutating", () => {
  const pinned = togglePin(EMPTY_PINS, "a", 42);
  assert.deepEqual(pinned, { a: 42 });
  assert.deepEqual(EMPTY_PINS, {});
  const both = togglePin(pinned, "b", 43);
  assert.deepEqual(both, { a: 42, b: 43 });
  assert.deepEqual(togglePin(both, "a"), { b: 43 });
  assert.deepEqual(pinned, { a: 42 });
});

test("prunePins drops unknown ids and returns the same map when nothing changed", () => {
  const pins = { a: 1, b: 2 };
  assert.equal(prunePins(pins, ["a", "b", "c"]), pins);
  assert.deepEqual(prunePins(pins, ["b"]), { b: 2 });
  assert.deepEqual(pins, { a: 1, b: 2 });
});

test("pinnedFirst puts the most recently pinned on top and keeps the rest in order", () => {
  const items = [{ id: "w" }, { id: "x" }, { id: "y" }, { id: "z" }];
  assert.deepEqual(pinnedFirst(items, { x: 5, z: 9 }).map((i) => i.id), ["z", "x", "w", "y"]);
  assert.deepEqual(pinnedFirst(items, { x: 5, z: 5 }).map((i) => i.id), ["x", "z", "w", "y"]);
  assert.deepEqual(pinnedFirst(items, EMPTY_PINS).map((i) => i.id), ["w", "x", "y", "z"]);
  assert.deepEqual(pinnedFirst(items, { gone: 1 }).map((i) => i.id), ["w", "x", "y", "z"]);
});

test("partitionPinned keeps each part's order", () => {
  const items = [{ id: "w" }, { id: "x" }, { id: "y" }, { id: "z" }];
  assert.deepEqual(partitionPinned(items, { z: 1, x: 2 }).map((i) => i.id), ["x", "z", "w", "y"]);
  assert.deepEqual(partitionPinned(items, EMPTY_PINS).map((i) => i.id), ["w", "x", "y", "z"]);
});
