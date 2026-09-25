import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { createOrchestratorRuntime } from "../src/orchestrator/runtime.ts";
import { BACKOFF_BASE_MS, MAX_FAILURES, backoff } from "../src/orchestrator/jobs/service.ts";
import { createPgJobsStore } from "../src/orchestrator/jobs/pg-store.ts";
import { FIRST_TICK_DELAY_MS } from "../src/orchestrator/jobs/tick-job.ts";
import { LEASE_MS, POLL_MS } from "../src/orchestrator/jobs/worker.ts";
import { T0, deferred, flush, jobsHarness, started, textStep } from "./fixtures/jobs-harness.mjs";
import { fakeDeps, fakePresence, fakeSettings, fakeTimers } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const MIN = 60_000;
/** Jobs written straight to the store are found on the worker's next look, one poll after start. */
const DUE = T0 + POLL_MS;

function helperJob(overrides = {}) {
  return { kind: "helper", title: "Summarize", schedule: { type: "every", everyMs: 5 * MIN }, payload: { prompt: "Summarize the day." }, nextRunAt: T0 + MIN, createdBy: "agent", threadId: "main", ...overrides };
}

/** A model whose every call waits until the test releases it with a text answer. */
function heldModel() {
  const waiting = [];
  return {
    waiting,
    doGenerate: () => {
      const step = deferred();
      waiting.push(step);
      return step.promise;
    },
    release(text = "Done.") {
      waiting.shift().resolve(textStep(text));
    },
  };
}

test("a due job is claimed and run once; its run is recorded and the job is released with its next run", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("Three sessions finished today.")] }));
  const job = await h.jobsStore.createJob(helperJob());
  await h.timers.advance(MIN);
  await flush();

  const [run] = await h.jobs.listRuns({ jobId: job.id });
  assert.equal(run.status, "succeeded");
  assert.equal(run.kind, "helper");
  assert.equal(run.trigger, "schedule");
  assert.equal(run.summary, "Three sessions finished today.");
  assert.deepEqual(run.model, { provider: "anthropic", model: "claude-opus-5-5" }, "the helper's turn recorded into the job's run");
  assert.equal(run.usage.inputTokens, 10);
  assert.equal((await h.jobs.listRuns({ kind: "helper" })).length, 1, "one firing, one run");
  const after = await h.jobs.getJob(job.id);
  assert.equal(after.lastRunId, run.id);
  assert.equal(after.lastRunAt, T0 + MIN);
  assert.equal(after.nextRunAt, T0 + MIN + 5 * MIN);
  assert.equal(after.failures, 0);
  // The answer went to the job's thread, marked with the run.
  const [note] = await h.runtime.history();
  assert.equal(note.parts[0].text, "Three sessions finished today.");
  assert.deepEqual(note.metadata.run, { id: run.id, kind: "helper" });
  assert.deepEqual(h.events.filter((event) => event.type === "run" && event.run.id === run.id).map((event) => event.run.status), ["running", "succeeded"]);
  assert.ok(h.events.some((event) => event.type === "jobs"));
  const finished = await h.hub.activity.list({ kind: "run.finished" });
  assert.equal(finished[0].refs.runId, run.id);
});

