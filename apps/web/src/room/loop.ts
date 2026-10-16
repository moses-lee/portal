/**
 * The room's frame loop (docs/PALACE.md, Performance and fallbacks). The canvas runs with
 * `frameloop="never"` and this drives `advance()` from requestAnimationFrame at a capped rate:
 *
 * - 24 fps normally;
 * - 60 fps for ~300 ms after a scroll, so whatever sits over the room keeps up;
 * - 60 fps while anything on the page carries `[data-room-motion]` and for 100 ms after (a panel
 *   sliding over the room: docs/GLASS.md, Liquid glass → Loop), so its glass does not step;
 * - 6 fps while a CSS-blurred dialog is open (`[data-room-slow]`, or an open `dialog` or
 *   `[role=dialog]` carrying `.glass`): the browser is already blurring the page behind it;
 * - 12 fps under Low Power Mode, recognised by requestAnimationFrame itself arriving at ~30 Hz;
 * - nothing while the document is hidden;
 * - under `prefers-reduced-motion` no loop at all: one still frame, refreshed once a minute,
 *   whenever the scene or the shell asks (`request()`, `requestRoomFrame()`), when
 *   `[data-room-motion]` comes or goes (and once more `MOTION_TAIL_MS` after it goes), and when the
 *   frosted panels moved, faded, came or went (polled every `STILL_POLL_MS`), so no stale glass is
 *   left where a panel was.
 *
 * The slow rules win over both boosts. `targetFps`, `motionUntil` and `looksLowPower` are pure and
 * unit-tested.
 */

import { frostChanged, MOTION_ATTRIBUTE } from "./frost/registry.ts";

export { MOTION_ATTRIBUTE };

export type LoopConditions = {
  hidden: boolean;
  /** A CSS-blurred dialog is open. */
  slow: boolean;
  /** Within ~300 ms of a scroll. */
  scrolling: boolean;
  /** `[data-room-motion]` is on the page, or was within the last 100 ms. */
  moving: boolean;
  lowPower: boolean;
};

export const DEFAULT_FPS = 24;
export const SCROLL_FPS = 60;
export const SLOW_FPS = 6;
export const LOW_POWER_FPS = 12;
export const SCROLL_BOOST_MS = 300;
export const MOTION_FPS = 60;
/** How long the motion boost outlasts the last `[data-room-motion]`, so the animation's last frame is drawn. */
export const MOTION_TAIL_MS = 100;
/** The still frame's refresh under reduced motion: the sun moves once a minute. */
export const STILL_REFRESH_MS = 60_000;
/** Under reduced motion, how often the still frame checks whether the frosted panels changed under it. */
export const STILL_POLL_MS = 250;

/** The frame rate for the current conditions; 0 stops rendering. */
export function targetFps(conditions: LoopConditions): number {
  if (conditions.hidden) return 0;
  if (conditions.slow) return SLOW_FPS;
  if (conditions.lowPower) return LOW_POWER_FPS;
  if (conditions.moving) return MOTION_FPS;
  if (conditions.scrolling) return SCROLL_FPS;
  return DEFAULT_FPS;
}

/**
 * Until when the motion boost holds, given whether `[data-room-motion]` is on the page at `now` and
 * the previous answer: for good while it is; from the moment it goes, `MOTION_TAIL_MS` more; after
 * that the previous end stands. The boost is on while `now < motionUntil(...)`.
 */
export function motionUntil(present: boolean, previous: number, now: number): number {
  if (present) return Infinity;
  if (previous === Infinity) return now + MOTION_TAIL_MS;
  return previous;
}

/** Samples of requestAnimationFrame intervals kept for the cadence check (about two seconds at 60 Hz). */
export const CADENCE_SAMPLES = 120;
/** The cadence check runs every this many ticks (half a second at 60 Hz), not on every one. */
export const CADENCE_CHECK_TICKS = 30;

/**
 * Whether requestAnimationFrame intervals (ms) look like Low Power Mode's 30 Hz cap: the median
 * sits between 28 and 40 ms. Needs a full window of samples; a few long frames (a busy main
 * thread) do not move the median.
 */
export function looksLowPower(intervals: ArrayLike<number>): boolean {
  if (intervals.length < CADENCE_SAMPLES) return false;
  // A typed array sorts numerically.
  const sorted = Float64Array.from(intervals).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  return median >= 28 && median <= 40;
}

const SLOW_SELECTOR = "[data-room-slow], dialog[open].glass, [role=dialog].glass";
const SLOW_CHECK_MS = 250;
const MOTION_SELECTOR = `[${MOTION_ATTRIBUTE}]`;

