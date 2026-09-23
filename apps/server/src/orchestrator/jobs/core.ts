/**
 * What the parts of the jobs domain share: the store, run bookkeeping, the options the runtime
 * supplied, and the job changes every caller goes through, so each one writes its activity entry,
 * announces `jobs`, and wakes the workers (NOTIFY) the same way.
 */
import { randomUUID } from "node:crypto";
import type { Job, JobPatch, JobRun } from "@portal/contracts/jobs";
import type { TickReport } from "@portal/contracts/orchestrator";
import type { ActivityActor } from "@portal/contracts/activity";
import type { OrchestratorHub } from "../hub.ts";
import { httpError } from "../ops.ts";
import type { ToolContext } from "../tools/index.ts";
import { MAIN_THREAD_ID } from "../types.ts";
import type { Runs } from "./runs.ts";
import { describeSchedule, parseSchedule, replanned, sameSchedule } from "./schedule.ts";
import type { JobChanges, JobsStore, NewJob } from "./store.ts";

/** The Postgres channel a job change is announced on; every worker LISTENs to it. */
export const JOBS_CHANNEL = "portal_jobs";
/** The seeded tick job. */
export const TICK_JOB_ID = "tick";

export type TickRunner = (report: TickReport, ctx: { signal: AbortSignal }) => Promise<void>;

export type JobsCore = {
  hub: OrchestratorHub;
  store: JobsStore;
  runs: Runs;
  tick: TickRunner;
  /** The runtime's self tools, for the turns jobs run. */
  self(): ToolContext["self"];
  trimThread(threadId: string): Promise<void>;
  /** Whether a browser is connected (the shorter cadences apply). */
  present(): boolean;
  /** Wake this process's worker (set once the worker exists). */
  wake(): void;
  /** Wake this process's worker and, through NOTIFY, every other one. */
  notify(): void;
  emitJobs(): void;
  emitIntents(): Promise<void>;
  scheduleJob(input: NewJob, actor: ActivityActor, refs?: { runId?: string; threadId?: string }): Promise<Job>;
  changeJob(id: string, changes: JobChanges, how: { actor: ActivityActor; summary: string; kind?: string; runId?: string }): Promise<Job>;
  /** Apply a user's or the agent's patch: status, schedule, title (see `JobPatch`). */
  patchJob(id: string, patch: unknown, how: { actor: ActivityActor; runId?: string }): Promise<Job>;
  /** Cancel (or finish) every live job of an intent. */
  endIntentJobs(intentId: string, status: "cancelled" | "done", how: { actor: ActivityActor; runId?: string }): Promise<void>;
  /** Hook set by the intents part: a check job was cancelled, so its intent goes too. */
  onCheckJobCancelled?: (job: Job, how: { actor: ActivityActor; runId?: string }) => Promise<void>;
  /** Post an assistant note to a thread as `run` did. */
  postToThread(threadId: string | null, text: string, run: Pick<JobRun, "id" | "kind">, itemIds?: string[]): Promise<void>;
  lastTick: TickReport | null;
};

const settable = new Set(["active", "paused", "cancelled"]);

export function jobRefs(job: Pick<Job, "id" | "intentId" | "threadId">, runId?: string) {
  return { jobId: job.id, ...(job.intentId ? { intentId: job.intentId } : {}), ...(job.threadId ? { threadId: job.threadId } : {}), ...(runId ? { runId } : {}) };
}

/** Reduce unknown input to a `JobPatch`, or a 400. */
export function parseJobPatch(input: unknown): JobPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("A job patch must be a JSON object.", 400);
  const body = input as Record<string, unknown>;
  const patch: JobPatch = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !settable.has(body.status)) throw httpError('job patch: "status" must be one of active, paused, cancelled.', 400);
    patch.status = body.status as JobPatch["status"];
  }
  if (body.schedule !== undefined) patch.schedule = parseSchedule(body.schedule);
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) throw httpError('job patch: "title" must be a non-empty string.', 400);
    patch.title = body.title;
  }
  return patch;
}