test("jobs run concurrently up to the limit, never two runs of one job, and run-now answers the run in progress", async (t) => {
  const model = heldModel();
  const h = await started(jobsHarness(t, { doGenerate: model.doGenerate, jobs: { worker: { concurrency: 2 } } }));
  const a = await h.jobsStore.createJob(helperJob({ title: "a", nextRunAt: DUE - 3 }));
  const b = await h.jobsStore.createJob(helperJob({ title: "b", nextRunAt: DUE - 2 }));
  const c = await h.jobsStore.createJob(helperJob({ title: "c", nextRunAt: DUE - 1 }));
  assert.equal(await h.jobs.runNow("nope", "manual"), null);
  await h.timers.advance(POLL_MS);
  await flush();
  assert.equal(model.waiting.length, 2, "two at a time");
  const running = h.jobs.running().filter((run) => run.kind === "helper");
  assert.deepEqual(running.map((run) => run.jobId).sort(), [a.id, b.id].sort());
  assert.equal((await h.runtime.status()).runs.length, 2);

  const again = await h.jobs.runNow(a.id, "manual");
  assert.equal(again.id, running.find((run) => run.jobId === a.id).id, "the run already going");
  assert.equal(model.waiting.length, 2);

  model.release("a done");
  await flush();
  assert.equal(model.waiting.length, 2, "the third starts as soon as a slot frees");
  assert.ok(h.jobs.running().some((run) => run.jobId === c.id));
  model.release("b done");
  model.release("c done");
  await flush();
  assert.equal(h.jobs.running().length, 0);
  for (const job of [a, b, c]) assert.equal((await h.jobs.listRuns({ jobId: job.id })).length, 1);
});

test("a claim a dead process left behind is honoured until its lease runs out", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("ran")] }));
  const job = await h.jobsStore.createJob(helperJob({ nextRunAt: T0 }));
  // Another worker claims it and dies without releasing it.
  const [stolen] = await h.jobsStore.claimDue({ limit: 1, leaseMs: LEASE_MS });
  assert.equal(stolen.id, job.id);
  await h.timers.advance(POLL_MS * 2);
  assert.equal((await h.jobs.listRuns({ jobId: job.id })).length, 0, "leased elsewhere, so not run");
  await h.timers.advance(LEASE_MS);
  await flush();
  const runs = await h.jobs.listRuns({ jobId: job.id });
  assert.equal(runs.length, 1, "the lease lapsed and the worker ran it");
  assert.equal(runs[0].status, "succeeded");
});

test("a long run keeps renewing its lease, so no other worker claims it meanwhile", async (t) => {
  const model = heldModel();
  const h = await started(jobsHarness(t, { doGenerate: model.doGenerate, jobs: { worker: { leaseMs: 10 * MIN, renewMs: 3 * MIN } } }));
  const job = await h.jobsStore.createJob(helperJob({ nextRunAt: DUE }));
  await h.timers.advance(POLL_MS);
  await flush();
  assert.equal(model.waiting.length, 1);
  await h.timers.advance(25 * MIN);
  assert.equal(await h.jobsStore.claimJob(job.id, MIN), null, "still leased after more than two lease periods");
  model.release();
  await flush();
  assert.ok(await h.jobsStore.claimJob(job.id, MIN), "released once done");
});

test("presence changes replan jobs whose cadence follows it, and only those", async (t) => {
  const h = await started(jobsHarness(t, { presence: 0, doGenerate: [textStep("one"), textStep("two")] }));
  const aware = await h.jobsStore.createJob(helperJob({ title: "aware", schedule: { type: "every", everyMs: 5 * MIN, idleEveryMs: 30 * MIN }, nextRunAt: DUE }));
  const plain = await h.jobsStore.createJob(helperJob({ title: "plain", nextRunAt: DUE }));
  await h.timers.advance(POLL_MS);
  await flush();
  assert.equal((await h.jobs.getJob(aware.id)).nextRunAt, DUE + 30 * MIN, "idle cadence with nobody present");
  assert.equal((await h.jobs.getJob(plain.id)).nextRunAt, DUE + 5 * MIN);

  h.timers.tick(MIN);
  h.presence.set(1);
  await flush();
  assert.equal((await h.jobs.getJob(aware.id)).nextRunAt, DUE + 5 * MIN, "counted from the last run with the attended cadence");
  assert.equal((await h.jobs.getJob(plain.id)).nextRunAt, DUE + 5 * MIN, "untouched");
  h.presence.set(0);
  await flush();
  assert.equal((await h.jobs.getJob(aware.id)).nextRunAt, DUE + 30 * MIN);
});

