import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_EVERY_MS, currentInterval, describeSchedule, followsPresence, nextRunAt, parseSchedule, replanned,
} from "../src/orchestrator/jobs/schedule.ts";

const T0 = Date.UTC(2026, 8, 23, 14, 0, 0); // Wednesday 2026-09-23 14:00 UTC
const MIN = 60_000;

function rejects400(fn, pattern) {
  assert.throws(fn, (err) => err.status === 400 && pattern.test(err.message));
}

test("parseSchedule accepts every, cron, and at, and refuses anything else with a 400", () => {
  assert.deepEqual(parseSchedule({ type: "every", everyMs: 10 * MIN }), { type: "every", everyMs: 10 * MIN });
  assert.deepEqual(parseSchedule({ type: "every", everyMs: 10 * MIN, idleEveryMs: 60 * MIN, extra: 1 }), { type: "every", everyMs: 10 * MIN, idleEveryMs: 60 * MIN });
  assert.deepEqual(parseSchedule({ type: "every", everyMs: 120_000.4, idleEveryMs: null }), { type: "every", everyMs: 120_000 });
  assert.deepEqual(parseSchedule({ type: "cron", expr: "  0 9  * * 1-5 ", tz: "Europe/Berlin" }), { type: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" });
  assert.deepEqual(parseSchedule({ type: "cron", expr: "*/15 * * * *" }), { type: "cron", expr: "*/15 * * * *" });
  assert.deepEqual(parseSchedule({ type: "at", at: T0 }), { type: "at", at: T0 });

  rejects400(() => parseSchedule(null), /must be an object/);
  rejects400(() => parseSchedule({ type: "hourly" }), /every, cron, or at/);
  rejects400(() => parseSchedule({ type: "every", everyMs: MIN_EVERY_MS - 1 }), /between one minute and 31 days/);
  rejects400(() => parseSchedule({ type: "every", everyMs: "600000" }), /number of milliseconds/);
  rejects400(() => parseSchedule({ type: "every", everyMs: 10 * MIN, idleEveryMs: 1 }), /idleEveryMs/);
  rejects400(() => parseSchedule({ type: "cron", expr: "0 9 * *" }), /Invalid cron expression/);
  rejects400(() => parseSchedule({ type: "cron", expr: "0 0 9 * * *" }), /Invalid cron expression/, "six fields are refused: five only");
  rejects400(() => parseSchedule({ type: "cron", expr: "61 * * * *" }), /Invalid cron expression/);
  rejects400(() => parseSchedule({ type: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" }), /Unknown time zone/);
  rejects400(() => parseSchedule({ type: "cron", expr: "0 0 30 2 *" }), /never fires/);
  rejects400(() => parseSchedule({ type: "at", at: 1.5 }), /epoch ms/);
});

test("every counts from the end of the last run, picks the idle interval with nobody present, and runs at once when overdue", () => {
  const schedule = { type: "every", everyMs: 10 * MIN, idleEveryMs: 60 * MIN };
  assert.equal(currentInterval(schedule, true), 10 * MIN);
  assert.equal(currentInterval(schedule, false), 60 * MIN);
  assert.equal(currentInterval({ type: "every", everyMs: 10 * MIN }, false), 10 * MIN, "no idle interval: the same cadence");
  assert.equal(nextRunAt(schedule, { now: T0, lastRunAt: T0, present: true }), T0 + 10 * MIN);
  assert.equal(nextRunAt(schedule, { now: T0, lastRunAt: T0, present: false }), T0 + 60 * MIN);
  assert.equal(nextRunAt(schedule, { now: T0, lastRunAt: null, present: true }), T0 + 10 * MIN, "a job that never ran waits one interval");
  assert.equal(nextRunAt(schedule, { now: T0, lastRunAt: T0 - 2 * 60 * MIN, present: false }), T0, "overdue runs now, not in the past");
  assert.equal(followsPresence(schedule), true);
  assert.equal(followsPresence({ type: "every", everyMs: 10 * MIN, idleEveryMs: 10 * MIN }), false);
  assert.equal(followsPresence({ type: "cron", expr: "* * * * *" }), false);
});

test("cron runs at the next matching minute in its zone, after the later of now and the last run", () => {
  const weekdays9 = { type: "cron", expr: "0 9 * * 1-5", tz: "America/New_York" };
  // 14:00 UTC is 10:00 in New York (EDT): the next 9:00 there is Thursday 13:00 UTC.
  assert.equal(nextRunAt(weekdays9, { now: T0, lastRunAt: null, present: true }), Date.UTC(2026, 8, 24, 13, 0, 0));
  // From Friday after nine the next is Monday.
  assert.equal(nextRunAt(weekdays9, { now: Date.UTC(2026, 8, 25, 14, 0, 0), lastRunAt: null, present: true }), Date.UTC(2026, 8, 28, 13, 0, 0));
  const quarter = { type: "cron", expr: "*/15 * * * *", tz: "UTC" };
  assert.equal(nextRunAt(quarter, { now: T0 + 1, lastRunAt: null, present: true }), T0 + 15 * MIN);
  assert.equal(nextRunAt(quarter, { now: T0, lastRunAt: T0 + 20 * MIN, present: true }), T0 + 30 * MIN, "a run in the future (clock skew) counts");
});

test("at runs once: its time until it ran, then nothing", () => {
  const once = { type: "at", at: T0 + 5 * MIN };
  assert.equal(nextRunAt(once, { now: T0, lastRunAt: null, present: true }), T0 + 5 * MIN);
  assert.equal(nextRunAt({ type: "at", at: T0 - MIN }, { now: T0, lastRunAt: null, present: true }), T0 - MIN, "a missed time is due at once");
  assert.equal(nextRunAt(once, { now: T0, lastRunAt: T0, present: true }), null);
});

test("replanned keeps an earlier plan for a job that never ran and recounts from the last run otherwise", () => {
  const schedule = { type: "every", everyMs: 10 * MIN, idleEveryMs: 60 * MIN };
  // The tick seeded a minute after start keeps that minute when a browser connects.
  assert.equal(replanned({ schedule, lastRunAt: null, nextRunAt: T0 + MIN }, T0, true), T0 + MIN);
  // A plan further out than the new cadence moves in.
  assert.equal(replanned({ schedule, lastRunAt: null, nextRunAt: T0 + 60 * MIN }, T0, true), T0 + 10 * MIN);
  assert.equal(replanned({ schedule, lastRunAt: T0 - 5 * MIN, nextRunAt: T0 + 55 * MIN }, T0, true), T0 + 5 * MIN);
  assert.equal(replanned({ schedule, lastRunAt: T0 - 5 * MIN, nextRunAt: T0 + 5 * MIN }, T0, false), T0 + 55 * MIN);
});

test("describeSchedule reads like a sentence", () => {
  assert.equal(describeSchedule({ type: "every", everyMs: 10 * MIN, idleEveryMs: 60 * MIN }), "every 10 min (1 h idle)");
  assert.equal(describeSchedule({ type: "every", everyMs: 2 * MIN }), "every 2 min");
  assert.equal(describeSchedule({ type: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" }), "cron 0 9 * * 1-5 (Europe/Berlin)");
  assert.equal(describeSchedule({ type: "at", at: T0 }), "once at 2026-09-23T14:00:00.000Z");
});
