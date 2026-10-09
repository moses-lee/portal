/**
 * Where the room shows (docs/PALACE.md, Camera): UI parts report the rectangle they cover, and the
 * camera's `setViewOffset` moves the room's centre of interest into the region they leave open.
 *
 * The maths (`interestPoint`, `viewOffset`, `cameraPose`) is pure and unit-tested; the registry
 * below it measures the reported elements only when one of them resizes or the window does, never
 * per frame. Parts report through `roomCover(kind)` as a callback ref on their own element, or
 * `useRoomCover(kind)` (`useRoomCover.ts`) where the ref passes through another component's ref
 * merger, which may drop a callback ref's cleanup:
 *
 * - `left`: covers the viewport from its left edge (the sidebar).
 * - `right`: covers it from the right (the GitHub inspector, the tracked-sessions panel).
 * - `column`: a reading column in the open region (a conversation); the room aims for the wider
 *   margin beside it when that margin is wide enough to show something.
 * - `focus`: a see-through window onto the room (the phone strip); the room centres on it.
 */

export type Rect = { left: number; top: number; width: number; height: number };
export type CoverKind = "left" | "right" | "column" | "focus";
export type RoomLayout = {
  /** The viewport, in CSS pixels (the canvas fills it). */
  width: number;
  height: number;
  covers: readonly { kind: CoverKind; rect: Rect }[];
};

/** A margin beside a column narrower than this is not worth aiming at; the room centres on the open region instead. */
export const MIN_MARGIN = 220;

/** Below this aspect (width / height) the camera pulls back and rises, with the back wall as the hero. */
export const PORTRAIT_ASPECT = 0.8;

const visible = (rect: Rect) => rect.width > 0 && rect.height > 0;

/** The point of the viewport (CSS pixels) where the room's centre of interest should land. */
export function interestPoint(layout: RoomLayout): { x: number; y: number } {
  const { width, height } = layout;
  const covers = layout.covers.filter((cover) => visible(cover.rect));
  const focus = covers.find((cover) => cover.kind === "focus");
  if (focus) return { x: focus.rect.left + focus.rect.width / 2, y: focus.rect.top + focus.rect.height / 2 };

  let left = 0;
  let right = width;
  for (const cover of covers) {
    if (cover.kind === "left") left = Math.max(left, Math.min(width, cover.rect.left + cover.rect.width));
    if (cover.kind === "right") right = Math.min(right, Math.max(0, cover.rect.left));
  }
  if (right - left < 1) {
    left = 0;
    right = width;
  }
  const y = height / 2;
  const columns = covers.filter((cover) => cover.kind === "column");
  if (columns.length > 0) {
    const start = Math.max(left, Math.min(...columns.map((cover) => cover.rect.left)));
    const end = Math.min(right, Math.max(...columns.map((cover) => cover.rect.left + cover.rect.width)));
    const before = start - left;
    const after = right - end;
    // The wider margin, when it can show the room; the left one on a tie (the window is centre-left).
    if (Math.max(before, after) >= MIN_MARGIN) {
      return before >= after ? { x: left + before / 2, y } : { x: end + after / 2, y };
    }
  }
  return { x: (left + right) / 2, y };
}

export type ViewOffset = { fullWidth: number; fullHeight: number; x: number; y: number; width: number; height: number };

/**
 * The arguments for `camera.setViewOffset` that put the projection's centre at `point`: the view
 * is the full frame, shifted so the frame's centre lands on the point.
 */
export function viewOffset(width: number, height: number, point: { x: number; y: number }): ViewOffset {
  return { fullWidth: width, fullHeight: height, x: width / 2 - point.x, y: height / 2 - point.y, width, height };
}

// ---------------------------------------------------------------------------------------------
// The room and the camera
// ---------------------------------------------------------------------------------------------

/** The shell's dimensions (metres-ish): floor at y 0, back wall at z `back`, left wall at x `left`. */
export const ROOM = {
  left: -4,
  right: 4,
  back: -3,
  front: 3,
  height: 3.2,
  window: { x: -1.2, width: 2.1, sill: 0.95, top: 2.45 },
  door: { x: 3.35, width: 0.95, height: 2.2 },
  hearth: { x: 1.55, width: 1.5, depth: 0.45 },
} as const;

export type CameraPose = {
  /** Radians: yaw turns the camera to the right of the room's axis, pitch looks down. */
  yaw: number;
  pitch: number;
  distance: number;
  /** Vertical field of view, degrees. */
  fov: number;
  target: [number, number, number];
};

const DEGREE = Math.PI / 180;