test("consecutive failures back off and mark a job failed; the tick keeps going however often it fails", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: async () => { throw new Error("provider down"); },
    jobs: { tick: async () => { throw new Error("world unreachable"); } },
  }));
  const job = await h.jobsStore.createJob(helperJob({ schedule: { type: "every", everyMs: MIN }, nextRunAt: DUE }));
  for (let failures = 1; failures <= MAX_FAILURES; failures++) {
    const before = await h.jobs.getJob(job.id);
    await h.timers.advance(Math.max(0, before.nextRunAt - h.timers.now()));
    await flush();
    const after = await h.jobs.getJob(job.id);
    assert.equal(after.failures, failures);
    if (failures < MAX_FAILURES) {
      assert.equal(after.status, "active");
      assert.equal(after.nextRunAt, after.lastRunAt + Math.max(MIN, backoff(failures)), `backoff after ${failures}`);
    }
  }
  const failed = await h.jobs.getJob(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.nextRunAt, null);
  const runs = await h.jobs.listRuns({ jobId: job.id, limit: 10 });
  assert.equal(runs.length, MAX_FAILURES);
  assert.ok(runs.every((run) => run.status === "failed" && /provider down/.test(run.error)));
  assert.match((await h.hub.activity.list({ kind: "job.failed" }))[0].summary, /failed 5 times/);
  assert.equal(backoff(1), BACKOFF_BASE_MS);
  assert.equal(backoff(3), 4 * BACKOFF_BASE_MS);
  assert.equal(backoff(20), 60 * MIN);

  // Resuming a failed job clears its failures.
  const resumed = await h.jobs.updateJob(job.id, { status: "active" }, "user");
  assert.equal(resumed.status, "active");
  assert.equal(resumed.failures, 0);

  for (let i = 0; i < MAX_FAILURES + 2; i++) await h.timers.advance(2 * 60 * MIN);
  const tick = await h.jobsStore.getJob("tick");
  assert.equal(tick.status, "active", "the world refresh never fails for good");
  assert.ok(tick.failures >= MAX_FAILURES + 2, "every failure counted");
  assert.ok(tick.nextRunAt > h.timers.now());
});

test("an at job runs once and is done; a run left waiting on an approval keeps the job for run-now", async (t) => {
  let pending = false;
  const approvals = () => ({
    ready: Promise.resolve(), gate: (tools) => tools, pending: async () => [], hasPendingFor: async () => pending, guardAction: async () => null,
  });
  const h = await started(jobsHarness(t, { doGenerate: [textStep("once"), textStep("asked"), textStep("resumed")], approvals }));
  const once = await h.jobsStore.createJob(helperJob({ schedule: { type: "at", at: T0 + MIN }, nextRunAt: T0 + MIN }));
  await h.timers.advance(MIN);
  await flush();
  assert.equal((await h.jobs.getJob(once.id)).status, "done");
  assert.equal((await h.jobs.getJob(once.id)).nextRunAt, null);

  pending = true;
  const gated = await h.jobsStore.createJob(helperJob({ schedule: { type: "at", at: T0 + 2 * MIN }, nextRunAt: T0 + 2 * MIN }));
  await h.timers.advance(MIN);
  await flush();
  const [waiting] = await h.jobs.listRuns({ jobId: gated.id });
  assert.equal(waiting.status, "awaiting_approval");
  const held = await h.jobs.getJob(gated.id);
  assert.equal(held.status, "active");
  assert.equal(held.nextRunAt, null, "not scheduled again on its own");

  pending = false;
  const resumed = await h.jobs.runNow(gated.id, "approval");
  assert.equal(resumed.trigger, "approval");
  await flush();
  assert.equal((await h.jobs.getRun(resumed.id)).status, "succeeded");
  assert.equal((await h.jobs.getJob(gated.id)).status, "done");
});

