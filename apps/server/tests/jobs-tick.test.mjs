import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryJobsStore } from "../src/orchestrator/jobs/store.ts";
import { FIRST_TICK_DELAY_MS } from "../src/orchestrator/jobs/tick-job.ts";
import { T0, call, flush, jobsHarness, started, toolContext } from "./fixtures/jobs-harness.mjs";

const MIN = 60_000;

test("the tick job is seeded once: a second start keeps it, with its first run no sooner than a minute away", async (t) => {
  const first = await started(jobsHarness(t, { settings: { intervalMinutes: 10, idleIntervalMinutes: 60 } }));
  await first.timers.advance(FIRST_TICK_DELAY_MS);
  const ran = await first.jobs.tickJob();
  assert.equal(ran.lastRunAt, T0 + FIRST_TICK_DELAY_MS);
  assert.equal(ran.nextRunAt, T0 + FIRST_TICK_DELAY_MS + 60 * MIN);
  const seeded = (await first.hub.activity.list({ kind: "job.scheduled" })).filter((entry) => entry.refs.jobId === "tick");
  assert.equal(seeded.length, 1);
  await first.runtime.dispose();

  // A restart over the same store: the persisted schedule stands (it is further out than a minute).
  const second = await started(jobsHarness(t, { store: first.jobsStore, settings: { intervalMinutes: 10, idleIntervalMinutes: 60 } }));
  const kept = await second.jobs.tickJob();
  assert.equal(kept.nextRunAt, ran.nextRunAt);
  assert.equal(kept.lastRunId, ran.lastRunId);
  assert.equal((await second.jobs.listJobs({ kind: ["tick"] })).length, 1);
  assert.equal(second.jobs.lastTick().id, ran.lastRunId, "the last report comes back from the runs");
  assert.equal((await second.hub.activity.list({ kind: "job.scheduled" })).length, 0, "not seeded again");
});

test("on start an overdue, leased, paused, or cancelled tick is brought back into shape; runs left running are closed", async (t) => {
  const timersNow = { at: T0 };
  const shared = createMemoryJobsStore({ now: () => timersNow.at });
  await shared.ensureJob({ id: "tick", kind: "tick", title: "Check for changes", schedule: { type: "every", everyMs: 10 * MIN }, nextRunAt: T0 - 60 * MIN, createdBy: "system" });
  await shared.claimDue({ limit: 5, leaseMs: 60 * MIN });
  await shared.insertRun({
    id: "stale1", jobId: "tick", kind: "tick", threadId: "main", parentRunId: null, status: "running", trigger: "schedule", startedAt: T0 - 60 * MIN,
    finishedAt: null, model: null, usage: null, log: [], result: null, summary: null, error: null,
  });
  const h = await started(jobsHarness(t, { store: shared, settings: { intervalMinutes: 5, idleIntervalMinutes: 30 } }));
  const tick = await h.jobs.tickJob();
  assert.equal(tick.nextRunAt, T0 + FIRST_TICK_DELAY_MS, "overdue: a minute after start, not at once");
  assert.deepEqual(tick.schedule, { type: "every", everyMs: 5 * MIN, idleEveryMs: 30 * MIN }, "it follows the settings");
  assert.ok(await shared.claimJob("tick", 1), "the dead process's lease was dropped");
  await shared.release("tick", {});
  const stale = await h.jobs.getRun("stale1");
  assert.equal(stale.status, "cancelled");
  assert.match(stale.error, /stopped/);
  await h.runtime.dispose();

  await shared.updateJob("tick", { status: "cancelled" });
  const again = await started(jobsHarness(t, { store: shared }));
  assert.equal((await again.jobs.tickJob()).status, "active", "the tick always exists");
  await again.runtime.dispose();

  await shared.updateJob("tick", { status: "paused" });
  const paused = await started(jobsHarness(t, { store: shared }));
  assert.equal((await paused.jobs.tickJob()).status, "paused", "a pause the user chose stands");
  assert.equal((await paused.runtime.status()).nextTickAt, null);
  assert.match((await paused.runtime.runTick("manual")).log[0], /the tick is paused/);
});

test("settings changes reschedule the tick until the agent reschedules it; from then on its cadence is the agent's", async (t) => {
  const h = await started(jobsHarness(t, { settings: { intervalMinutes: 10, idleIntervalMinutes: 60 } }));
  await h.settings.change({ intervalMinutes: 3, idleIntervalMinutes: 20 });
  await flush();
  let tick = await h.jobs.tickJob();
  assert.deepEqual(tick.schedule, { type: "every", everyMs: 3 * MIN, idleEveryMs: 20 * MIN });
  assert.equal(tick.nextRunAt, T0 + FIRST_TICK_DELAY_MS, "a plan sooner than the new cadence stays");
  assert.match((await h.hub.activity.list({ kind: "job.updated" }))[0].summary, /follows the new settings/);

  // The agent sets the tick's cadence itself.
  const tools = h.jobs.tools(toolContext(h));
  const changed = await call(tools, "update_job", { id: "tick", schedule: { everyMinutes: 30 } });
  assert.equal(changed.schedule, "every 30 min");
  tick = await h.jobs.tickJob();
  assert.equal(tick.payload.followsSettings, false);
  const updated = (await h.hub.activity.list({ kind: "job.updated" }))[0];
  assert.equal(updated.actor, "agent");
  assert.match(updated.summary, /now every 30 min/);

  await h.settings.change({ intervalMinutes: 7 });
  await flush();
  assert.deepEqual((await h.jobs.tickJob()).schedule, { type: "every", everyMs: 30 * MIN }, "the settings no longer move it");

  // Nobody can cancel the tick; the agent may pause it only through update_job.
  assert.match((await call(tools, "cancel_job", { id: "tick" })).error, /cannot be cancelled/);
  await assert.rejects(h.jobs.updateJob("tick", { status: "cancelled" }, "user"), (err) => err.status === 409);
});

test("a manual tick goes through the job: it is a run, it counts as the last run, and busy while running", async (t) => {
  let release;
  const h = await started(jobsHarness(t, {
    jobs: { tick: (report) => new Promise((resolve) => { release = () => { report.log.push("done"); resolve(); }; }) },
  }));
  const pending = h.runtime.runTick("manual");
  await flush();
  const status = await h.runtime.status();
  assert.equal(status.busy, true);
  assert.equal(status.runs[0].kind, "tick");
  assert.match(status.line, /Check for changes/);
  const busy = await h.runtime.runTick("manual");
  assert.equal(busy.error, "busy");
  assert.equal(await h.jobs.getRun(busy.id), null, "a skipped tick is not stored");
  release();
  const report = await pending;
  assert.equal(report.reason, "manual");
  const run = await h.jobs.getRun(report.id);
  assert.equal(run.trigger, "manual");
  assert.deepEqual(run.result, report);
  const tick = await h.jobs.tickJob();
  assert.equal(tick.lastRunId, report.id);
  assert.equal(tick.nextRunAt, report.finishedAt + 60 * MIN, "the next tick counts from the manual one");
  assert.deepEqual((await h.runtime.listTicks()).map((entry) => entry.id), [report.id]);
  assert.equal((await h.runtime.status()).lastTick.id, report.id);
});