/**
 * The camera for a viewport aspect: a three-quarter view from the missing fourth wall (yaw ~25°,
 * pitch ~25°, a long lens from far off). Below `PORTRAIT_ASPECT` it pulls back, rises, turns more
 * square to the back wall and aims at it, so a phone crops the same room instead of re-laying it.
 * With `strip` (a `focus` cover: the phone's room strip) it aims at the window instead.
 */
export function cameraPose(aspect: number, strip = false): CameraPose {
  if (aspect < PORTRAIT_ASPECT) {
    // The phone strip is 72 px tall: it frames the window (sky, weather, the tree) over the desk.
    if (strip) return { yaw: 14 * DEGREE, pitch: 31 * DEGREE, distance: 21, fov: 30, target: [-0.6, 1.85, -2.8] };
    return { yaw: 14 * DEGREE, pitch: 35 * DEGREE, distance: 21, fov: 30, target: [-0.2, 1.05, -1.6] };
  }
  return { yaw: 25 * DEGREE, pitch: 25 * DEGREE, distance: 15, fov: 30, target: [-0.6, 1.15, -1.1] };
}

/** The camera's position for a pose, after the drift and parallax offsets (radians). */
export function cameraPosition(pose: CameraPose, yawOffset = 0, pitchOffset = 0): [number, number, number] {
  const yaw = pose.yaw + yawOffset;
  const pitch = pose.pitch + pitchOffset;
  const flat = Math.cos(pitch) * pose.distance;
  return [pose.target[0] + Math.sin(yaw) * flat, pose.target[1] + Math.sin(pitch) * pose.distance, pose.target[2] + Math.cos(yaw) * flat];
}

/** The slow drift: 1.5° of yaw end to end over a 60 s sine. */
export function driftYaw(seconds: number): number {
  return 0.75 * DEGREE * Math.sin((seconds / 60) * Math.PI * 2);
}

/** The pointer parallax for a pointer at (`nx`, `ny`) in -1..1 from the viewport centre: at most 0.5° each way. */
export function parallax(nx: number, ny: number): { yaw: number; pitch: number } {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return { yaw: -0.5 * DEGREE * clamp(nx), pitch: 0.5 * DEGREE * clamp(ny) };
}

// ---------------------------------------------------------------------------------------------
// The registry (browser only)
// ---------------------------------------------------------------------------------------------

const entries = new Map<Element, CoverKind>();
const listeners = new Set<() => void>();
let snapshot: RoomLayout = { width: 0, height: 0, covers: [] };
let observer: ResizeObserver | null = null;
let frame = 0;

function sameLayout(a: RoomLayout, b: RoomLayout): boolean {
  if (a.width !== b.width || a.height !== b.height || a.covers.length !== b.covers.length) return false;
  return a.covers.every((cover, index) => {
    const other = b.covers[index];
    return (
      cover.kind === other.kind &&
      Math.round(cover.rect.left) === Math.round(other.rect.left) &&
      Math.round(cover.rect.top) === Math.round(other.rect.top) &&
      Math.round(cover.rect.width) === Math.round(other.rect.width) &&
      Math.round(cover.rect.height) === Math.round(other.rect.height)
    );
  });
}

function measure() {
  frame = 0;
  const covers: { kind: CoverKind; rect: Rect }[] = [];
  for (const [element, kind] of entries) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) covers.push({ kind, rect: { left: box.left, top: box.top, width: box.width, height: box.height } });
  }
  const next = { width: window.innerWidth, height: window.innerHeight, covers };
  if (sameLayout(snapshot, next)) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** Measure on the next frame, once however many changes arrive before it. */
function schedule() {
  if (typeof window === "undefined" || frame) return;
  frame = requestAnimationFrame(measure);
}

/** Reports `element` as covering the room until the returned function is called. */
export function registerCover(element: Element, kind: CoverKind): () => void {
  entries.set(element, kind);
  observer ??= new ResizeObserver(schedule);
  observer.observe(element);
  schedule();
  return () => {
    entries.delete(element);
    observer?.unobserve(element);
    schedule();
  };
}

const coverRefs = new Map<CoverKind, (element: Element | null) => (() => void) | undefined>();

/**
 * A stable callback ref that reports its element as covering the room: `<aside ref={roomCover("left")}>`.
 * React 19 runs the returned cleanup when the element detaches.
 */
export function roomCover(kind: CoverKind): (element: Element | null) => (() => void) | undefined {
  let ref = coverRefs.get(kind);
  if (!ref) {
    ref = (element) => (element ? registerCover(element, kind) : undefined);
    coverRefs.set(kind, ref);
  }
  return ref;
}

/** Hear layout changes (a `useSyncExternalStore` subscriber); the window's resizes count too. */
export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("resize", schedule);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("resize", schedule);
  };
}

/** The last measured layout; unchanged identity until something moved. */
export function readLayout(): RoomLayout {
  return snapshot;
}
