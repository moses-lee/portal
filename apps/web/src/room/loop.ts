/**
 * The room's frame loop (docs/PALACE.md, Performance and fallbacks). The canvas runs with
 * `frameloop="never"` and this drives `advance()` from requestAnimationFrame at a capped rate:
 *
 * - 24 fps normally;
 * - 60 fps for ~300 ms after a scroll, so whatever sits over the room keeps up;
 * - 6 fps while a CSS-blurred dialog is open (`[data-room-slow]`, or an open `dialog` or
 *   `[role=dialog]` carrying `.glass`): the browser is already blurring the page behind it;
 * - 12 fps under Low Power Mode, recognised by requestAnimationFrame itself arriving at ~30 Hz;
 * - nothing while the document is hidden;
 * - under `prefers-reduced-motion` no loop at all: one still frame, refreshed once a minute and
 *   whenever the scene asks (`request()`).
 *
 * `targetFps` and `looksLowPower` are pure and unit-tested.
 */

export type LoopConditions = {
  hidden: boolean;
  /** A CSS-blurred dialog is open. */
  slow: boolean;
  /** Within ~300 ms of a scroll. */
  scrolling: boolean;
  lowPower: boolean;
};

export const DEFAULT_FPS = 24;
export const SCROLL_FPS = 60;
export const SLOW_FPS = 6;
export const LOW_POWER_FPS = 12;
export const SCROLL_BOOST_MS = 300;
/** The still frame's refresh under reduced motion: the sun moves once a minute. */
export const STILL_REFRESH_MS = 60_000;

/** The frame rate for the current conditions; 0 stops rendering. */
export function targetFps(conditions: LoopConditions): number {
  if (conditions.hidden) return 0;
  if (conditions.slow) return SLOW_FPS;
  if (conditions.lowPower) return LOW_POWER_FPS;
  if (conditions.scrolling) return SCROLL_FPS;
  return DEFAULT_FPS;
}

/** Samples of requestAnimationFrame intervals kept for the cadence check (about two seconds at 60 Hz). */
export const CADENCE_SAMPLES = 120;

/**
 * Whether requestAnimationFrame intervals (ms) look like Low Power Mode's 30 Hz cap: the median
 * sits between 28 and 40 ms. Needs a full window of samples; a few long frames (a busy main
 * thread) do not move the median.
 */
export function looksLowPower(intervals: readonly number[]): boolean {
  if (intervals.length < CADENCE_SAMPLES) return false;
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median >= 28 && median <= 40;
}

const SLOW_SELECTOR = "[data-room-slow], dialog[open].glass, [role=dialog].glass";
const SLOW_CHECK_MS = 250;

export type RoomLoop = {
  /** Render a frame soon even when the loop is still (reduced motion) or between frames. */
  request: () => void;
  stop: () => void;
};

/**
 * Starts driving `render(timestamp)` (R3F's `advance`). Browser only. `reducedMotion` picks the
 * still mode for the loop's lifetime; restart the loop when it changes.
 */
export function startRoomLoop(render: (timestamp: number) => void, options: { reducedMotion: boolean }): RoomLoop {
  let stopped = false;
  let raf = 0;
  let last = -Infinity;
  let previousTick = 0;
  let intervals: number[] = [];
  let lowPower = false;
  let scrollUntil = 0;
  let slow = false;
  let slowCheckedAt = -Infinity;
  let requested = false;

  const renderOnce = () => {
    if (stopped || raf) return;
    raf = requestAnimationFrame((time) => {
      raf = 0;
      if (!stopped && !document.hidden) render(time);
    });
  };

  if (options.reducedMotion) {
    renderOnce();
    const timer = setInterval(renderOnce, STILL_REFRESH_MS);
    const onVisibility = () => {
      if (!document.hidden) renderOnce();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return {
      request: renderOnce,
      stop: () => {
        stopped = true;
        clearInterval(timer);
        if (raf) cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVisibility);
      },
    };
  }

  const tick = (time: number) => {
    raf = 0;
    if (stopped) return;
    if (previousTick) {
      intervals.push(time - previousTick);
      if (intervals.length > CADENCE_SAMPLES) intervals = intervals.slice(-CADENCE_SAMPLES);
      lowPower = looksLowPower(intervals);
    }
    previousTick = time;
    if (time - slowCheckedAt >= SLOW_CHECK_MS) {
      slowCheckedAt = time;
      slow = document.querySelector(SLOW_SELECTOR) !== null;
    }
    const fps = targetFps({ hidden: document.hidden, slow, scrolling: time < scrollUntil, lowPower });
    // Half a millisecond of slack so a 24 fps cap on a 48 Hz cadence does not skip every other frame.
    if (fps > 0 && (requested || time - last >= 1000 / fps - 0.5)) {
      requested = false;
      last = time;
      render(time);
    }
    raf = requestAnimationFrame(tick);
  };

  const onScroll = () => {
    scrollUntil = performance.now() + SCROLL_BOOST_MS;
  };
  const onVisibility = () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    // The cadence before the tab was hidden says nothing about now.
    intervals = [];
    previousTick = 0;
    requested = true;
    if (!raf) raf = requestAnimationFrame(tick);
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) {
    requested = true;
    raf = requestAnimationFrame(tick);
  }
  return {
    request: () => {
      requested = true;
    },
    stop: () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

let current: RoomLoop | null = null;

/** The running loop, set by the canvas while it is mounted, so input outside the canvas (the Palace page) can ask for a frame. */
export function setCurrentLoop(loop: RoomLoop | null) {
  current = loop;
}

/** Render a frame soon: needed under reduced motion, where nothing draws unless asked. */
export function requestRoomFrame() {
  current?.request();
}