test("a run cancelled by the user ends as cancelled and its once-only job with it; dispose aborts runs and stops the worker", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: ({ abortSignal }) => new Promise((_, reject) => abortSignal?.addEventListener("abort", () => reject(new Error("aborted")))),
  }));
  const once = await h.jobsStore.createJob(helperJob({ schedule: { type: "at", at: DUE }, nextRunAt: DUE }));
  await h.timers.advance(POLL_MS);
  await flush();
  const [run] = h.jobs.running().filter((entry) => entry.jobId === once.id);
  assert.equal(await h.jobs.cancelRun(run.id), true);
  await flush();
  assert.equal((await h.jobs.getRun(run.id)).status, "cancelled");
  assert.equal((await h.jobs.getJob(once.id)).status, "cancelled");
  assert.equal(await h.jobs.cancelRun(run.id), false, "no longer running");
  await assert.rejects(h.jobs.cancelRun("nope"), (err) => err.status === 404);

  const recurring = await h.jobsStore.createJob(helperJob({ nextRunAt: h.timers.now() }));
  await h.timers.advance(POLL_MS);
  await flush();
  const [live] = h.jobs.running().filter((entry) => entry.jobId === recurring.id);
  assert.ok(live);
  await h.runtime.dispose();
  assert.equal((await h.jobs.getRun(live.id)).status, "cancelled");
  const after = await h.jobs.getJob(recurring.id);
  assert.equal(after.status, "active", "a shutdown is not the job's fault");
  assert.equal(after.failures, 0);
  assert.equal(h.timers.pending.length, 0, "no timer left behind");
  assert.equal(await h.jobs.runNow(recurring.id, "manual"), null, "nothing runs after dispose");
});

test("the world refresh is seeded a minute after start and runs through the worker, but is never the next job shown", async (t) => {
  const h = await started(jobsHarness(t));
  const tick = await h.jobsStore.getJob("tick");
  assert.deepEqual(
    { kind: tick.kind, createdBy: tick.createdBy, schedule: tick.schedule, nextRunAt: tick.nextRunAt, title: tick.title },
    { kind: "tick", createdBy: "system", schedule: { type: "every", everyMs: 60 * MIN }, nextRunAt: T0 + FIRST_TICK_DELAY_MS, title: "Refresh the world" },
  );
  assert.equal((await h.jobsStore.nextDue()).id, "tick", "the worker still sees it");
  assert.notEqual((await h.jobs.nextDue())?.id, "tick");
  await h.timers.advance(FIRST_TICK_DELAY_MS);
  assert.equal(h.ticks.length, 1);
  const [run] = await h.jobsStore.listRuns({ jobId: "tick" });
  assert.deepEqual(run.result, { changes: 0, released: [], woken: [], log: ["Nothing changed."], error: null });
  assert.equal(run.summary, "Nothing changed.");
  assert.equal(run.model, null, "no model was called");
  assert.ok(!h.events.some((event) => event.type === "run" && event.run.kind === "tick"));
});

test("postgres: a job created elsewhere wakes the worker through NOTIFY, without waiting for the poll", async (t) => {
  const database = await temporaryDatabase(t);
  const timers = fakeTimers();
  const { deps } = fakeDeps({});
  const runtime = createOrchestratorRuntime({
    store: createMemoryOrchestratorStore(), settingsStore: fakeSettings({ key: null }), deps, timers, presence: fakePresence(0),
    db: database.db, sql: database.sql,
  });
  t.after(() => runtime.dispose());
  await runtime.ready;
  await flush();
  // Another process schedules a helper due now and announces it.
  const other = createPgJobsStore({ db: database.db, now: () => timers.now() });
  const job = await other.createJob(helperJob({ schedule: { type: "at", at: T0 }, nextRunAt: T0 }));
  await database.sql.notify("portal_jobs", "");
  let runs = [];
  for (let i = 0; i < 100 && runs.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    runs = await runtime.hub.jobs.listRuns({ jobId: job.id });
  }
  assert.equal(runs.length, 1, "the worker ran it without any timer firing");
  // No key is stored, so the helper could not run: recorded, and not counted against the job.
  for (let i = 0; i < 50 && runs[0].status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    runs = await runtime.hub.jobs.listRuns({ jobId: job.id });
  }
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "not ready");
  assert.equal((await runtime.hub.jobs.getJob(job.id)).failures, 0);
});