export type RoomLoop = {
  /** Render a frame soon even when the loop is still (reduced motion) or between frames. */
  request: () => void;
  stop: () => void;
};

/**
 * Starts driving `render(timestamp)` (R3F's `advance`). Browser only. `reducedMotion` picks the
 * still mode for the loop's lifetime; restart the loop when it changes. `panelsChanged` is the
 * still mode's poll (the frost registry's `frostChanged` unless given).
 */
export function startRoomLoop(
  render: (timestamp: number) => void,
  options: { reducedMotion: boolean; panelsChanged?: () => boolean },
): RoomLoop {
  let stopped = false;
  let raf = 0;
  let last = -Infinity;
  let previousTick = 0;
  /** The last `CADENCE_SAMPLES` intervals, a ring written at `ticks % CADENCE_SAMPLES`. */
  const intervals = new Float64Array(CADENCE_SAMPLES);
  let ticks = 0;
  let lowPower = false;
  let scrollUntil = 0;
  let moveUntil = 0;
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
    const panelsChanged = options.panelsChanged ?? frostChanged;
    renderOnce();
    const timer = setInterval(renderOnce, STILL_REFRESH_MS);
    const poll = setInterval(() => {
      if (!document.hidden && panelsChanged()) renderOnce();
    }, STILL_POLL_MS);
    let tail: ReturnType<typeof setTimeout> | undefined;
    // A panel collapsing or a sheet closing at once still holds the attribute: draw as it starts and as it ends.
    const motionObserver = new MutationObserver(() => {
      renderOnce();
      clearTimeout(tail);
      if (document.querySelector(MOTION_SELECTOR) === null) tail = setTimeout(renderOnce, MOTION_TAIL_MS);
    });
    motionObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: [MOTION_ATTRIBUTE] });
    const onVisibility = () => {
      if (!document.hidden) renderOnce();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return {
      request: renderOnce,
      stop: () => {
        stopped = true;
        clearInterval(timer);
        clearInterval(poll);
        clearTimeout(tail);
        if (raf) cancelAnimationFrame(raf);
        motionObserver.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
      },
    };
  }

  const tick = (time: number) => {
    raf = 0;
    if (stopped) return;
    // The next frame first: a render that throws must not stop the room for good.
    raf = requestAnimationFrame(tick);
    if (previousTick) {
      intervals[ticks % CADENCE_SAMPLES] = time - previousTick;
      ticks += 1;
      if (ticks >= CADENCE_SAMPLES && ticks % CADENCE_CHECK_TICKS === 0) lowPower = looksLowPower(intervals);
    }
    previousTick = time;
    if (time - slowCheckedAt >= SLOW_CHECK_MS) {
      slowCheckedAt = time;
      slow = document.querySelector(SLOW_SELECTOR) !== null;
      // The observer below sees the attribute set or removed at once; an element mounted already carrying it is seen here.
      checkMotion();
    }
    const fps = targetFps({ hidden: document.hidden, slow, scrolling: time < scrollUntil, moving: time < moveUntil, lowPower });
    // Half a millisecond of slack so a 24 fps cap on a 48 Hz cadence does not skip every other frame.
    if (fps > 0 && (requested || time - last >= 1000 / fps - 0.5)) {
      requested = false;
      last = time;
      render(time);
    }
  };

  const onScroll = () => {
    scrollUntil = performance.now() + SCROLL_BOOST_MS;
  };
  const checkMotion = () => {
    moveUntil = motionUntil(document.querySelector(MOTION_SELECTOR) !== null, moveUntil, performance.now());
  };
  // Only the one attribute, so a streaming reply's mutations never wake it.
  const motionObserver = new MutationObserver(checkMotion);
  motionObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: [MOTION_ATTRIBUTE] });
  const onVisibility = () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    // The cadence before the tab was hidden says nothing about now.
    ticks = 0;
    lowPower = false;
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
      motionObserver.disconnect();
    },
  };
}

let current: RoomLoop | null = null;

/** The running loop, set by the canvas while it is mounted, so input outside the canvas (the Palace page) can ask for a frame. */
export function setCurrentLoop(loop: RoomLoop | null) {
  current = loop;
}

/**
 * Render a frame soon: needed under reduced motion, where nothing draws unless asked (the shell
 * calls it after an instant collapse; holding `data-room-motion` around the change does the same).
 * A no-op while no room canvas is mounted. Browser only.
 */
export function requestRoomFrame() {
  current?.request();
}
