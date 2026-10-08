import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_PINS, LEGACY_PROJECT_PINS_KEY, migrateProjectPins, parsePins, partitionPinned, pinnedFirst, projectPinOrderOf, projectPinsOf, prunePins, togglePin,
} from "../src/lib/pins.ts";

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

test("pinnedFirst puts undragged pins first (newest on top), then the dragged ones in their order", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  const pins = { a: 1, b: 2, c: 3, d: 4 };
  assert.deepEqual(pinnedFirst(items, pins, { a: 1, c: 0 }).map((i) => i.id), ["d", "b", "c", "a", "e"]);
  assert.deepEqual(pinnedFirst(items, pins, { a: 3, b: 2, c: 1, d: 0 }).map((i) => i.id), ["d", "c", "b", "a", "e"]);
  // An order for an unpinned item is ignored.
  assert.deepEqual(pinnedFirst(items, { a: 1 }, { e: 0 }).map((i) => i.id), ["a", "b", "c", "d", "e"]);
});

test("projectPinOrderOf keeps the drag positions of pinned projects only", () => {
  assert.deepEqual(projectPinOrderOf([
    { id: "a", pinnedAt: 1, pinOrder: 2 }, { id: "b", pinnedAt: 1, pinOrder: null }, { id: "c", pinnedAt: null, pinOrder: 0 }, { id: "d", pinnedAt: 1 },
  ]), { a: 2 });
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

test("projectPinsOf maps the server's pinnedAt, leaving out unpinned and old-server projects", () => {
  assert.deepEqual(projectPinsOf([{ id: "a", pinnedAt: 5 }, { id: "b", pinnedAt: null }, { id: "c" }]), { a: 5 });
  assert.deepEqual(pinnedFirst([{ id: "a" }, { id: "b" }], projectPinsOf([{ id: "b", pinnedAt: 1 }])).map((p) => p.id), ["b", "a"]);
});

/** A localStorage stand-in holding both pin keys, and a fetch stand-in that records PATCH bodies. */
function fakes({ projectPins, failOn = null } = {}) {
  const items = new Map([["portal.pins.sessions", JSON.stringify({ s1: 1 })]]);
  if (projectPins !== undefined) items.set(LEGACY_PROJECT_PINS_KEY, JSON.stringify(projectPins));
  const storage = { getItem: (key) => items.get(key) ?? null, removeItem: (key) => { items.delete(key); } };
  const requests = [];
  const fetch = async (url, options) => {
    requests.push([options.method, url, JSON.parse(options.body)]);
    return url.endsWith(`/${failOn}`) ? { ok: false, status: 500 } : { ok: true, status: 200 };
  };
  // The same request `useProjects` sends, throwing on a refusal like it does.
  const pin = async (id) => {
    const r = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ pinned: true }) });
    if (!r.ok) throw new Error("refused");
  };
  return { items, storage, requests, pin };
}

test("migrateProjectPins pushes local project pins oldest first, skips gone and pinned ids, then deletes only the project key", async () => {
  const { items, storage, requests, pin } = fakes({ projectPins: { b: 30, gone: 5, a: 10, c: 20 } });
  const projects = [{ id: "a", pinnedAt: null }, { id: "b", pinnedAt: null }, { id: "c", pinnedAt: 99 }];
  assert.deepEqual(await migrateProjectPins(projects, storage, pin), { status: "done", pushed: 2 });
  assert.deepEqual(requests, [["PATCH", "/api/projects/a", { pinned: true }], ["PATCH", "/api/projects/b", { pinned: true }]]);
  assert.equal(items.has(LEGACY_PROJECT_PINS_KEY), false);
  assert.equal(items.get("portal.pins.sessions"), JSON.stringify({ s1: 1 }), "session pins are untouched");
});

test("migrateProjectPins waits for a server that reports pinnedAt, and for a non-empty list", async () => {
  const { items, storage, requests, pin } = fakes({ projectPins: { a: 1 } });
  assert.deepEqual(await migrateProjectPins([{ id: "a" }, { id: "b", pinnedAt: null }], storage, pin), { status: "waiting", pushed: 0 });
  assert.deepEqual(await migrateProjectPins([], storage, pin), { status: "waiting", pushed: 0 });
  assert.deepEqual(requests, []);
  assert.ok(items.has(LEGACY_PROJECT_PINS_KEY));
});

test("migrateProjectPins keeps the key after a refused push, and a rerun finishes without pinning twice", async () => {
  const { items, storage, requests, pin } = fakes({ projectPins: { a: 1, b: 2 }, failOn: "b" });
  const projects = [{ id: "a", pinnedAt: null }, { id: "b", pinnedAt: null }];
  assert.deepEqual(await migrateProjectPins(projects, storage, pin), { status: "waiting", pushed: 1 });
  assert.equal(requests.length, 2);
  assert.ok(items.has(LEGACY_PROJECT_PINS_KEY));
  // The next list shows `a` pinned by the first run, so only `b` goes again.
  const { pin: working, requests: later } = fakes();
  assert.deepEqual(await migrateProjectPins([{ id: "a", pinnedAt: 7 }, { id: "b", pinnedAt: null }], storage, working), { status: "done", pushed: 1 });
  assert.deepEqual(later, [["PATCH", "/api/projects/b", { pinned: true }]]);
  assert.equal(items.has(LEGACY_PROJECT_PINS_KEY), false);
});

test("migrateProjectPins with no local pins, or no storage, is done at once", async () => {
  const { items, storage, requests, pin } = fakes();
  assert.deepEqual(await migrateProjectPins([{ id: "a", pinnedAt: null }], storage, pin), { status: "done", pushed: 0 });
  const blocked = { getItem: () => { throw new Error("SecurityError"); }, removeItem: () => { throw new Error("SecurityError"); } };
  assert.deepEqual(await migrateProjectPins([{ id: "a", pinnedAt: null }], blocked, pin), { status: "done", pushed: 0 });
  assert.deepEqual(requests, []);
  assert.ok(items.has("portal.pins.sessions"));
});
