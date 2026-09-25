/**
 * The world refresh as a job: seeded once (id "tick", created by the system) and run every hour,
 * whether or not anyone has Portal open. It is Portal's own plumbing, not the agent's or the
 * user's: the jobs service hides it and its runs from every listing, route, tool, and status line,
 * and nobody reschedules, pauses, runs, or cancels it. On start the stored job is put back into
 * that shape whatever an older Portal left in it. Each firing is a run whose result is the
 * `RefreshReport` (see `tick.ts`).
 */
import type { JobSchedule } from "@portal/contracts/jobs";
import { emptyRefreshReport } from "../tick.ts";
import { TICK_JOB_ID, type JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";

/** The first refresh after the process starts: the rest of the server gets a minute to settle. */
export const FIRST_TICK_DELAY_MS = 60_000;
/** How often the world is refreshed, open or idle. */
export const TICK_EVERY_MS = 60 * 60_000;
export const TICK_TITLE = "Refresh the world";
export const TICK_SCHEDULE: JobSchedule = { type: "every", everyMs: TICK_EVERY_MS };

/**
 * Seed the refresh job, or force the stored one into shape: active, hourly, its title, no payload,
 * and its next run between a minute and an hour from now (a lease the previous process held on it
 * is dropped, since that process is gone).
 */
export async function ensureTickJob(core: JobsCore): Promise<void> {
  const { hub, store } = core;
  const now = hub.timers.now();
  const first = now + FIRST_TICK_DELAY_MS;
  const { job, created } = await store.ensureJob({
    id: TICK_JOB_ID, kind: "tick", title: TICK_TITLE, schedule: TICK_SCHEDULE, payload: {}, nextRunAt: first, createdBy: "system",
  });
  if (created) return;
  const planned = job.status === "active" && job.nextRunAt !== null ? job.nextRunAt : first;
  await store.release(job.id, {
    status: "active", title: TICK_TITLE, schedule: TICK_SCHEDULE, payload: {}, failures: 0,
    nextRunAt: Math.min(Math.max(planned, first), now + TICK_EVERY_MS),
  });
}

export async function runTickJob(core: JobsCore, { signal }: KindContext): Promise<KindResult> {
  const report = emptyRefreshReport();
  try {
    await core.tick(report, { signal });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    report.log.push(`Failed: ${report.error}`);
  }
  const failed = !!report.error;
  const summary = failed ? `Failed: ${report.error}` : report.changes === 0 ? "Nothing changed." : `${report.changes} change(s) recorded.`;
  return { status: failed ? (signal.aborted ? "cancelled" : "failed") : "succeeded", result: report, log: report.log, summary, error: failed ? report.error : null };
}
