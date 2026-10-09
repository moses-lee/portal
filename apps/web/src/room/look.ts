/**
 * The Palace page's look-around camera (docs/PALACE.md, Palace page): drag yaws within ±20° and
 * pitches within 10° to 40°, with inertia; wheel or pinch zooms between 0.85× and 1.3×; a double
 * click flies to frame an object over 600 ms and Escape (or a click on empty floor) flies back.
 *
 * The maths (`clampLook`, `dragLook`, `zoomLook`, `coast`, `easeInOut`, `blendLook`,
 * `framingDistance`) is pure and unit-tested. Below it, `look` is the one mutable state the page's
 * input (`PalaceView`) writes and the camera rig reads every frame; nothing else touches it, and
 * leaving the page resets it. No React, no DOM, no three.js.
 */

const DEGREE = Math.PI / 180;

export const LIMITS = {
  /** Either way from the default yaw. */
  yaw: 20 * DEGREE,
  /** The camera's pitch (looking down), absolute. */
  pitchMin: 10 * DEGREE,
  pitchMax: 40 * DEGREE,
  zoomMin: 0.85,
  zoomMax: 1.3,
} as const;

/** Radians of turn per CSS pixel dragged. */
export const DRAG_RATE = 0.16 * DEGREE;
/** How fast a released drag's spin dies away (per second, exponential). */
export const FRICTION = 4.5;
/** Below this speed (radians per second) a coasting camera stops. */
export const REST_SPEED = 0.2 * DEGREE;
export const FLIGHT_MS = 600;

/** The user's offsets from the default pose: yaw and pitch in radians, zoom as a factor (1.3 is closer). */
export type Look = { yaw: number; pitch: number; zoom: number };

