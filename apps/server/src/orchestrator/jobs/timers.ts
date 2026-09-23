/**
 * The clock every orchestrator part reads (`hub.timers`): the time and one-shot timers. Injectable
 * so tests drive the job worker, leases, and schedules without real time passing.
 */
export type SchedulerTimers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realTimers: SchedulerTimers = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    // A pending poll or lease renewal must not keep the process alive on shutdown.
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