export function createCore(base: Pick<JobsCore, "hub" | "store" | "runs" | "tick" | "self" | "trimThread">): JobsCore {
  const { hub, store } = base;

  const core: JobsCore = {
    ...base,
    lastTick: null,
    wake: () => {},
    present: () => hub.presence.count() > 0,
    notify() {
      if (hub.sql) void hub.sql.notify(JOBS_CHANNEL, "").catch(() => {});
      core.wake();
    },
    emitJobs: () => hub.emit({ type: "jobs" }),
    async emitIntents() {
      try {
        hub.emit({ type: "intents", intents: await store.listIntents({ status: ["active"] }) });
      } catch (err) {
        console.error("Could not announce the intents:", err);
      }
    },

    async scheduleJob(input, actor, refs = {}) {
      const job = await store.createJob(input);
      void hub.activity.log({
        actor, kind: "job.scheduled", summary: `Scheduled "${job.title}" (${describeSchedule(job.schedule)})`,
        refs: { ...jobRefs(job, refs.runId), ...(refs.threadId && !job.threadId ? { threadId: refs.threadId } : {}) },
        detail: { kind: job.kind, schedule: job.schedule, nextRunAt: job.nextRunAt },
      });
      core.emitJobs();
      core.notify();
      return job;
    },

    async changeJob(id, changes, { actor, summary, kind, runId }) {
      const job = await store.updateJob(id, changes);
      void hub.activity.log({
        actor, kind: kind ?? (changes.status === "cancelled" ? "job.cancelled" : "job.updated"), summary, refs: jobRefs(job, runId),
        detail: { ...(changes.status ? { status: changes.status } : {}), ...(changes.schedule ? { schedule: changes.schedule } : {}), nextRunAt: job.nextRunAt },
      });
      core.emitJobs();
      core.notify();
      return job;
    },

    async patchJob(id, raw, { actor, runId }) {
      const patch = parseJobPatch(raw);
      const current = await store.getJob(id);
      if (!current) throw httpError(`Unknown job "${id}".`, 404);
      if (current.id === TICK_JOB_ID && patch.status === "cancelled") throw httpError("The tick cannot be cancelled; pause it or change its cadence.", 409);
      if (patch.status && (current.status === "done" || current.status === "cancelled") && patch.status !== current.status) {
        throw httpError(`This job is ${current.status}; schedule a new one instead.`, 409);
      }
      const changes: JobChanges = {};
      const parts: string[] = [];
      if (patch.title !== undefined && patch.title.trim() !== current.title) {
        changes.title = patch.title;
        parts.push(`renamed it "${patch.title.trim()}"`);
      }
      if (patch.schedule && !sameSchedule(patch.schedule, current.schedule)) {
        changes.schedule = patch.schedule;
        // A tick the agent or the user rescheduled no longer follows the settings' intervals.
        if (current.id === TICK_JOB_ID) changes.payload = { ...current.payload, followsSettings: false };
        parts.push(`now ${describeSchedule(patch.schedule)}`);
      }
      if (patch.status && patch.status !== current.status) {
        changes.status = patch.status;
        parts.push(patch.status === "active" ? "resumed it" : patch.status === "paused" ? "paused it" : "cancelled it");
        if (patch.status === "active") changes.failures = 0;
      }
      if (Object.keys(changes).length === 0) return current;
      const status = changes.status ?? current.status;
      if (status === "active" && (changes.schedule || changes.status)) {
        changes.nextRunAt = replanned({ ...current, schedule: changes.schedule ?? current.schedule, nextRunAt: current.status === "active" ? current.nextRunAt : null }, hub.timers.now(), core.present());
        if (changes.nextRunAt === null) changes.status = "done";
      }
      const job = await core.changeJob(id, changes, { actor, runId, summary: `"${current.title}": ${parts.join(", ")}` });
      if (job.status === "cancelled" && job.kind === "intent_check" && core.onCheckJobCancelled) await core.onCheckJobCancelled(job, { actor, runId });
      return job;
    },

    async endIntentJobs(intentId, status, { actor, runId }) {
      for (const job of await store.listJobs({ intentId, status: ["active", "paused", "failed"] })) {
        await core.changeJob(job.id, { status }, { actor, runId, summary: `${status === "done" ? "Finished" : "Cancelled"} "${job.title}"` });
      }
    },

    async postToThread(threadId, text, run, itemIds = []) {
      const target = threadId ?? MAIN_THREAD_ID;
      const thread = await hub.store.getThread(target);
      // A side thread that went away (or was archived) hands its notes to the main thread.
      const id = thread && thread.status === "active" ? target : MAIN_THREAD_ID;
      await hub.store.appendMessages([{
        id: randomUUID(), role: "assistant", parts: [{ type: "text", text }],
        metadata: { at: hub.timers.now(), run: { id: run.id, kind: run.kind }, ...(itemIds.length ? { itemIds } : {}) },
      }], id);
      await base.trimThread(id);
      hub.emit({ type: "messages", threadId: id });
    },
  };

  return core;
}
