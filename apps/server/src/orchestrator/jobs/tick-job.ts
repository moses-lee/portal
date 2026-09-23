/**
 * The tick as a job: seeded once (id "tick", created by the system) with the settings' intervals,
 * kept in step with them until the agent or the user reschedules it, and run like any other job.
 * Every firing is a run whose result is the `TickReport`, whether or not the model was called.
 */
import type { JobSchedule, RunTrigger } from "@portal/contracts/jobs";
import type { TickReport } from "@portal/contracts/orchestrator";
import type { OrchestratorSettings } from "../types.ts";
import { TICK_JOB_ID, type JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";
import { currentInterval, describeSchedule, replanned, sameSchedule } from "./schedule.ts";

/** The first tick after the process starts: the rest of the server gets a minute to settle. */
export const FIRST_TICK_DELAY_MS = 60_000;
export const TICK_TITLE = "Check for changes";

export function tickSchedule(settings: Pick<OrchestratorSettings, "intervalMinutes" | "idleIntervalMinutes">): JobSchedule {
  return { type: "every", everyMs: settings.intervalMinutes * 60_000, idleEveryMs: settings.idleIntervalMinutes * 60_000 };
}

const followsSettings = (payload: Record<string, unknown>) => payload.followsSettings !== false;

/**
 * Seed the tick job, or bring the stored one up to date: back to active when something ended it,
 * the settings' intervals unless it was rescheduled by hand, and its first run no sooner than a
 * minute from now.
 */
export async function ensureTickJob(core: JobsCore): Promise<void> {
  const { hub, store } = core;
  const settings = await hub.settings.orchestrator();
  const now = hub.timers.now();
  const schedule = tickSchedule(settings);
  const { job, created } = await store.ensureJob({
    id: TICK_JOB_ID, kind: "tick", title: TICK_TITLE, schedule, payload: { followsSettings: true }, nextRunAt: now + FIRST_TICK_DELAY_MS, createdBy: "system",
  });
  if (created) {
    void hub.activity.log({ actor: "system", kind: "job.scheduled", summary: `Scheduled "${TICK_TITLE}" (the tick)`, refs: { jobId: job.id }, detail: { schedule } });
  } else {
    const status = job.status === "paused" ? "paused" : "active";
    const nextSchedule = followsSettings(job.payload) && !sameSchedule(job.schedule, schedule) ? schedule : job.schedule;
    const nextRunAt = status === "active" ? Math.max(job.nextRunAt ?? 0, now + FIRST_TICK_DELAY_MS) : null;
    // Released, not updated: a lease the previous process held on it is dropped, since that process is gone.
    await store.release(job.id, { status, schedule: nextSchedule, nextRunAt, failures: 0 });
  }
  core.emitJobs();
}

/** The settings changed: a tick that follows them takes their intervals. */
export async function syncTickSchedule(core: JobsCore): Promise<void> {
  const { hub, store } = core;
  const job = await store.getJob(TICK_JOB_ID);
  if (!job || !followsSettings(job.payload)) return;
  const schedule = tickSchedule(await hub.settings.orchestrator());
  if (sameSchedule(schedule, job.schedule)) return;
  const nextRunAt = job.status === "active" ? replanned({ ...job, schedule }, hub.timers.now(), core.present()) : null;
  await core.changeJob(job.id, { schedule, nextRunAt }, { actor: "system", summary: `The tick follows the new settings (${describeSchedule(schedule)})` });
}

export function emptyReport(id: string, trigger: RunTrigger, at: number): TickReport {
  return {
    id, reason: trigger === "schedule" ? "schedule" : "manual", startedAt: at, finishedAt: at, modelInvoked: false, changes: 0,
    itemsCreated: [], itemsUpdated: [], itemsResolved: [], log: [], error: null, usage: null,
  };
}

/** A tick that could not run (another is running, the job is paused): answered, never stored. */
export function skippedReport(trigger: RunTrigger, at: number, reason: string): TickReport {
  const report = emptyReport(`skip-${at}`, trigger, at);
  report.error = "busy";
  report.log.push(reason);
  return report;
}

export async function runTickJob(core: JobsCore, { job, run, trigger, signal }: KindContext): Promise<KindResult> {
  const { hub } = core;
  const report = emptyReport(run.id, trigger, run.startedAt);
  const intervalMs = job.schedule.type === "every" ? currentInterval(job.schedule, core.present()) : 10 * 60_000;
  try {
    await core.tick(report, { intervalMs, signal });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    report.log.push(`Failed: ${report.error}`);
  }
  report.finishedAt = hub.timers.now();
  core.lastTick = report;
  hub.emit({ type: "tick", report });
  const notReady = report.error === "not ready";
  const failed = !!report.error && !notReady;
  const summary = notReady ? "No API key is stored; nothing was checked."
    : failed ? `Failed: ${report.error}`
    : report.modelInvoked ? null
    : report.changes === 0 ? "Nothing changed." : `${report.changes} change(s) already known.`;
  return { status: failed ? (signal.aborted ? "cancelled" : "failed") : "succeeded", result: report, log: report.log, summary, error: failed ? report.error : null };
}
