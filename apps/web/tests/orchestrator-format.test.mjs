import assert from "node:assert/strict";
import test from "node:test";
import {
  describeCron,
  describeEvery,
  describeSchedule,
  describeStatusLine,
  describeUsage,
  formatDuration,
  formatTokens,
  portalActivity,
  relativeTime,
} from "../src/lib/orchestrator/format.ts";

const now = Date.UTC(2026, 8, 23, 12, 0, 0);
const min = 60_000;

test("relativeTime reads both ways and rounds to the nearer unit", () => {
  assert.equal(relativeTime(now + 10_000, now), "any moment");
  assert.equal(relativeTime(now - 10_000, now), "just now");
  assert.equal(relativeTime(now + 50_000, now), "in 1 min");
  assert.equal(relativeTime(now + 6.6 * min, now), "in 7 min");
  assert.equal(relativeTime(now - 42 * min, now), "42 min ago");
  assert.equal(relativeTime(now + 90 * min, now), "in 2 h");
  assert.equal(relativeTime(now - 5 * 60 * min, now), "5 h ago");
  assert.equal(relativeTime(now + 3 * 24 * 60 * min, now), "in 3 d");
});

test("describeEvery names the largest whole unit", () => {
  assert.equal(describeEvery(30_000), "Every 30 seconds");
  assert.equal(describeEvery(min), "Every minute");
  assert.equal(describeEvery(2 * min), "Every 2 minutes");
  assert.equal(describeEvery(90 * min), "Every 90 minutes");
  assert.equal(describeEvery(60 * min), "Every hour");
  assert.equal(describeEvery(6 * 60 * min), "Every 6 hours");
  assert.equal(describeEvery(24 * 60 * min), "Every day");
  assert.equal(describeEvery(2 * 24 * 60 * min), "Every 2 days");
});

test("describeCron covers the common shapes and gives up on the rest", () => {
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 * * * *"), "Every hour");
  assert.equal(describeCron("5 * * * *"), "Every hour at :05");
  assert.equal(describeCron("0 */2 * * *"), "Every 2 hours");
  assert.equal(describeCron("0 9 * * *"), "Daily at 09:00");
  assert.equal(describeCron("30 9 * * 1-5"), "Weekdays at 09:30");
  assert.equal(describeCron("0 10 * * 0,6"), "Weekends at 10:00");
  assert.equal(describeCron("0 9 * * 1"), "Mondays at 09:00");
  assert.equal(describeCron("0 9 1 * *"), null);
  assert.equal(describeCron("0 9 * *"), null);
  assert.equal(describeCron("0 9-17 * * *"), null);
});

test("describeSchedule words each schedule type", () => {
  assert.equal(describeSchedule({ type: "every", everyMs: 2 * min }), "Every 2 minutes");
  assert.equal(
    describeSchedule({ type: "every", everyMs: 10 * min, idleEveryMs: 60 * min }),
    "Every 10 minutes (every hour while you are away)",
  );
  assert.equal(describeSchedule({ type: "every", everyMs: 10 * min, idleEveryMs: 10 * min }), "Every 10 minutes");
  assert.equal(describeSchedule({ type: "cron", expr: "0 3 * * *", tz: "Europe/Berlin" }), "Daily at 03:00 (Europe/Berlin)");
  assert.equal(describeSchedule({ type: "cron", expr: "0 9 1 * *" }), "Cron 0 9 1 * *");
  const local = new Date(now);
  local.setHours(14, 5, 0, 0);
  assert.equal(describeSchedule({ type: "at", at: local.getTime() }, local.getTime() - min), "Once, today 14:05");
});

test("durations, token counts, and usage", () => {
  assert.equal(formatDuration(800), "800 ms");
  assert.equal(formatDuration(12_400), "12 s");
  assert.equal(formatDuration(3 * min + 5000), "3 min 5 s");
  assert.equal(formatDuration(4 * min), "4 min");
  assert.equal(formatDuration(62 * min), "1 h 2 min");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(12_345), "12k");
  assert.equal(formatTokens(1_250_000), "1.3M");
  assert.equal(describeUsage({ inputTokens: 1200, outputTokens: 80 }), "1.2k in · 80 out");
  assert.equal(
    describeUsage({ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000, reasoningTokens: 40 }),
    "1.2k in · 80 out · 1k cached · 40 reasoning",
  );
});

const baseStatus = {
  ready: true,
  provider: "anthropic",
  model: "claude-opus-5-5",
  busy: false,
  presence: 1,
  busyThreads: [],
  runs: [],
  nextJob: { id: "consolidate", title: "Curate memory", at: now + 6 * min },
  counts: { needsYou: 0, inbox: 0, approvals: 0, intents: 0 },
  line: "Idle · next: Curate memory",
};

test("the status line keeps the server's words and adds the countdown", () => {
  assert.deepEqual(describeStatusLine(null, now), { line: "Connecting…", next: null, tone: "connecting" });
  assert.deepEqual(describeStatusLine(baseStatus, now), {
    line: "Idle · next: Curate memory",
    next: "in 6 min",
    tone: "idle",
  });
  const running = {
    ...baseStatus,
    runs: [{ id: "r1", kind: "helper", jobId: "j1", threadId: null, startedAt: now - min, summary: "Reading PR 42" }],
    line: "Reading PR 42…",
  };
  assert.deepEqual(describeStatusLine(running, now), {
    line: "Reading PR 42…",
    next: "next: Curate memory in 6 min",
    tone: "running",
  });
  const overdue = { ...baseStatus, nextJob: { ...baseStatus.nextJob, at: now - 3 * min } };
  assert.equal(describeStatusLine(overdue, now).next, "any moment");
  assert.deepEqual(describeStatusLine({ ...baseStatus, nextJob: null, line: "Idle" }, now), {
    line: "Idle",
    next: null,
    tone: "idle",
  });
  const paused = { ...baseStatus, ready: false, line: "Add an API key in Settings to start Portal." };
  assert.deepEqual(describeStatusLine(paused, now), {
    line: "Add an API key in Settings to start Portal.",
    next: null,
    tone: "paused",
  });
});

test("the aurora follows the user's turn and pending approvals, never background jobs", () => {
  const status = (busyThreads, runs = []) => ({ ready: true, busy: runs.length > 0 || busyThreads.length > 0, busyThreads, runs });
  assert.equal(portalActivity(null, []), "idle");
  assert.equal(portalActivity(status([]), []), "idle");
  assert.equal(portalActivity(status([], [{ id: "r1", kind: "intent_check" }]), []), "idle", "a job running is not the user waiting");
  assert.equal(portalActivity(status(["main"]), []), "working");
  assert.equal(portalActivity(status(["t-review"]), []), "working", "any thread's turn counts");
  assert.equal(portalActivity(status(["main"]), [{ status: "pending" }]), "waiting", "an approval outranks the turn");
  assert.equal(portalActivity(status([]), [{ status: "approved" }]), "idle");
});
