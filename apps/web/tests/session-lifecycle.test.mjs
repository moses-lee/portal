import assert from "node:assert/strict";
import test from "node:test";
import {
  countdownText,
  projectIdleClock,
  worktreeRetention,
} from "../src/lib/session-lifecycle.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("countdowns read in days and hours, hours and minutes, or minutes", () => {
  assert.equal(countdownText(DAY + 3 * HOUR + 59 * MIN), "1d 3h");
  assert.equal(countdownText(2 * DAY), "2d");
  assert.equal(countdownText(5 * HOUR + 20 * MIN), "5h 20m");
  assert.equal(countdownText(5 * HOUR), "5h");
  assert.equal(countdownText(12 * MIN + 30_000), "12m");
  assert.equal(countdownText(59_000), "soon");
  assert.equal(countdownText(-HOUR), "soon");
});

test("coarse countdowns keep only the largest unit", () => {
  assert.equal(countdownText(2 * DAY + 23 * HOUR, { coarse: true }), "2d");
  assert.equal(countdownText(5 * HOUR + 20 * MIN, { coarse: true }), "5h");
  assert.equal(countdownText(12 * MIN, { coarse: true }), "12m");
});

const worktree = { parentId: "parent", branch: "feat" };

function project(patch = {}) {
  return { id: "p", createdAt: 0, worktree, pinnedAt: null, keptReason: null, ...patch };
}

test("a project's clock is the newest idle time among its sessions, else its creation", () => {
  const sessions = [
    { projectId: "p", idleSince: 10 },
    { projectId: "p", idleSince: 30 },
    { projectId: "other", idleSince: 99 },
  ];
  assert.equal(projectIdleClock(project({ createdAt: 5 }), sessions), 30);
  assert.equal(projectIdleClock(project({ createdAt: 5 }), []), 5);
  assert.equal(projectIdleClock(project(), [...sessions, { projectId: "p", idleSince: null }]), null);
  // A session not idle in another project does not stop this one's clock.
  assert.equal(projectIdleClock(project(), [{ projectId: "other", idleSince: null }, { projectId: "p", idleSince: 7 }]), 7);
});

test("a worktree row says when it will be removed, within a week of it", () => {
  const now = 100 * DAY;
  const idle = [{ projectId: "p", idleSince: now - HOUR }];
  // 72h after going idle, 71h left: "2d".
  assert.equal(worktreeRetention(project(), idle, 72, now), "removes in 2d");
  // More than seven days away: nothing yet.
  assert.equal(worktreeRetention(project(), idle, 720, now), null);
  // Exactly seven days away still shows.
  assert.equal(worktreeRetention(project(), [{ projectId: "p", idleSince: now }], 168, now), "removes in 7d");
  // Due now: the next sweep.
  assert.equal(worktreeRetention(project(), [{ projectId: "p", idleSince: now - 80 * HOUR }], 72, now), "removes soon");
  // No sessions: the project's creation starts the clock.
  assert.equal(worktreeRetention(project({ createdAt: now - 70 * HOUR }), [], 72, now), "removes in 2h");
});

test("a kept worktree says why; pinned, busy, and plain projects say nothing", () => {
  const now = 100 * DAY;
  const idle = [{ projectId: "p", idleSince: now - 100 * HOUR }];
  assert.equal(worktreeRetention(project({ keptReason: "uncommitted changes" }), idle, 72, now), "kept: uncommitted changes");
  // Held only by an open terminal: the reason, never "removes soon".
  assert.equal(worktreeRetention(project({ keptReason: "open terminal" }), idle, 72, now), "kept: open terminal");
  assert.equal(worktreeRetention(project({ pinnedAt: 1, keptReason: "uncommitted changes" }), idle, 72, now), null);
  assert.equal(worktreeRetention(project({ pinnedAt: 1 }), idle, 72, now), null);
  // A session still doing something: no clock runs, whatever the last sweep said.
  const busy = [...idle, { projectId: "p", idleSince: null }];
  assert.equal(worktreeRetention(project(), busy, 72, now), null);
  assert.equal(worktreeRetention(project({ keptReason: "uncommitted changes" }), busy, 72, now), null);
  // Folders the user added are never swept.
  assert.equal(worktreeRetention(project({ worktree: undefined }), idle, 72, now), null);
});
