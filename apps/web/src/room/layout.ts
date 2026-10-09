/**
 * Where the room shows (docs/PALACE.md, Camera, Revisions 3 and 4): the camera's pose is fitted to
 * the room for the viewport's aspect (`framePose`) and aimed a little right of the fit in
 * landscape, and nothing else sets the view: no panel, no page and nothing the user does moves it.
 * The registry below measures the viewport the canvas fills (`registerStage`) only when it resizes
 * or the window does, never per frame; the sketch and the snapshot read the same size, so the
 * three agree on one pose.
 */

export type RoomLayout = {
  /**
   * The viewport, in CSS pixels: the room's fixed element's box (`registerStage`), which the canvas
   * fills and R3F measures, so the camera, the sketch and the snapshot share one size; before it
   * registers, the root's client size (without a classic scrollbar, unlike `innerWidth`).
   */
  width: number;
  height: number;
};

/** At and below this aspect (width / height) the portrait pose: higher, squarer to the back wall, framing the window to the hearth. */
export const PORTRAIT_ASPECT = 0.8;

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

export type Point3 = readonly [number, number, number];

/** The window opening's centre, on the glass. */
export const WINDOW_CENTRE: Point3 = [ROOM.window.x, (ROOM.window.sill + ROOM.window.top) / 2, ROOM.back - 0.12];

/**
 * Sizes the scene and the sketch (`sketch.ts`) both read, so the sketch's lines stay on the 3D
 * room's edges. Metres, in the room's frame; the scene files build their meshes from these.
 */
/** The desk under the window: its top's centre and size, its legs' inset, and the drawer block under its right half. */
export const DESK = {
  x: ROOM.window.x,
  z: ROOM.back + 0.45,
  width: 1.84,
  depth: 0.68,
  top: 0.795,
  thickness: 0.07,
  leg: { x: 0.82, z: 0.28, size: 0.07 },
  drawer: { x: 0.55, width: 0.5, height: 0.2, depth: 0.6, y: 0.62 },
} as const;

/** The desk lamp at the desk's left end, on the desk's top: base, stem and shade. */
export const DESK_LAMP = { x: DESK.x - 0.62, z: DESK.z - 0.1, base: 0.12, stem: 0.38, shade: { y: 0.44, height: 0.2, top: 0.07, bottom: 0.17 } } as const;

/**
 * Portal's chair: pulled out from the desk and turned side-on to the room, so its seat (where the
 * year's cat sleeps) shows from the camera instead of hiding behind the backrest.
 */
export const CHAIR = { x: ROOM.window.x + 0.2, z: ROOM.back + 0.45 + 0.72, turn: -1.2, seat: 0.42 } as const;

/** Where the stove stands: against the back wall, between the desk and the hearth. */
export const STOVE = { x: 0.32, z: ROOM.back + 0.3 } as const;

/** The hearth's parts in front of the chimney breast: the brick surround, the firebox, the mantel shelf and the hearthstone. */
export const HEARTH = {
  surround: { half: 0.62, height: 1.08, depth: 0.04 },
  firebox: { half: 0.4, height: 0.78 },
  mantel: { width: 1.7, y: 1.14, height: 0.08, depth: 0.3, out: 0.08 },
  stone: { width: 1.7, height: 0.05, depth: 0.55, out: 0.28 },
} as const;

/** The rug on the floor: its centre, the border's size and the inner field's. */
export const RUG = { x: 0.3, z: 0.5, outer: [3.7, 2.5], inner: [3.3, 2.1] } as const;

/** The robots' workbench on the rug: centre, size, the top's height, the legs' offsets. */
export const BENCH = { x: 0.3, z: 0.6, width: 2.9, depth: 0.34, top: 0.25, thickness: 0.045, leg: { x: 1.38, z: 0.12 } } as const;

/** The small shelf on the left wall the room starts with: two boards, two brackets under the lower one. */
export const SMALL_SHELF = { x: ROOM.left + 0.17, z: -1.3, boards: [1.65, 2.15], depth: 0.3, length: 1.5, thickness: 0.05, brackets: [-0.7, 0.7] } as const;

/** A floor-standing bookcase against the left wall (the session milestones'). */
export const BOOKCASE = { depth: 0.38, height: 2.45 } as const;

/** The mail tray's shelf on the back wall between the chimney breast and the door. */
export const MAIL_SHELF = { x: 2.55, y: 1.0, z: ROOM.back + 0.13, width: 0.44, depth: 0.26 } as const;

/** The bay window (a milestone): how far it stands out beyond the wall, and how its sides angle in. */
export const BAY = { depth: 0.55, cheek: 0.45 } as const;

