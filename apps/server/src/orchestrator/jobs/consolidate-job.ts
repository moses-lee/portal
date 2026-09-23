/**
 * Memory curation as a job: seeded once (id "consolidate", created by the system) on a nightly cron
 * in the server's time zone from the settings, kept in step with them, and moved up when the inbox
 * passes its threshold (no sooner than the settings' interval after the last run started). With the
 * nightly run off the job stays active but unscheduled, so the inbox trigger and "Run now" still
 * work. A run is one curation pass (`memory/consolidate.ts`); its digest line goes to the main thread.
 */
import type { JobSchedule } from "@portal/contracts/jobs";
import type { ConsolidationSettings } from "@portal/contracts/orchestrator";
import { runCuration } from "../memory/consolidate.ts";
import { worthPosting } from "../memory/curation.ts";
import type { JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";
import { describeSchedule, nextRunAt, sameSchedule } from "./schedule.ts";

export const CONSOLIDATE_JOB_ID = "consolidate";
export const CONSOLIDATE_TITLE = "Curate memory";
/** A nightly run missed while Portal was off catches up this long after the server starts. */
export const CATCH_UP_DELAY_MS = 5 * 60_000;
/** The nightly time when the settings turn the nightly run off (the job keeps a schedule to show). */
const FALLBACK_NIGHTLY_AT = "03:00";

/** The server's IANA time zone, which the nightly time is read in. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `M H * * *` in the server's zone for "HH:MM". */
export function nightlySchedule(nightlyAt: string, tz = localTimeZone()): JobSchedule {
  const [hours, minutes] = nightlyAt.split(":").map(Number);
  return { type: "cron", expr: `${minutes} ${hours} * * *`, tz };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createConsolidation(core: JobsCore) {
  const { hub, store } = core;
  /** The inbox size when the inbox trigger moved the next run up; cleared when that run starts. */
  let queuedFor: number | null = null;

  const settings = async (): Promise<ConsolidationSettings> => (await hub.settings.orchestrator()).consolidation;
  const now = () => hub.timers.now();
  const nextNightly = (schedule: JobSchedule) => nextRunAt(schedule, { now: now(), lastRunAt: null, present: core.present() });

  /**
   * Seed the job, or bring the stored one up to date at start: active again unless the user paused
   * it, on the settings' schedule, and an overdue run no sooner than a few minutes from now.
   */
  async function ensure(): Promise<void> {
    const { nightlyAt } = await settings();
    const schedule = nightlySchedule(nightlyAt ?? FALLBACK_NIGHTLY_AT);
    const planned = nightlyAt ? nextNightly(schedule) : null;
    const { job, created } = await store.ensureJob({
      id: CONSOLIDATE_JOB_ID, kind: "consolidate", title: CONSOLIDATE_TITLE, schedule, payload: {}, nextRunAt: planned, createdBy: "system",
    });
    if (created) {
      void hub.activity.log({
        actor: "system", kind: "job.scheduled", summary: `Scheduled "${CONSOLIDATE_TITLE}" (${nightlyAt ? describeSchedule(schedule) : "nightly run off"})`,
        refs: { jobId: job.id }, detail: { schedule },
      });
    } else {
      const status = job.status === "paused" ? "paused" : "active";
      const kept = nightlyAt ? schedule : job.schedule;
      let next: number | null = null;
      if (status === "active") {
        // A run planned sooner than the nightly one (the inbox trigger, a missed night) stays; a new nightly time replaces the old one.
        if (!nightlyAt) next = job.nextRunAt;
        else if (job.nextRunAt !== null && (sameSchedule(job.schedule, schedule) || job.nextRunAt < (planned ?? Infinity))) next = job.nextRunAt;
        else next = planned;
      }
      if (next !== null) next = Math.max(next, now() + CATCH_UP_DELAY_MS);
      // Released, not updated: a lease the previous process held on it is dropped, since that process is gone.
      await store.release(job.id, { status, schedule: kept, nextRunAt: next, failures: 0 });
    }
    core.emitJobs();
  }

  /** The settings changed: the nightly time moves (or turns off), and a lower threshold may start a run. */
  async function sync(): Promise<void> {
    const job = await store.getJob(CONSOLIDATE_JOB_ID);
    if (!job) return;
    const { nightlyAt } = await settings();
    const schedule = nightlyAt ? nightlySchedule(nightlyAt) : job.schedule;
    // A run the inbox trigger moved up stays; otherwise the next run follows the nightly time.
    const queued = queuedFor !== null ? job.nextRunAt : null;
    let next = job.nextRunAt;
    if (job.status === "active") {
      const nightly = nightlyAt ? nextNightly(schedule) : null;
      next = nightly === null ? queued : queued === null ? nightly : Math.min(queued, nightly);
    }
    if (!sameSchedule(schedule, job.schedule) || next !== job.nextRunAt) {
      await core.changeJob(job.id, { schedule, nextRunAt: next }, {
        actor: "system", summary: nightlyAt ? `Memory curation follows the new settings (${describeSchedule(schedule)})` : "Nightly memory curation is off",
      });
    }
    await inboxChanged();
  }

  /**
   * Memory changed: when the inbox holds at least the threshold, the next run moves up to now, or to
   * the settings' interval after the last run started, whichever is later. Never while a run is going.
   */
  async function inboxChanged(): Promise<void> {
    const { inboxThreshold, minIntervalMinutes } = await settings();
    if (inboxThreshold === null) return;
    if (core.runs.running().some((run) => run.jobId === CONSOLIDATE_JOB_ID)) return;
    const count = await hub.memory.inboxCount();
    if (count < inboxThreshold) return;
    const job = await store.getJob(CONSOLIDATE_JOB_ID);
    if (!job || job.status !== "active") return;
    const [last] = await store.listRuns({ jobId: CONSOLIDATE_JOB_ID, limit: 1 });
    const at = Math.max(now(), last ? last.startedAt + minIntervalMinutes * 60_000 : 0);
    if (job.nextRunAt !== null && job.nextRunAt <= at) return;
    queuedFor = count;
    await core.changeJob(job.id, { nextRunAt: at }, {
      actor: "system",
      summary: `The memory inbox holds ${count} proposals: curation runs ${at <= now() ? "now" : `at ${new Date(at).toISOString()}`}`,
    });
  }

  /** One firing: the pass, the digest line in the main thread, and no next run while the nightly run is off. */
  async function run({ job, run: jobRun, trigger, signal }: KindContext): Promise<KindResult> {
    const queued = queuedFor;
    queuedFor = null;
    const why = trigger === "manual" || trigger === "user" ? "Started by Run now." : queued !== null ? `Started because the inbox held ${queued} proposals.` : "Nightly run.";
    const { nightlyAt } = await settings().catch(() => ({ nightlyAt: FALLBACK_NIGHTLY_AT }));
    const unscheduled: Pick<KindResult, "nextRunAt"> = nightlyAt ? {} : { nextRunAt: null };
    try {
      const outcome = await runCuration(hub, { run: jobRun, jobId: job.id, trigger, signal, self: core.self() });
      if (!outcome.skipped && worthPosting(outcome.result)) {
        await core.postToThread(null, outcome.result.line, jobRun).catch((err: unknown) => console.error("Could not post the curation digest:", err));
      }
      return {
        status: outcome.status, result: outcome.result as unknown as Record<string, unknown>, log: [why, ...outcome.log], summary: outcome.result.line,
        error: outcome.error, skipped: outcome.skipped, ...unscheduled,
      };
    } catch (err) {
      if (signal.aborted) throw err;
      return { status: "failed", log: [why, `Failed: ${errorMessage(err)}`], summary: `Memory curation failed: ${errorMessage(err)}`, error: errorMessage(err), ...unscheduled };
    }
  }

  return { ensure, sync, inboxChanged, run };
}
