import assert from "node:assert/strict";
import test from "node:test";
import { jobRuns, jobs } from "../src/db/schema.ts";
import { createPgJobsStore } from "../src/orchestrator/jobs/pg-store.ts";
import { MAX_RUN_LOG_LINES, createMemoryJobsStore } from "../src/orchestrator/jobs/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const T0 = 1_700_000_000_000;

function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (at) => { now = at; }, add: (ms) => { now += ms; } };
}

const every = (minutes) => ({ type: "every", everyMs: minutes * 60_000 });

function jobInput(overrides = {}) {
  return { kind: "helper", title: "Summarize the day", schedule: every(10), payload: { prompt: "Summarize." }, nextRunAt: T0 + 60_000, createdBy: "agent", ...overrides };
}

function run(id, overrides = {}) {
  return {
    id, jobId: "j1", kind: "helper", threadId: "main", parentRunId: null, status: "running", trigger: "schedule", startedAt: T0, finishedAt: null,
    model: null, usage: null, log: [], result: null, summary: null, error: null, ...overrides,
  };
}

const intentInput = (overrides = {}) => ({ text: "Tell me when #42 merges", trigger: "acme/app#42 is merged", action: "Tell me", ...overrides });

async function rejectsWith(promise, status, pattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Shared behaviour: every backend must pass these
// ---------------------------------------------------------------------------------------------

const backends = [
  ["memory", async () => { const c = clock(); return { store: createMemoryJobsStore({ now: c.now }), clock: c }; }],
  ["postgres", async (t) => {
    const { db } = await temporaryDatabase(t);
    const c = clock();
    return { store: createPgJobsStore({ db, now: c.now }), clock: c, db, another: () => createPgJobsStore({ db, now: c.now }) };
  }],
];

for (const [label, open] of backends) {
  test(`${label}: jobs are created with defaults, listed by next run, updated, and 404 when unknown`, async (t) => {
    const { store, clock } = await open(t);
    await store.ready;
    assert.deepEqual(await store.listJobs(), []);
    const a = await store.createJob(jobInput({ title: "  Later\n job ", nextRunAt: T0 + 120_000 }));
    assert.match(a.id, /^[A-Za-z0-9_-]{8}$/);
    assert.deepEqual(a, {
      id: a.id, kind: "helper", title: "Later job", schedule: every(10), payload: { prompt: "Summarize." }, status: "active", nextRunAt: T0 + 120_000,
      lastRunAt: null, lastRunId: null, intentId: null, threadId: null, createdBy: "agent", failures: 0, createdAt: T0, updatedAt: T0,
    });
    clock.add(1);
    const b = await store.createJob(jobInput({ title: "Sooner", nextRunAt: T0 + 60_000 }));
    const paused = await store.createJob(jobInput({ title: "Paused", status: "paused", nextRunAt: T0 }));
    assert.equal(paused.nextRunAt, null, "only an active job is scheduled");
    assert.deepEqual((await store.listJobs()).map((job) => job.title), ["Sooner", "Later job", "Paused"]);
    assert.deepEqual((await store.listJobs({ status: ["paused"] })).map((job) => job.id), [paused.id]);
    assert.deepEqual((await store.listJobs({ kind: ["tick"] })), []);
    assert.deepEqual((await store.listJobs({ status: [] })), []);

    clock.add(10);
    const updated = await store.updateJob(b.id, { title: "Renamed", failures: 2, payload: { prompt: "x" } });
    assert.equal(updated.title, "Renamed");
    assert.equal(updated.updatedAt, T0 + 11);
    assert.deepEqual(await store.getJob(b.id), updated);
    const cancelled = await store.updateJob(a.id, { status: "cancelled" });
    assert.equal(cancelled.nextRunAt, null);
    assert.equal(await store.getJob("nope"), null);
    await rejectsWith(store.updateJob("nope", { title: "x" }), 404, /Unknown job "nope"/);
    await rejectsWith(store.createJob(jobInput({ title: "   " })), 400, /needs a title/);
    await rejectsWith(store.createJob(jobInput({ kind: "bogus" })), 400, /Unknown job kind/);
  });

  test(`${label}: ensureJob inserts a fixed id once and answers the stored job afterwards`, async (t) => {
    const { store } = await open(t);
    const first = await store.ensureJob(jobInput({ id: "tick", kind: "tick", title: "Check for changes", createdBy: "system" }));
    assert.equal(first.created, true);
    assert.equal(first.job.id, "tick");
    await store.updateJob("tick", { title: "Renamed" });
    const second = await store.ensureJob(jobInput({ id: "tick", kind: "tick", title: "Other", createdBy: "system" }));
    assert.equal(second.created, false);
    assert.equal(second.job.title, "Renamed");
    await rejectsWith(store.createJob(jobInput({ id: "tick" })), 409, /already exists/);
  });

  test(`${label}: claimDue leases due jobs soonest first, skips leased and excluded ones, and a lapsed lease is claimable again`, async (t) => {
    const { store, clock } = await open(t);
    const late = await store.createJob(jobInput({ title: "late", nextRunAt: T0 - 1_000 }));
    const early = await store.createJob(jobInput({ title: "early", nextRunAt: T0 - 5_000 }));
    const future = await store.createJob(jobInput({ title: "future", nextRunAt: T0 + 60_000 }));
    await store.createJob(jobInput({ title: "paused", status: "paused", nextRunAt: T0 - 9_000 }));

    assert.deepEqual((await store.nextDue()).id, early.id);
    const claimed = await store.claimDue({ limit: 5, leaseMs: 10_000 });
    assert.deepEqual(claimed.map((job) => job.id), [early.id, late.id]);
    assert.deepEqual(await store.claimDue({ limit: 5, leaseMs: 10_000 }), [], "leased jobs are not claimed twice");
    assert.equal((await store.nextDue()).id, future.id, "leased jobs are not due for the status line");
    assert.equal(await store.claimJob(early.id, 10_000), null, "nor claimed by run-now");

    // The worker that held them died: the lease runs out.
    clock.add(10_000);
    assert.deepEqual((await store.claimDue({ limit: 1, leaseMs: 10_000 })).map((job) => job.id), [early.id], "limit applies");
    assert.deepEqual((await store.claimDue({ limit: 5, leaseMs: 10_000, exclude: [late.id] })), []);
    assert.deepEqual((await store.claimDue({ limit: 5, leaseMs: 10_000 })).map((job) => job.id), [late.id]);
    assert.deepEqual(await store.claimDue({ limit: 0, leaseMs: 10_000 }), []);

    // Renewal keeps a running job's lease; release drops it and reschedules.
    clock.add(5_000);
    await store.renewLeases([late.id], 10_000);
    clock.add(6_000);
    assert.deepEqual((await store.claimDue({ limit: 5, leaseMs: 10_000 })).map((job) => job.id), [early.id], "early's lease lapsed; late's was renewed");
    const released = await store.release(late.id, { nextRunAt: clock.now() + 60_000, lastRunAt: clock.now(), lastRunId: "r1", failures: 0 });
    assert.equal(released.lastRunId, "r1");
    assert.equal((await store.claimJob(late.id, 10_000)).id, late.id, "released, so run-now may claim it");
  });

  test(`${label}: pruneJobs deletes only done and cancelled jobs older than the cutoff`, async (t) => {
    const { store, clock } = await open(t);
    const done = await store.createJob(jobInput({ title: "done" }));
    await store.updateJob(done.id, { status: "done" });
    const cancelled = await store.createJob(jobInput({ title: "cancelled" }));
    await store.updateJob(cancelled.id, { status: "cancelled" });
    const failed = await store.createJob(jobInput({ title: "failed" }));
    await store.updateJob(failed.id, { status: "failed" });
    const active = await store.createJob(jobInput({ title: "active" }));
    clock.add(1_000);
    const recent = await store.createJob(jobInput({ title: "recent" }));
    await store.updateJob(recent.id, { status: "done" });
    assert.equal(await store.pruneJobs(T0 + 500), 2);
    assert.deepEqual((await store.listJobs()).map((job) => job.title).sort(), ["active", "failed", "recent"]);
    assert.equal(await store.getJob(active.id) !== null, true);
  });

  test(`${label}: claimJob leases an active job whether or not it is due, never an inactive one`, async (t) => {
    const { store } = await open(t);
    const job = await store.createJob(jobInput({ nextRunAt: T0 + 3_600_000 }));
    const paused = await store.createJob(jobInput({ status: "paused", nextRunAt: null }));
    assert.equal((await store.claimJob(job.id, 1_000)).id, job.id);
    assert.equal(await store.claimJob(paused.id, 1_000), null);
    assert.equal(await store.claimJob("nope", 1_000), null);
  });

  test(`${label}: runs are stored, finished, listed newest first with filters and paging, and pruned`, async (t) => {
    const { store } = await open(t);
    const stored = [];
    for (let i = 0; i < 6; i++) {
      stored.push(await store.insertRun(run(`r${i}`, { startedAt: T0 + i * 1_000, jobId: i % 2 ? "j1" : "j2", kind: i === 5 ? "chat" : "helper", threadId: i < 3 ? "main" : "side" })));
    }
    // Same start time: the id breaks the tie so pages never overlap.
    stored.push(await store.insertRun(run("r6", { startedAt: T0 + 5_000, jobId: null, kind: "chat" })));
    const finished = { ...stored[1], status: "succeeded", finishedAt: T0 + 1_500, usage: { inputTokens: 3, outputTokens: 4 }, model: { provider: "anthropic", model: "m" }, summary: "done", result: { text: "hi" } };
    await store.updateRun(finished);
    assert.deepEqual(await store.getRun("r1"), finished);
    assert.equal(await store.getRun("nope"), null);

    assert.deepEqual((await store.listRuns()).map((r) => r.id), ["r6", "r5", "r4", "r3", "r2", "r1", "r0"]);
    assert.deepEqual((await store.listRuns({ jobId: "j1" })).map((r) => r.id), ["r5", "r3", "r1"]);
    assert.deepEqual((await store.listRuns({ kind: "chat" })).map((r) => r.id), ["r6", "r5"]);
    assert.deepEqual((await store.listRuns({ threadId: "side" })).map((r) => r.id), ["r5", "r4", "r3"]);
    assert.deepEqual((await store.listRuns({ status: ["succeeded"] })).map((r) => r.id), ["r1"]);
    const page1 = await store.listRuns({ limit: 3 });
    const page2 = await store.listRuns({ limit: 3, before: page1.at(-1).id });
    assert.deepEqual([...page1, ...page2].map((r) => r.id), ["r6", "r5", "r4", "r3", "r2", "r1"]);
    assert.deepEqual(await store.listRuns({ before: "nope" }), []);

    // Logs are capped; an id that collides is re-rolled rather than overwriting.
    const long = await store.insertRun(run("r0", { startedAt: T0 + 9_000, log: Array.from({ length: MAX_RUN_LOG_LINES + 5 }, (_, i) => `line ${i} ${"x".repeat(i === MAX_RUN_LOG_LINES + 4 ? 900 : 1)}`) }));
    assert.notEqual(long.id, "r0");
    assert.equal(long.log.length, MAX_RUN_LOG_LINES);
    assert.ok(long.log.at(-1).length <= 500);
    assert.equal((await store.getRun("r0")).startedAt, T0);

    // Pruning keeps the newest finished runs and never a running one.
    const removed = await store.pruneRuns(3);
    assert.ok(removed > 0);
    const left = (await store.listRuns({ limit: 100 })).map((r) => r.id);
    assert.ok(left.includes(long.id) && left.includes("r6") && left.includes("r5"), left.join(","));
    assert.ok(left.includes("r0") && left.includes("r2"), "running runs stay however old");
    assert.ok(!left.includes("r1"), "an old finished run goes");
  });

  test(`${label}: intents are created with defaults, listed newest first, updated, and validated`, async (t) => {
    const { store, clock } = await open(t);
    const intent = await store.createIntent(intentInput({ scope: { pulls: [{ repo: "acme/app", number: 42, url: "u" }, { repo: "acme/app", number: 42, url: "u" }] } }));
    assert.deepEqual(intent, {
      id: intent.id, text: "Tell me when #42 merges", trigger: "acme/app#42 is merged", action: "Tell me", notes: "",
      scope: { projectIds: [], sessionIds: [], pulls: [{ repo: "acme/app", number: 42, url: "u" }], repos: [], people: [], taskTypes: [] },
      status: "active", expiresAt: null, fireBudget: 1, fires: 0, cooldownMs: 0, lastFiredAt: null, lastCheckedAt: null, threadId: null,
      createdAt: T0, updatedAt: T0,
    });
    clock.add(5);
    const unlimited = await store.createIntent(intentInput({ id: "w1", fireBudget: null, cooldownMs: 60_000, threadId: "t1", expiresAt: T0 + 1_000 }));
    assert.equal(unlimited.id, "w1");
    assert.deepEqual((await store.listIntents()).map((i) => i.id), ["w1", intent.id]);
    const fired = await store.updateIntent(intent.id, { fires: 1, lastFiredAt: T0 + 5, status: "done", notes: "Merged." });
    assert.equal(fired.updatedAt, T0 + 5);
    assert.deepEqual(await store.getIntent(intent.id), fired);
    assert.deepEqual((await store.listIntents({ status: ["active"] })).map((i) => i.id), ["w1"]);
    assert.equal(await store.getIntent("nope"), null);
    await rejectsWith(store.updateIntent("nope", { notes: "x" }), 404, /Unknown intent/);
    await rejectsWith(store.createIntent(intentInput({ trigger: " " })), 400, /needs trigger/);
    await rejectsWith(store.createIntent(intentInput({ fireBudget: 0 })), 400, /fireBudget/);
    await rejectsWith(store.updateIntent("w1", { status: "paused" }), 400, /Unknown intent status/);
    await rejectsWith(store.createIntent(intentInput({ id: "w1" })), 409, /already exists/);
  });
}

// ---------------------------------------------------------------------------------------------
// Postgres specifics
// ---------------------------------------------------------------------------------------------

test("postgres: two workers claiming at once never lease the same job (FOR UPDATE SKIP LOCKED)", async (t) => {
  const { db, another } = await backends[1][1](t);
  const a = createPgJobsStore({ db, now: () => T0 });
  const b = another();
  for (let i = 0; i < 12; i++) await a.createJob(jobInput({ title: `job ${i}`, nextRunAt: T0 - i }));
  const [left, right] = await Promise.all([a.claimDue({ limit: 8, leaseMs: 60_000 }), b.claimDue({ limit: 8, leaseMs: 60_000 })]);
  const ids = [...left, ...right].map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length, "no job claimed twice");
  assert.equal(ids.length, 12);
  const rows = await db.select({ lockedUntil: jobs.lockedUntil }).from(jobs);
  assert.ok(rows.every((row) => row.lockedUntil === T0 + 60_000));
});

test("postgres: records are stripped of NUL and the run table prunes itself on insert", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgJobsStore({ db, now: () => T0 });
  const job = await store.createJob(jobInput({ title: "nul\u0000title", payload: { prompt: "a\u0000b" } }));
  assert.equal(job.title, "nultitle");
  assert.equal((await store.getJob(job.id)).payload.prompt, "ab");
  const intent = await store.createIntent(intentInput({ notes: "x\u0000y" }));
  assert.equal((await store.getIntent(intent.id)).notes, "xy");
  await store.insertRun(run("r1", { log: ["cat\u0000binary"] }));
  assert.deepEqual((await store.getRun("r1")).log, ["catbinary"]);
  const rows = await db.select().from(jobRuns);
  assert.equal(rows.length, 1);
});
