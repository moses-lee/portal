import assert from "node:assert/strict";
import test from "node:test";
import { needsAttention, retiredItemKinds } from "../src/items.ts";

const NOW = 1_000_000;
const item = (extra = {}) => ({ kind: "pr_merged", status: "open", snoozedUntil: null, ...extra });

test("retiredItemKinds holds exactly the five session kinds", () => {
  assert.deepEqual([...retiredItemKinds].sort(), ["session_finished", "session_hung", "session_offline", "session_stopped", "session_waiting"]);
});

test("open items need attention; resolved and dismissed ones do not", () => {
  assert.equal(needsAttention(item(), NOW), true);
  assert.equal(needsAttention(item({ status: "resolved" }), NOW), false);
  assert.equal(needsAttention(item({ status: "dismissed" }), NOW), false);
});

test("a snoozed item needs attention once its snooze lapsed, or when it has no time", () => {
  assert.equal(needsAttention(item({ status: "snoozed", snoozedUntil: NOW + 1 }), NOW), false);
  assert.equal(needsAttention(item({ status: "snoozed", snoozedUntil: NOW }), NOW), true);
  assert.equal(needsAttention(item({ status: "snoozed", snoozedUntil: NOW - 1 }), NOW), true);
  assert.equal(needsAttention(item({ status: "snoozed", snoozedUntil: null }), NOW), true);
});

test("retired kinds never need attention, whatever their status", () => {
  for (const kind of retiredItemKinds) {
    assert.equal(needsAttention(item({ kind }), NOW), false, kind);
    assert.equal(needsAttention(item({ kind, status: "snoozed", snoozedUntil: NOW - 1 }), NOW), false, kind);
  }
});
