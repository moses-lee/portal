import assert from "node:assert/strict";
import test from "node:test";
import {
  countdownText,
  projectIdleClock,
  untrackCountdown,
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

test("a finished tracked session untracks untrackAfterHours after it went idle", () => {
  const now = 1_000 * DAY;
  // Idle for 20h 30m of 48h: 27h 30m left.
  assert.equal(untrackCountdown({ idleSince: now - 20 * HOUR - 30 * MIN }, 48, now), "untracks in 1d 3h");
  assert.equal(untrackCountdown({ idleSince: now - 47 * HOUR - 30 * MIN }, 48, now), "untracks in 30m");
  // Past due: the next sweep takes it.
  assert.equal(untrackCountdown({ idleSince: now - 50 * HOUR }, 48, now), "untracks soon");
  // The setting moves the clock.
  assert.equal(untrackCountdown({ idleSince: now }, 1, now), "untracks in 1h");
  // No clock while it is doing anything (or before the server reports one).
  assert.equal(untrackCountdown({ idleSince: null }, 48, now), null);
  assert.equal(untrackCountdown({}, 48, now), null);
});

test("tracking an old finished session starts its untrack clock when it was tracked", () => {
  const now = 1_000 * DAY;
  // Idle for 5 days, tracked an hour ago: 47h left, not "soon".
  assert.equal(untrackCountdown({ idleSince: now - 5 * DAY }, 48, now, now - HOUR), "untracks in 1d 23h");
  // Tracked before it went idle: the idle clock wins.
  assert.equal(untrackCountdown({ idleSince: now - 20 * HOUR - 30 * MIN }, 48, now, now - 3 * DAY), "untracks in 1d 3h");
  // Still no clock while it is not idle.
  assert.equal(untrackCountdown({ idleSince: null }, 48, now, now), null);
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
