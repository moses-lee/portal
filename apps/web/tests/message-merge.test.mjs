import assert from "node:assert/strict";
import test from "node:test";
import { mergeMessages, prependOlder, replaceWithPage, sameMessage } from "../src/lib/orchestrator/message-merge.ts";

/** A fresh object each call, as the server sends: equal content, new identity. */
const msg = (id, text = `text ${id}`, extra = {}) => ({
  id,
  role: "assistant",
  metadata: { at: 1000 },
  parts: [{ type: "text", text }],
  ...extra,
});
const ids = (list) => list.map((m) => m.id);

test("sameMessage compares content, not identity", () => {
  assert.equal(sameMessage(msg("a"), msg("a")), true);
  assert.equal(sameMessage(msg("a"), msg("b")), false);
  assert.equal(sameMessage(msg("a", "one"), msg("a", "two")), false);
  assert.equal(sameMessage(msg("a"), msg("a", "text a", { metadata: { at: 1000, toolIO: "omitted" } })), false);
  const tool = (output) => msg("t", "x", { parts: [{ type: "tool-x", toolCallId: "c", state: "output-available", input: {}, output }] });
  assert.equal(sameMessage(tool("[open to load]"), tool({ ok: true })), false);
  assert.equal(sameMessage(tool({ ok: true }), tool({ ok: true })), true);
  // A key holding undefined counts as absent, as it would after a JSON round trip.
  assert.equal(sameMessage(msg("a", "x", { metadata: { at: 1000, run: undefined } }), msg("a", "x")), true);
});

test("mergeMessages keeps held objects for unchanged messages and returns the same list when nothing changed", () => {
  const current = [msg("a"), msg("b")];
  const merged = mergeMessages(current, [msg("a"), msg("b")]);
  assert.equal(merged, current);
  assert.equal(mergeMessages(current, []), current);
});

test("mergeMessages replaces changed messages in place and appends new ones in page order", () => {
  const a = msg("a");
  const b = msg("b", "streamed");
  const current = [a, b];
  const serverB = msg("b", "stored");
  const merged = mergeMessages(current, [msg("a"), serverB, msg("c"), msg("d")]);
  assert.deepEqual(ids(merged), ["a", "b", "c", "d"]);
  assert.equal(merged[0], a);
  assert.equal(merged[1], serverB);
  assert.notEqual(merged, current);
});

test("replaceWithPage takes the page's order and membership but reuses unchanged objects", () => {
  const a = msg("a");
  const b = msg("b");
  const local = msg("local", "not kept by the server");
  const current = [a, b, local];
  const changedB = msg("b", "edited");
  const next = replaceWithPage(current, [msg("a"), changedB, msg("c")]);
  assert.deepEqual(ids(next), ["a", "b", "c"]);
  assert.equal(next[0], a);
  assert.equal(next[1], changedB);
  const same = [a, b];
  assert.equal(replaceWithPage(same, [msg("a"), msg("b")]), same);
  assert.deepEqual(replaceWithPage([], [msg("x")]).map((m) => m.id), ["x"]);
});

test("prependOlder puts the older page first, skips messages already held, keeps identities", () => {
  const b = msg("b");
  const c = msg("c");
  const current = [b, c];
  const next = prependOlder(current, [msg("a"), msg("b")]);
  assert.deepEqual(ids(next), ["a", "b", "c"]);
  assert.equal(next[1], b);
  assert.equal(next[2], c);
  assert.equal(prependOlder(current, [msg("b")]), current);
});

test("mergeMessages with a changed message and nothing added replaces it in place", () => {
  const a = msg("a");
  const b = msg("b", "old");
  const current = [a, b];
  const serverB = msg("b", "new");
  const merged = mergeMessages(current, [serverB]);
  assert.notEqual(merged, current);
  assert.deepEqual(ids(merged), ["a", "b"]);
  assert.equal(merged[0], a);
  assert.equal(merged[1], serverB);
});

test("sameMessage tells apart equal key counts with different names, arrays from objects, and non-plain objects", () => {
  assert.equal(sameMessage(msg("a", "x", { metadata: { at: 1 } }), msg("a", "x", { metadata: { run: 1 } })), false);
  assert.equal(sameMessage(msg("a", "x", { metadata: { at: [] } }), msg("a", "x", { metadata: { at: {} } })), false);
  assert.equal(sameMessage(msg("a", "x", { metadata: { at: { 0: 1 } } }), msg("a", "x", { metadata: { at: [1] } })), false);
  // Non-plain objects compare by identity only.
  const when = new Date(0);
  assert.equal(sameMessage(msg("a", "x", { metadata: { at: new Date(0) } }), msg("a", "x", { metadata: { at: new Date(0) } })), false);
  assert.equal(sameMessage(msg("a", "x", { metadata: { at: when } }), msg("a", "x", { metadata: { at: when } })), true);
  const bare = Object.assign(Object.create(null), { at: 1 });
  assert.equal(sameMessage(msg("a", "x", { metadata: bare }), msg("a", "x", { metadata: { at: 1 } })), true);
});

test("prependOlder keeps the older page's own order when it brings several new messages", () => {
  const d = msg("d");
  const next = prependOlder([d], [msg("a"), msg("b"), msg("c"), msg("d")]);
  assert.deepEqual(ids(next), ["a", "b", "c", "d"]);
  assert.equal(next[3], d);
});