export type CameraPose = {
  /** Radians: yaw turns the camera to the right of the room's axis, pitch looks down. */
  yaw: number;
  pitch: number;
  distance: number;
  /** Vertical field of view, degrees. */
  fov: number;
  target: [number, number, number];
};

/** An axis-aligned box in room metres. */
export type HeroBox = { min: Point3; max: Point3 };

const DEGREE = Math.PI / 180;

/** The vertical field of view (degrees) every pose uses: the Canvas's `CAMERA` in `RoomCanvas.tsx`. */
export const FOV = 30;

/** At and above this aspect (width / height) the landscape pose; at and below `PORTRAIT_ASPECT` the portrait one; blended between. */
export const LANDSCAPE_ASPECT = 1.4;

/** The share of the viewport left free on every side of the fitted hero box. */
export const FRAME_PAD = 0.06;

/**
 * Bumped when the camera's rule changes so that a stored snapshot (`snapshot.ts`), drawn from the
 * old pose, is not shown under the new one. 2: Revision 3, the landscape aim and no panel offsets.
 * 3: Revision 4, no view offset at all (the phone strip is gone).
 */
export const CAMERA_VERSION = 3;

/**
 * The two anchor poses (docs/PALACE.md, Camera): the angles, the hero box the fit frames, and the
 * aim. The landscape box runs from the shelving's wall to the door casing and from the back wall
 * to the rug's front edge; the portrait one from the inside sill to the hearth's opening, back
 * wall to just before the robots' bench.
 *
 * `aim` (Revision 3) moves the fitted target along the camera's right axis, in metres; a negative
 * value draws the room to the right of the centred fit. The landscape aim is the composition
 * Moses chose on the session page beside a 280 px sidebar, which at 1440 × 900 drew the frame
 * 140 px right of the viewport's centre: the window and desk near the middle of the open region,
 * the shelving under the sidebar's glass, the door casing's top right corner cropped. It is fixed
 * now, with or without the sidebar. The portrait aim is zero: the phone is centred.
 */
export const ANCHOR_POSES = {
  landscape: { yaw: 25 * DEGREE, pitch: 25 * DEGREE, box: { min: [-4, 0, -3], max: [3.9, 3.15, 1.75] }, aim: -1.08 },
  portrait: { yaw: 14 * DEGREE, pitch: 30 * DEGREE, box: { min: [-2.4, 0, -3], max: [2.3, 2.6, 1.0] }, aim: 0 },
} as const satisfies Record<string, { yaw: number; pitch: number; box: HeroBox; aim: number }>;

/** How far `aspect` lies from the portrait anchor (0) to the landscape one (1). */
function blendOf(aspect: number): number {
  return Math.min(1, Math.max(0, (aspect - PORTRAIT_ASPECT) / (LANDSCAPE_ASPECT - PORTRAIT_ASPECT)));
}

const mix = (portrait: number, landscape: number, t: number) => portrait + t * (landscape - portrait);

/** The yaw, pitch, hero box and aim for a viewport aspect: the anchors', blended between 0.8 and 1.4. */
export function frameSpec(aspect: number): { yaw: number; pitch: number; box: HeroBox; aim: number } {
  const t = blendOf(aspect);
  const { landscape: l, portrait: p } = ANCHOR_POSES;
  const edge = (side: "min" | "max") => [0, 1, 2].map((axis) => mix(p.box[side][axis], l.box[side][axis], t)) as unknown as Point3;
  return { yaw: mix(p.yaw, l.yaw, t), pitch: mix(p.pitch, l.pitch, t), box: { min: edge("min"), max: edge("max") }, aim: mix(p.aim, l.aim, t) };
}

type Basis = { f: Point3; r: Point3; u: Point3 };

/** The camera's axes for a yaw and pitch: `f` from the target to the camera, `r` its right, `u` its up. */
function basis(yaw: number, pitch: number): Basis {
  const [sy, cy, sp, cp] = [Math.sin(yaw), Math.cos(yaw), Math.sin(pitch), Math.cos(pitch)];
  return { f: [sy * cp, sp, cy * cp], r: [cy, 0, -sy], u: [-sp * sy, cp, -sp * cy] };
}

const dot = (a: Point3, b: Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The box's eight corners. */
export function boxCorners(box: HeroBox): Point3[] {
  const corners: Point3[] = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) corners.push([x, y, z]);
  return corners;
}