export const DEFAULT_LOOK: Look = { yaw: 0, pitch: 0, zoom: 1 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** `look` within the limits, for a default pose pitched at `basePitch` (radians). */
export function clampLook(look: Look, basePitch: number): Look {
  return {
    yaw: clamp(look.yaw, -LIMITS.yaw, LIMITS.yaw),
    pitch: clamp(look.pitch, LIMITS.pitchMin - basePitch, LIMITS.pitchMax - basePitch),
    zoom: clamp(look.zoom, LIMITS.zoomMin, LIMITS.zoomMax),
  };
}

/** A drag of (`dx`, `dy`) CSS pixels: right turns the room to the left (the camera swings right), down looks from higher up. */
export function dragLook(look: Look, dx: number, dy: number, basePitch: number): Look {
  return clampLook({ yaw: look.yaw - dx * DRAG_RATE, pitch: look.pitch + dy * DRAG_RATE, zoom: look.zoom }, basePitch);
}

/** Zoom by `factor` (a wheel step, a pinch's ratio), within the limits. */
export function zoomLook(look: Look, factor: number, basePitch: number): Look {
  return clampLook({ ...look, zoom: look.zoom * factor }, basePitch);
}

/**
 * One step of inertia after a drag: the look moves on at `velocity` (radians per second) for
 * `seconds`, the velocity decays, and an axis that meets a limit stops. Returns the new look and velocity.
 */
export function coast(
  look: Look,
  velocity: { yaw: number; pitch: number },
  seconds: number,
  basePitch: number,
): { look: Look; velocity: { yaw: number; pitch: number } } {
  const moved = clampLook({ yaw: look.yaw + velocity.yaw * seconds, pitch: look.pitch + velocity.pitch * seconds, zoom: look.zoom }, basePitch);
  const decay = Math.exp(-FRICTION * seconds);
  let yaw = moved.yaw === look.yaw + velocity.yaw * seconds ? velocity.yaw * decay : 0;
  let pitch = moved.pitch === look.pitch + velocity.pitch * seconds ? velocity.pitch * decay : 0;
  if (Math.hypot(yaw, pitch) < REST_SPEED) {
    yaw = 0;
    pitch = 0;
  }
  return { look: moved, velocity: { yaw, pitch } };
}

/** Cubic ease in and out over 0..1. */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function blendLook(from: Look, to: Look, t: number): Look {
  return { yaw: from.yaw + (to.yaw - from.yaw) * t, pitch: from.pitch + (to.pitch - from.pitch) * t, zoom: from.zoom + (to.zoom - from.zoom) * t };
}

/** How far a camera with a vertical field of view of `fovDegrees` stands to frame a sphere of `radius`, with some room around it. */
export function framingDistance(radius: number, fovDegrees: number): number {
  const half = (fovDegrees / 2) * DEGREE;
  return Math.max(2.4, (radius / Math.sin(half)) * 1.8);
}

// ---------------------------------------------------------------------------------------------
// The state (browser only)
// ---------------------------------------------------------------------------------------------

/** A flight between two looks and two focus amounts (0 the default target, 1 the framed object), over `duration` ms. */
export type Flight = { from: Look; to: Look; fromFocus: number; toFocus: number; start: number; duration: number };

export type LookState = Look & {
  /** True on the Palace page: the camera rig applies the look. */
  active: boolean;
  /** The spin a released drag left, radians per second. */
  velocity: { yaw: number; pitch: number };
  dragging: boolean;
  /** 0..1: how far the camera has moved from the default target to `focusPoint`. */
  focus: number;
  focusPoint: [number, number, number];
  focusDistance: number;
  flight: Flight | null;
  /** The default pose's pitch, set by the camera rig, for the limits. */
  basePitch: number;
};

export const look: LookState = {
  ...DEFAULT_LOOK,
  active: false,
  velocity: { yaw: 0, pitch: 0 },
  dragging: false,
  focus: 0,
  focusPoint: [0, 0, 0],
  focusDistance: 0,
  flight: null,
  basePitch: 25 * DEGREE,
};

/** Back to the default pose at once: on leaving the Palace page. */
export function resetLook() {
  Object.assign(look, DEFAULT_LOOK, { velocity: { yaw: 0, pitch: 0 }, dragging: false, focus: 0, flight: null });
}

/** Start a flight from where the camera is now; `reducedMotion` makes it a cut. */
export function flyTo(to: Look, toFocus: number, now: number, reducedMotion: boolean) {
  look.velocity = { yaw: 0, pitch: 0 };
  if (reducedMotion) {
    Object.assign(look, to, { focus: toFocus, flight: null });
    return;
  }
  look.flight = { from: { yaw: look.yaw, pitch: look.pitch, zoom: look.zoom }, to, fromFocus: look.focus, toFocus, start: now, duration: FLIGHT_MS };
}

/**
 * Advance the look to `now` (ms): a flight eases along, else a released drag coasts. Called by the
 * camera rig once per frame on the Palace page. True while something is still moving.
 */
export function stepLook(now: number, seconds: number): boolean {
  // In place, without the pure helpers' fresh objects: this runs every frame while the camera moves.
  const flight = look.flight;
  if (flight) {
    const t = Math.min(1, (now - flight.start) / flight.duration);
    const eased = easeInOut(t);
    look.yaw = flight.from.yaw + (flight.to.yaw - flight.from.yaw) * eased;
    look.pitch = flight.from.pitch + (flight.to.pitch - flight.from.pitch) * eased;
    look.zoom = flight.from.zoom + (flight.to.zoom - flight.from.zoom) * eased;
    look.focus = flight.fromFocus + (flight.toFocus - flight.fromFocus) * eased;
    if (t >= 1) look.flight = null;
    return true;
  }
  const velocity = look.velocity;
  if (look.dragging || (velocity.yaw === 0 && velocity.pitch === 0)) return false;
  const yaw = look.yaw + velocity.yaw * seconds;
  const pitch = look.pitch + velocity.pitch * seconds;
  look.yaw = clamp(yaw, -LIMITS.yaw, LIMITS.yaw);
  look.pitch = clamp(pitch, LIMITS.pitchMin - look.basePitch, LIMITS.pitchMax - look.basePitch);
  const decay = Math.exp(-FRICTION * seconds);
  velocity.yaw = look.yaw === yaw ? velocity.yaw * decay : 0;
  velocity.pitch = look.pitch === pitch ? velocity.pitch * decay : 0;
  if (Math.hypot(velocity.yaw, velocity.pitch) < REST_SPEED) {
    velocity.yaw = 0;
    velocity.pitch = 0;
  }
  return true;
}
