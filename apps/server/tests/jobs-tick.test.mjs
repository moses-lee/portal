import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryJobsStore } from "../src/orchestrator/jobs/store.ts";
import { FIRST_TICK_DELAY_MS, TICK_EVERY_MS, TICK_TITLE } from "../src/orchestrator/jobs/tick-job.ts";
import { T0, call, deferred, flush, jobsHarness, started, toolContext } from "./fixtures/jobs-harness.mjs";

const MIN = 60_000;

test("the world refresh is seeded once, hourly: a second start keeps its plan, and nothing is logged about it", async (t) => {
  const first = await started(jobsHarness(t));
  assert.equal(TICK_EVERY_MS, 60 * MIN);
  await first.timers.advance(FIRST_TICK_DELAY_MS);
  assert.equal(first.ticks.length, 1);
  const ran = await first.jobsStore.getJob("tick");
  assert.equal(ran.title, TICK_TITLE);
  assert.deepEqual(ran.schedule, { type: "every", everyMs: 60 * MIN });
  assert.equal(ran.lastRunAt, T0 + FIRST_TICK_DELAY_MS);
  assert.equal(ran.nextRunAt, T0 + FIRST_TICK_DELAY_MS + 60 * MIN);
  assert.deepEqual((await first.hub.activity.list({})).filter((entry) => entry.refs.jobId === "tick"), []);
  await first.runtime.dispose();

  // A restart over the same store (its clock back at T0): the persisted plan stands, capped at an hour out.
  const second = await started(jobsHarness(t, { store: first.jobsStore }));
  const kept = await second.jobsStore.getJob("tick");
  assert.equal(kept.nextRunAt, T0 + 60 * MIN);
  assert.equal(kept.lastRunId, ran.lastRunId);
  assert.equal((await second.jobsStore.listJobs({ kind: ["tick"] })).length, 1);
});

test("on start the stored job is forced into shape: active, hourly, renamed, its next run within the hour; runs left running are closed", async (t) => {
  const shared = createMemoryJobsStore({ now: () => T0 });
  await shared.ensureJob({
    id: "tick", kind: "tick", title: "Check for changes", schedule: { type: "every", everyMs: 10 * MIN, idleEveryMs: 60 * MIN },
    payload: { followsSettings: true }, nextRunAt: T0 - 60 * MIN, createdBy: "system",
  });
  await shared.claimDue({ limit: 5, leaseMs: 60 * MIN });
  await shared.insertRun({
    id: "stale1", jobId: "tick", kind: "tick", threadId: "main", parentRunId: null, status: "running", trigger: "schedule", startedAt: T0 - 60 * MIN,
    finishedAt: null, model: null, usage: null, log: [], result: null, summary: null, error: null,
  });
  const h = await started(jobsHarness(t, { store: shared }));
  const tick = await shared.getJob("tick");
  assert.equal(tick.nextRunAt, T0 + FIRST_TICK_DELAY_MS, "overdue: a minute after start, not at once");
  assert.deepEqual(tick.schedule, { type: "every", everyMs: 60 * MIN });
  assert.equal(tick.title, TICK_TITLE);
  assert.deepEqual(tick.payload, {});
  assert.ok(await shared.claimJob("tick", 1), "the dead process's lease was dropped");
  await shared.release("tick", {});
  assert.equal((await shared.getRun("stale1")).status, "cancelled");
  await h.runtime.dispose();

  // Paused, cancelled, or planned days out by an older Portal: back to active within the hour.
  for (const changes of [{ status: "paused", nextRunAt: null }, { status: "cancelled", nextRunAt: null }, { status: "active", schedule: { type: "every", everyMs: 3 * 24 * 60 * MIN }, nextRunAt: T0 + 3 * 24 * 60 * MIN }]) {
    await shared.updateJob("tick", changes);
    const again = await started(jobsHarness(t, { store: shared }));
    const job = await shared.getJob("tick");
    assert.equal(job.status, "active", JSON.stringify(changes));
    assert.ok(job.nextRunAt >= T0 + FIRST_TICK_DELAY_MS && job.nextRunAt <= T0 + 60 * MIN, JSON.stringify(changes));
    assert.deepEqual(job.schedule, { type: "every", everyMs: 60 * MIN });
    await again.runtime.dispose();
  }
});