/** The root of `g`, continuous and decreasing on [lo, hi] with g(lo) ≥ 0 ≥ g(hi), by 50 halvings. */
function decreasingRoot(g: (value: number) => number, lo: number, hi: number): number {
  for (let step = 0; step < 50; step++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The camera for a viewport aspect (docs/PALACE.md, Camera): the blended angles, and the smallest
 * distance and the target that put the blended hero box inside the frame with `FRAME_PAD` free on
 * every side, centred, then the target moved by the blended aim along the camera's right axis
 * (Revision 3). On the axis that sets the distance the box touches the pad on both sides before
 * the aim; on the other it has equal margins. Pure; one pass, no iteration beyond the centring's
 * bisection.
 */
export function framePose(aspect: number): CameraPose {
  const { yaw, pitch, box, aim } = frameSpec(aspect);
  const { f, r, u } = basis(yaw, pitch);
  const centre: Point3 = [0, 1, 2].map((axis) => (box.min[axis] + box.max[axis]) / 2) as unknown as Point3;
  const corners = boxCorners(box).map((corner) => {
    const v: Point3 = [corner[0] - centre[0], corner[1] - centre[1], corner[2] - centre[2]];
    return { x: dot(v, r), y: dot(v, u), w: dot(v, f) };
  });
  const tV = Math.tan((FOV / 2) * DEGREE);
  const tH = tV * aspect;
  const s = 1 - 2 * FRAME_PAD;

  // 1. The distance: the smallest that lets some shift fit every pair of corners, on each axis.
  let d = 0;
  for (const i of corners) {
    for (const j of corners) {
      const w = (i.w + j.w) / 2;
      d = Math.max(d, w + (i.x - j.x) / (2 * s * tH), w + (i.y - j.y) / (2 * s * tV));
    }
  }

  // 2. The centring: the shift along r (and u) that gives the projected box equal margins.
  const centred = (axis: "x" | "y", t: number) => {
    const g = (shift: number) => {
      let max = -Infinity;
      let min = Infinity;
      for (const corner of corners) {
        const projected = (corner[axis] - shift) / ((d - corner.w) * t);
        if (projected > max) max = projected;
        if (projected < min) min = projected;
      }
      return max + min;
    };
    const values = corners.map((corner) => corner[axis]);
    return decreasingRoot(g, Math.min(...values), Math.max(...values));
  };
  const a = centred("x", tH) + aim;
  const b = centred("y", tV);
  const target = [0, 1, 2].map((axis) => centre[axis] + a * r[axis] + b * u[axis]) as [number, number, number];
  return { yaw, pitch, distance: d, fov: FOV, target };
}

/** The camera's position for a pose: `distance` from the target, back along the pose's yaw and pitch. */
export function cameraPosition(pose: CameraPose): [number, number, number] {
  const { f } = basis(pose.yaw, pose.pitch);
  return [pose.target[0] + f[0] * pose.distance, pose.target[1] + f[1] * pose.distance, pose.target[2] + f[2] * pose.distance];
}

/**
 * Where `point` (room metres) lands on a `size` viewport (CSS pixels) seen from `pose`; `z` is its
 * depth in front of the camera. The camera's own maths without three.js, shared with the sketch.
 */
export function projectPoint(pose: CameraPose, point: Point3, size: { width: number; height: number }): { x: number; y: number; z: number } {
  const { f, r, u } = basis(pose.yaw, pose.pitch);
  const v: Point3 = [point[0] - pose.target[0], point[1] - pose.target[1], point[2] - pose.target[2]];
  const z = pose.distance - dot(v, f);
  const tV = Math.tan((pose.fov / 2) * DEGREE);
  const tH = tV * (size.width / size.height);
  return {
    x: (size.width / 2) * (1 + dot(v, r) / (z * tH)),
    y: (size.height / 2) * (1 - dot(v, u) / (z * tV)),
    z,
  };
}

// ---------------------------------------------------------------------------------------------
// The registry (browser only)
// ---------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();
let snapshot: RoomLayout = { width: 0, height: 0 };
let observer: ResizeObserver | null = null;
let frame = 0;
/** The room's fixed element (`.room-scene`), whose box is the viewport the canvas fills. */
let stage: Element | null = null;

function measure() {
  frame = 0;
  const next = viewportSize();
  if (next.width === snapshot.width && next.height === snapshot.height) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** The viewport the canvas fills: the stage's box, else the root's client size. */
function viewportSize(): { width: number; height: number } {
  if (stage) {
    const box = stage.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
  }
  const root = document.documentElement;
  return { width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
}

/** Measure on the next frame, once however many changes arrive before it. */
function schedule() {
  if (typeof window === "undefined" || frame) return;
  frame = requestAnimationFrame(measure);
}

/**
 * Reports `element` (the room's fixed `.room-scene`) as the viewport the canvas fills, measured
 * whenever it resizes, until the returned function is called.
 */
export function registerStage(element: Element): () => void {
  stage = element;
  observer ??= new ResizeObserver(schedule);
  observer.observe(element);
  schedule();
  return () => {
    if (stage === element) stage = null;
    observer?.unobserve(element);
    schedule();
  };
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
