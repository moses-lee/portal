/**
 * Jobs, runs, and intents: the orchestrator's scheduled background work. Builds the store (Postgres
 * in the live server, in memory in tests), the run bookkeeping, the worker, and each job kind's
 * executor, and answers the `JobsService` surface the runtime, the routes, and the tools use.
 *
 * One firing of a job: the worker claims it (with a lease), a run starts, the kind's executor runs
 * (the tick, an intent check, a helper), the run finishes with whatever model and usage its turn
 * recorded, and the job is released with its next run time. Consecutive failures back off and, past
 * `MAX_FAILURES`, mark the job failed (never the tick or memory curation).
 */
import type { ActivityActor } from "@portal/contracts/activity";
import type { IntentPatch, Job, JobKind, JobRun, RunTrigger } from "@portal/contracts/jobs";
import type { JobsService, OrchestratorHub } from "../hub.ts";
import { httpError } from "../ops.ts";
import { performTick } from "../tick.ts";
import type { ToolContext } from "../tools/index.ts";
import type { TickReason, TickReport } from "../types.ts";
import { TICK_JOB_ID, type TickRunner, createCore, jobRefs } from "./core.ts";
import { createHelpers } from "./helpers.ts";
import { createIntents } from "./intents.ts";
import type { KindContext, KindResult } from "./kinds.ts";
import { createPgJobsStore } from "./pg-store.ts";
import { createRuns } from "./runs.ts";
import { followsPresence, nextRunAt, replanned } from "./schedule.ts";
import { type JobChanges, type JobFilter, type JobsStore, type RunFilter, createMemoryJobsStore } from "./store.ts";
import { createConsolidation } from "./consolidate-job.ts";
import { ensureTickJob, runTickJob, skippedReport, syncTickSchedule } from "./tick-job.ts";
import { jobTools } from "./tools.ts";
import { type Execution, type WorkerOptions, createWorker } from "./worker.ts";

/** Consecutive failed runs after which a job is marked failed (the tick keeps going). */
export const MAX_FAILURES = 5;
/** Delay after the first failure; it doubles with each further one, up to `MAX_BACKOFF_MS`. */
export const BACKOFF_BASE_MS = 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
/** Tick reports `listTicks` answers. */
export const TICK_HISTORY = 50;
/** Finished (done or cancelled) jobs are kept this long, then deleted; their runs stay until pruned. */
export const FINISHED_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** How often the worker looks for finished jobs to delete. */
export const PRUNE_EVERY_MS = 60 * 60_000;

