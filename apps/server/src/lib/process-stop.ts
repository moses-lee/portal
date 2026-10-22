/**
 * Stopping processes Portal started (docs/MONITORING.md, "Process cleanup"): a process, or a whole
 * process group, gets SIGTERM, and whatever is still alive after a grace period gets SIGKILL. Used
 * for adapter groups, a session's CLI tree after its agent let it go, and what a script left behind.
 */

/** How long a stopped process has to exit on SIGTERM before it gets SIGKILL. */
export const STOP_GRACE_MS = 5_000;
const POLL_MS = 100;

/** One process (`pid`) or every process in a group (`pgid`). */
export type StopTarget = { pid: number } | { pgid: number };

function target(stop: StopTarget): number {
  return "pgid" in stop ? -stop.pgid : stop.pid;
}

/** Send `signal`; false when nothing was there to receive it. */
export function signalTarget(stop: StopTarget, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target(stop), signal);
    return true;
  } catch (err) {
    // EPERM: it exists but is not ours to signal (a recycled pid); it is alive all the same.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the process, or any process of the group, is still alive. */
export function isRunning(stop: StopTarget): boolean {
  return signalTarget(stop, 0);
}

export type Termination = {
  /** Resolves once every target is gone, or has been sent SIGKILL. */
  done: Promise<void>;
  /** Send SIGKILL to what is still alive now, without waiting out the grace (shutdown). */
  hurry(): void;
};

/**
 * SIGTERM every target now, then SIGKILL whichever is still alive `graceMs` later. The timers are
 * unref'd, so a stop in progress never keeps the server running.
 */
export function terminate(
  targets: StopTarget[],
  { graceMs = STOP_GRACE_MS, signal = signalTarget }: { graceMs?: number; /** Sends the signals; tests pass a fake. */ signal?: typeof signalTarget } = {},
): Termination {
  // A target is dropped as soon as it is seen gone: its pid (or pgid) may be handed to another
  // process before the grace ends, and that one must not get the SIGKILL.
  let live = targets.filter((stop) => signal(stop, "SIGTERM"));
  const prune = () => { live = live.filter((stop) => signal(stop, 0)); };
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let timer: NodeJS.Timeout | null = null;
  const kill = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    prune();
    for (const stop of live) signal(stop, "SIGKILL");
    live = [];
    finish();
  };
  const deadline = Date.now() + graceMs;
  const poll = () => {
    prune();
    if (live.length === 0) {
      timer = null;
      finish();
    } else if (Date.now() >= deadline) {
      kill();
    } else {
      timer = setTimeout(poll, Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
      timer.unref();
    }
  };
  if (live.length === 0) finish();
  else poll();
  return { done, hurry: kill };
}
