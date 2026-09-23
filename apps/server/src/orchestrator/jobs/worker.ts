/**
 * The job worker: claims due jobs from the store and hands each to `execute`, at most
 * `concurrency` at a time and never two runs of one job. It wakes on `wake()` (a job created or
 * rescheduled in this process), on NOTIFY from other processes, at the next job's due time, and
 * every `pollMs` regardless. Claims are leased: while a job runs its lease is renewed, and a lease a
 * dead process left behind simply runs out. Timers come from `hub.timers`, so tests drive it.
 */
import type { Job, JobRun, RunTrigger } from "@portal/contracts/jobs";
import { JOBS_CHANNEL, type JobsCore } from "./core.ts";

export type WorkerOptions = {
  /** Jobs running at once in this process. */
  concurrency?: number;
  /** Longest sleep between two looks at the table. */
  pollMs?: number;
  /** How long a claim holds without renewal. */
  leaseMs?: number;
  /** How often running jobs' leases are renewed. */
  renewMs?: number;
};

export const DEFAULT_CONCURRENCY = 3;
export const POLL_MS = 30_000;
export const LEASE_MS = 10 * 60_000;
export const RENEW_MS = 3 * 60_000;
/** Shortest sleep before the next look, so a job due now never spins the loop. */
export const MIN_DELAY_MS = 50;

export type Execution = { started: Promise<JobRun>; done: Promise<JobRun> };

export type Worker = ReturnType<typeof createWorker>;

export function createWorker(core: JobsCore, { execute, beforePump }: {
  /** Run one claimed job to the end (including its release). */
  execute(job: Job, trigger: RunTrigger): Execution;
  /** Housekeeping before each look (expiring intents). */
  beforePump?(): Promise<void>;
}, options: WorkerOptions = {}) {
  const { hub, store } = core;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const pollMs = options.pollMs ?? POLL_MS;
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const renewMs = options.renewMs ?? RENEW_MS;
  const inFlight = new Map<string, Promise<JobRun>>();
  let started = false;
  let disposed = false;
  let pumping = false;
  let again = false;
  let timer: unknown = null;
  let renewTimer: unknown = null;
  let unlisten: (() => Promise<void>) | null = null;

  function arm(delay: number) {
    if (timer !== null) hub.timers.clearTimeout(timer);
    timer = hub.timers.setTimeout(() => {
      timer = null;
      void pump();
    }, delay);
  }

  function armRenewal() {
    if (renewTimer !== null || disposed || inFlight.size === 0) return;
    renewTimer = hub.timers.setTimeout(() => {
      renewTimer = null;
      if (disposed || inFlight.size === 0) return;
      void store.renewLeases([...inFlight.keys()], leaseMs)
        .catch((err: unknown) => console.error("Could not renew job leases:", err))
        .finally(armRenewal);
    }, renewMs);
  }

  /** Run a job this process has claimed; the job is tracked until its execution settles. */
  function launch(job: Job, trigger: RunTrigger): Execution {
    const execution = execute(job, trigger);
    const done = execution.done.catch((err: unknown) => {
      console.error(`Job "${job.title}" failed outside its run:`, err);
      throw err;
    });
    inFlight.set(job.id, done);
    armRenewal();
    void done.catch(() => {}).finally(() => {
      inFlight.delete(job.id);
      void pump();
    });
    return execution;
  }

  /** Never rejects: it is fired and forgotten from timers, notifications, and finished runs. */
  async function pump(): Promise<void> {
    if (disposed || !started) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        await beforePump?.();
        const free = concurrency - inFlight.size;
        if (free > 0 && !disposed) {
          for (const job of await store.claimDue({ limit: free, leaseMs, exclude: [...inFlight.keys()] })) {
            if (disposed) {
              // Claimed on the way out: hand it back untouched.
              await store.release(job.id, {}).catch(() => {});
              continue;
            }
            launch(job, "schedule");
          }
        }
      } while (again && !disposed);
      if (disposed) return;
      let delay = pollMs;
      if (inFlight.size < concurrency) {
        const next = await store.nextDue();
        if (next?.nextRunAt != null) delay = Math.min(pollMs, Math.max(MIN_DELAY_MS, next.nextRunAt - hub.timers.now()));
      }
      if (!disposed) arm(delay);
    } catch (err) {
      console.error("The job worker could not look for due jobs; retrying:", err);
      if (!disposed) arm(pollMs);
    } finally {
      pumping = false;
    }
  }

  // LISTEN from the moment the worker exists, while the pool is certainly open: postgres.js makes a
  // dedicated client for it, which ending the pool ends too only if it already exists by then.
  // Notifications before start() are ignored by pump().
  if (hub.sql) {
    void hub.sql.listen(JOBS_CHANNEL, () => { void pump(); }).then((meta) => {
      if (disposed) return meta.unlisten();
      unlisten = meta.unlisten;
    }, (err: unknown) => console.error("Could not LISTEN for job changes; polling only:", err));
  }

  return {
    leaseMs,
    start() {
      if (started || disposed) return;
      started = true;
      void pump();
    },
    wake() {
      void pump();
    },
    launch,
    /** Whether this process is running the job now. */
    isRunning: (jobId: string) => inFlight.has(jobId),
    async dispose() {
      disposed = true;
      if (timer !== null) hub.timers.clearTimeout(timer);
      if (renewTimer !== null) hub.timers.clearTimeout(renewTimer);
      timer = renewTimer = null;
      await unlisten?.().catch(() => {});
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
