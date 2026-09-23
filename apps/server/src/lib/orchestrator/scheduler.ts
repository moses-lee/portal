/**
 * One timer that runs ticks. It never decides *when* itself: `nextTickAt` (owned by the runtime,
 * which knows presence, settings, and the last tick) is asked after every tick and whenever the
 * runtime calls `reschedule()`. Timers are injectable so tests can drive the clock.
 */
export type SchedulerTimers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** A change that moves the tick earlier still goes through the timer; never in the caller's stack. */
export const MIN_DELAY_MS = 1000;
/** How soon to ask `nextTickAt` again after it failed (it reads settings from Postgres, which may be restarting). */
export const RESCHEDULE_RETRY_MS = 30_000;

export const realTimers: SchedulerTimers = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    // A pending tick must not keep the process alive on shutdown.
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type Scheduler = {
  /** Recompute the next tick from `nextTickAt()`; supersedes any earlier plan. */
  reschedule(): Promise<void>;
  /** Epoch ms of the planned tick, or null when none is planned. */
  plannedAt(): number | null;
  stop(): void;
};

export function createScheduler({ tick, nextTickAt, timers = realTimers, log = console.error }: {
  tick: () => Promise<unknown>;
  nextTickAt: () => Promise<number | null>;
  timers?: SchedulerTimers;
  /** Where a failed `nextTickAt` is reported. */
  log?: (message: string, err: unknown) => void;
}): Scheduler {
  let handle: unknown = null;
  let planned: number | null = null;
  let stopped = false;
  let generation = 0;

  function clear() {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
    planned = null;
  }

  async function fire() {
    handle = null;
    planned = null;
    if (stopped) return;
    try {
      await tick();
    } catch {
      // runTick reports its own failures; the scheduler only has to keep going.
    }
    await reschedule();
  }

  /**
   * Never rejects: callers fire it and forget (presence and settings changes, the timer), so a
   * rejection would be unhandled and take the process down. A failed read retries on a timer
   * instead, or the scheduler would sit with no plan until something else happened to reschedule.
   */
  async function reschedule() {
    const mine = ++generation;
    let at: number | null;
    try {
      at = await nextTickAt();
    } catch (err) {
      if (stopped || mine !== generation) return;
      log(`Could not plan the next Portal tick; retrying in ${RESCHEDULE_RETRY_MS / 1000} s:`, err);
      clear();
      handle = timers.setTimeout(() => { void reschedule(); }, RESCHEDULE_RETRY_MS);
      return;
    }
    // A later reschedule() (or stop()) won while we were reading settings; its plan stands.
    if (stopped || mine !== generation) return;
    clear();
    if (at === null) return;
    planned = at;
    handle = timers.setTimeout(() => { void fire(); }, Math.max(MIN_DELAY_MS, at - timers.now()));
  }

  return {
    reschedule,
    plannedAt: () => planned,
    stop() {
      stopped = true;
      generation++;
      clear();
    },
  };
}