export function backoff(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export type JobsOptions = {
  /** Replaces the store the hub's database implies. */
  store?: JobsStore;
  /** Runs one tick into the report; the runtime supplies `performTick` with its self tools and thread trimming. */
  tick?: TickRunner;
  /** The runtime's self tools, for the turns jobs run. */
  self?: () => ToolContext["self"];
  /** Keeps a thread bounded after a job posted to it. */
  trimThread?: (threadId: string) => Promise<void>;
  worker?: WorkerOptions;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isTickReport(value: unknown): value is TickReport {
  return !!value && typeof value === "object" && typeof (value as TickReport).id === "string" && Array.isArray((value as TickReport).log)
    && typeof (value as TickReport).startedAt === "number";
}

export function createJobsService(hub: OrchestratorHub, options: JobsOptions = {}): JobsService {
  const now = () => hub.timers.now();
  const store = options.store ?? (hub.db ? createPgJobsStore({ db: hub.db, now }) : createMemoryJobsStore({ now }));
  const runs = createRuns(hub, store);
  const trimThread = options.trimThread ?? (async () => {});
  const fallbackSelf: ToolContext["self"] = {
    digest: async () => { throw new Error("The tick digest is not available in this turn."); },
    schedule: async () => ({ ready: false, intervalMinutes: 0, idleIntervalMinutes: 0, presence: hub.presence.count(), nextTickAt: null, lastTickAt: null }),
    lastTick: async () => core.lastTick,
  };
  const self = () => options.self?.() ?? fallbackSelf;
  const core = createCore({
    hub, store, runs, self, trimThread,
    tick: options.tick ?? ((report, { signal }) => performTick(hub, report, { self: self(), signal, trimThread })),
  });
  const intents = createIntents(core);
  const helpers = createHelpers(core);
  const consolidation = createConsolidation(core);
  const kinds: Record<JobKind, (ctx: KindContext) => Promise<KindResult>> = {
    tick: (ctx) => runTickJob(core, ctx),
    intent_check: intents.check,
    helper: helpers.run,
    consolidate: consolidation.run,
  };
  /** Job runs in progress in this process, by run id, so they can be cancelled. */
  const controllers = new Map<string, { jobId: string; controller: AbortController; byUser: boolean }>();
  let prunedAt = -Infinity;
  const worker = createWorker(core, {
    execute,
    async beforePump() {
      await intents.expireDue().catch((err: unknown) => console.error("Could not expire intents:", err));
      if (now() - prunedAt < PRUNE_EVERY_MS) return;
      prunedAt = now();
      const removed = await store.pruneJobs(now() - FINISHED_JOB_RETENTION_MS).catch((err: unknown) => {
        console.error("Could not delete finished jobs:", err);
        return 0;
      });
      if (removed > 0) core.emitJobs();
    },
  }, options.worker);
  core.wake = () => worker.wake();
  // Cancelling a job stops the run it has in progress; the reschedule then leaves it cancelled.
  core.stopJobRuns = (jobId, exceptRunId) => {
    const stopped: string[] = [];
    for (const [runId, entry] of controllers) {
      if (entry.jobId !== jobId || runId === exceptRunId || entry.controller.signal.aborted) continue;
      entry.byUser = true;
      entry.controller.abort(new Error("The job was cancelled."));
      stopped.push(runId);
    }
    return stopped;
  };
  let disposed = false;
  const unsubscribers: (() => void)[] = [];

  // Never rejects: the runtime waits on it. Without the tick job the worker still runs the others.
  const ready = store.ready
    .then(() => ensureTickJob(core))
    .then(() => consolidation.ensure())
    .then(async () => {
      // A run still marked running belongs to a process that is gone.
      for (const stale of await store.listRuns({ status: ["running"], limit: 200 })) {
        if (runs.get(stale.id)) continue;
        await store.updateRun({ ...stale, status: "cancelled", finishedAt: now(), error: "Portal stopped while this ran." });
      }
      const [last] = await store.listRuns({ jobId: TICK_JOB_ID, status: ["succeeded", "failed", "cancelled", "awaiting_approval"], limit: 1 });
      if (!core.lastTick && isTickReport(last?.result)) core.lastTick = last.result;
    })
    .catch((err: unknown) => { console.error("Could not prepare the job store:", err); });

  function parentOf(job: Job): string | null {
    return typeof job.payload.parentRunId === "string" ? job.payload.parentRunId : null;
  }

  function execute(job: Job, trigger: RunTrigger): Execution {
    const started = runs.start({ kind: job.kind, trigger, jobId: job.id, threadId: job.threadId, parentRunId: parentOf(job), summary: job.title }, { adopt: false });
    const done = started.then((run) => fire(job, run, trigger), async (err: unknown) => {
      await store.release(job.id, { failures: job.failures + 1, nextRunAt: now() + backoff(job.failures + 1) }).catch(() => {});
      throw err;
    });
    return { started, done };
  }

  /** Run the job's kind, record the run's end, and release the job with its next run. */
  async function fire(job: Job, run: JobRun, trigger: RunTrigger): Promise<JobRun> {
    const entry = { jobId: job.id, controller: new AbortController(), byUser: false };
    controllers.set(run.id, entry);
    if (disposed) entry.controller.abort();
    const { value, error, turn } = await runs.adopting(run, () => kinds[job.kind]({ job, run, trigger, signal: entry.controller.signal }));
    controllers.delete(run.id);
    const aborted = entry.controller.signal.aborted;
    const result: KindResult = value ?? { status: aborted ? "cancelled" : "failed", error: errorMessage(error) };
    const status = aborted && result.status !== "succeeded" ? "cancelled" : result.status ?? "succeeded";
    let final: JobRun;
    try {
      final = await runs.complete(run.id, {
        status, model: turn?.model, usage: turn?.usage, log: result.log, result: result.result ?? null,
        summary: result.summary ?? turn?.summary ?? null, error: result.error ?? (status === "failed" ? turn?.error ?? null : null),
      });
    } catch (err) {
      console.error(`Could not record the end of the run of "${job.title}":`, err);
      final = { ...run, status, finishedAt: now() };
    }
    try {
      await reschedule(job, final, result, entry.byUser);
    } catch (err) {
      console.error(`Could not reschedule "${job.title}":`, err);
      await store.release(job.id, { nextRunAt: now() + BACKOFF_BASE_MS }).catch(() => {});
    }
    return final;
  }

  async function reschedule(job: Job, run: JobRun, result: KindResult, cancelledByUser: boolean): Promise<void> {
    const latest = (await store.getJob(job.id)) ?? job;
    const end = now();
    const failed = run.status === "failed" && !result.skipped;
    const failures = failed ? latest.failures + 1 : run.status === "cancelled" || result.skipped ? latest.failures : 0;
    const changes: JobChanges = { lastRunAt: end, lastRunId: run.id, failures };
    if (latest.status !== "active") {
      // Paused, cancelled, or finished while it ran: that decision stands.
    } else if (result.jobStatus) {
      changes.status = result.jobStatus;
    } else if (failed && latest.kind !== "tick" && latest.kind !== "consolidate" && failures >= MAX_FAILURES) {
      changes.status = "failed";
      void hub.activity.log({
        actor: "system", kind: "job.failed", summary: `"${latest.title}" failed ${failures} times in a row and was stopped`,
        refs: jobRefs(latest, run.id), detail: { error: run.error },
      });
    } else if (run.status === "awaiting_approval") {
      // Unscheduled until the user decides (see resumeAfterApproval), so a recurring job does not ask the same thing again meanwhile.
      changes.nextRunAt = null;
    } else if (latest.schedule.type === "at") {
      // A once-only job that could not run (no key yet) tries again later instead of being done.
      if (failed || result.skipped) changes.nextRunAt = end + backoff(Math.max(1, failures));
      else if (run.status === "cancelled") {
        if (cancelledByUser) changes.status = "cancelled";
        else changes.nextRunAt = end;
      } else changes.status = "done";
    } else if (result.nextRunAt !== undefined) {
      changes.nextRunAt = result.nextRunAt;
    } else {
      let next = nextRunAt(latest.schedule, { now: end, lastRunAt: end, present: core.present() });
      if (failed && next !== null) next = Math.max(next, end + backoff(failures));
      if (next === null) changes.status = "done";
      else changes.nextRunAt = next;
    }
    await store.release(job.id, changes);
    core.emitJobs();
  }

  /** Presence changed: jobs whose cadence follows it are replanned. */
  async function replanForPresence(): Promise<void> {
    const present = core.present();
    let changed = false;
    for (const job of await store.listJobs({ status: ["active"] })) {
      if (!followsPresence(job.schedule) || job.failures > 0 || worker.isRunning(job.id)) continue;
      const next = replanned(job, now(), present);
      if (next === job.nextRunAt) continue;
      await store.updateJob(job.id, { nextRunAt: next });
      changed = true;
    }
    if (changed) {
      core.emitJobs();
      core.notify();
    }
  }

  async function runNow(jobId: string, trigger: RunTrigger): Promise<JobRun | null> {
    await ready;
    if (disposed) return null;
    const current = () => runs.running().find((run) => run.jobId === jobId) ?? null;
    if (worker.isRunning(jobId)) return current();
    const job = await store.claimJob(jobId, worker.leaseMs);
    if (!job) {
      const existing = await store.getJob(jobId);
      if (!existing || existing.status !== "active") return null;
      const mine = current();
      if (mine) return mine;
      throw httpError(`"${existing.title}" is running in another Portal process.`, 409);
    }
    void hub.activity.log({ actor: trigger === "agent" ? "agent" : trigger === "approval" ? "system" : "user", kind: "job.run", summary: `Ran "${job.title}" now`, refs: jobRefs(job) });
    return worker.launch(job, trigger).started;
  }

  /**
   * An approval a job waited for was decided. Approved: the job runs again now (the approved call
   * already ran; the run carries on from there). Denied or expired: a recurring job goes back to its
   * schedule and a once-only job ends, since running it again would only ask again.
   */
  async function resumeAfterApproval(jobId: string, outcome: "approved" | "denied" | "expired"): Promise<void> {
    await ready;
    if (outcome === "approved") {
      await runNow(jobId, "approval");
      return;
    }
    const job = await store.getJob(jobId);
    if (!job || job.status !== "active" || job.nextRunAt !== null || worker.isRunning(jobId)) return;
    const why = outcome === "denied" ? "the approval it asked for was declined" : "the approval it asked for expired";
    if (job.schedule.type === "at") {
      await store.updateJob(jobId, { status: "done" });
      void hub.activity.log({ actor: "system", kind: "job.done", summary: `"${job.title}" ended: ${why}`, refs: jobRefs(job) });
    } else {
      await store.updateJob(jobId, { nextRunAt: nextRunAt(job.schedule, { now: now(), lastRunAt: job.lastRunAt ?? now(), present: core.present() }) });
      void hub.activity.log({ actor: "system", kind: "job.resumed", summary: `"${job.title}" is back on its schedule: ${why}`, refs: jobRefs(job) });
    }
    core.emitJobs();
    core.notify();
  }

  async function runTick(reason: TickReason): Promise<TickReport> {
    await ready;
    const trigger: RunTrigger = reason === "manual" ? "manual" : "schedule";
    if (disposed) return skippedReport(trigger, now(), "Portal is shutting down.");
    if (worker.isRunning(TICK_JOB_ID)) return skippedReport(trigger, now(), "Skipped: a tick is already running.");
    const job = await store.claimJob(TICK_JOB_ID, worker.leaseMs);
    if (!job) {
      const existing = await store.getJob(TICK_JOB_ID);
      return skippedReport(trigger, now(), existing && existing.status !== "active" ? `Skipped: the tick is ${existing.status}.` : "Skipped: a tick is already running.");
    }
    const run = await worker.launch(job, trigger).done;
    return isTickReport(run.result) ? run.result : skippedReport(trigger, now(), run.error ?? "The tick did not report.");
  }

  async function cancelRun(id: string): Promise<boolean> {
    const entry = controllers.get(id);
    if (entry) {
      entry.byUser = true;
      entry.controller.abort();
      return true;
    }
    if (helpers.cancel(id)) return true;
    const run = runs.get(id) ?? (await store.getRun(id));
    if (!run) throw httpError(`Unknown run "${id}".`, 404);
    if (run.status === "running" && run.kind === "chat") throw httpError("A chat turn is stopped from its thread.", 409);
    return false;
  }

  async function updateIntent(id: string, patch: IntentPatch, actor: ActivityActor) {
    if (patch.status === undefined) return intents.requireIntent(id);
    if (patch.status === "cancelled") return intents.close(id, "cancelled", { actor });
    if (patch.status === "active") return intents.reopen(id, { actor });
    throw httpError('intent patch: "status" must be active or cancelled.', 400);
  }

  return {
    ready,
    start() {
      if (disposed) return;
      unsubscribers.push(
        hub.presence.subscribe(() => { void replanForPresence().catch((err: unknown) => console.error("Could not replan jobs for presence:", err)); }),
        hub.settings.subscribe(() => { void syncTickSchedule(core).catch((err: unknown) => console.error("Could not update the tick's schedule:", err)); }),
        hub.settings.subscribe(() => { void consolidation.sync().catch((err: unknown) => console.error("Could not update memory curation's schedule:", err)); }),
        hub.memory.subscribe(() => { void consolidation.inboxChanged().catch((err: unknown) => console.error("Could not check the memory inbox:", err)); }),
      );
      worker.start();
    },
    async dispose() {
      disposed = true;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      for (const { controller } of controllers.values()) controller.abort();
      helpers.abortAll();
      await worker.dispose();
    },
    startRun: (input) => runs.start(input),
    finishRun: (id, outcome) => runs.finish(id, outcome),
    running: () => runs.running(),
    nextDue: () => store.nextDue(),
    runNow,
    resumeAfterApproval,
    listIntents: (filter) => store.listIntents(filter),
    tools: (ctx) => jobTools(core, intents, helpers, ctx),

    listJobs: (filter?: JobFilter) => store.listJobs(filter),
    getJob: (id) => store.getJob(id),
    updateJob: (id, patch, actor) => core.patchJob(id, patch, { actor }),
    listRuns: (filter?: RunFilter) => store.listRuns(filter),
    getRun: async (id) => runs.get(id) ?? store.getRun(id),
    stopJobRuns: (jobId) => core.stopJobRuns(jobId),
    cancelRun,
    getIntent: (id) => store.getIntent(id),
    createIntent: (input, how) => intents.create(input, how),
    updateIntent,
    runTick,
    lastTick: () => core.lastTick,
    async listTicks(limit = TICK_HISTORY) {
      const done = await store.listRuns({ jobId: TICK_JOB_ID, status: ["succeeded", "failed", "cancelled", "awaiting_approval"], limit });
      return done.map((run) => run.result).filter(isTickReport).reverse();
    },
    tickJob: () => store.getJob(TICK_JOB_ID),
  };
}