test("the world refresh is hidden from every listing and refused by every tool and route that would change or run it", async (t) => {
  const release = deferred();
  const h = await started(jobsHarness(t, { jobs: { tick: (report) => release.promise.then(() => { report.log.push("done"); }) } }));
  const tools = h.jobs.tools(toolContext(h));
  await call(tools, "schedule_job", { title: "Nightly summary", prompt: "Summarize.", schedule: { everyMinutes: 30 } });

  assert.deepEqual((await h.jobs.listJobs()).map((job) => job.kind), ["helper", "consolidate"]);
  assert.deepEqual((await h.jobs.listJobs({ kind: ["tick"] })), []);
  assert.equal(await h.jobs.getJob("tick"), null);
  assert.ok(!(await call(tools, "list_jobs", {})).jobs.some((job) => job.id === "tick"));
  assert.equal((await call(tools, "list_jobs", { kind: "tick" })).invalidInput, true);
  assert.equal((await call(tools, "list_runs", { kind: "tick" })).invalidInput, true);
  assert.ok(!(await call(tools, "get_schedule", {})).upcoming.some((job) => job.id === "tick"));
  assert.notEqual((await h.runtime.status()).nextJob?.id, "tick");

  for (const [name, input] of [["update_job", { id: "tick", schedule: { everyMinutes: 5 } }], ["update_job", { id: "tick", status: "paused" }], ["cancel_job", { id: "tick" }]]) {
    assert.match((await call(tools, name, input)).error, /Unknown job "tick"/, name);
  }
  await assert.rejects(h.jobs.updateJob("tick", { status: "paused" }, "user"), (err) => err.status === 404);
  assert.equal(await h.jobs.runNow("tick", "manual"), null);
  const stored = await h.jobsStore.getJob("tick");
  assert.equal(stored.status, "active");
  assert.deepEqual(stored.schedule, { type: "every", everyMs: 60 * MIN });

  // While it runs: no run event, not in the status, not busy, not in any run listing.
  await h.timers.advance(FIRST_TICK_DELAY_MS);
  const [run] = await h.jobsStore.listRuns({ kind: "tick" });
  assert.equal(run.status, "running");
  const status = await h.runtime.status();
  assert.deepEqual(status.runs, []);
  assert.equal(status.busy, false);
  assert.deepEqual(h.jobs.running(), []);
  assert.equal(await h.jobs.getRun(run.id), null);
  await assert.rejects(h.jobs.cancelRun(run.id), (err) => err.status === 404);
  assert.ok(!(await call(tools, "get_schedule", {})).running.some((entry) => entry.kind === "tick"));
  release.resolve();
  await flush();
  assert.equal((await h.jobsStore.getRun(run.id)).status, "succeeded", "its runs are still stored");
  assert.deepEqual((await h.jobs.listRuns()).filter((entry) => entry.kind === "tick"), []);
  assert.deepEqual((await call(tools, "list_runs", {})).runs.filter((entry) => entry.kind === "tick"), []);
  assert.ok(!h.events.some((event) => event.type === "run" && event.run.kind === "tick"));
  assert.ok(!h.events.some((event) => event.type === "tick"));
  assert.deepEqual((await h.hub.activity.list({})).filter((entry) => entry.refs.jobId === "tick" || entry.refs.runId === run.id), []);
});

test("a failed refresh is recorded on its run and the job keeps its hourly cadence", async (t) => {
  const h = await started(jobsHarness(t, { jobs: { tick: async () => { throw new Error("gh exploded"); } } }));
  for (let i = 0; i < 7; i++) await h.timers.advance(i === 0 ? FIRST_TICK_DELAY_MS : 2 * 60 * MIN);
  const runs = await h.jobsStore.listRuns({ kind: "tick" });
  assert.ok(runs.length >= 5);
  assert.equal(runs[0].status, "failed");
  assert.match(runs[0].error, /gh exploded/);
  assert.equal((await h.jobsStore.getJob("tick")).status, "active", "never marked failed");
});
