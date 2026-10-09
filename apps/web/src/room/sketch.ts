/**
 * The room drawn in pencil (docs/PALACE.md, Revision 2, Before the room draws): an authored list of
 * 3D polylines in room metres (`SKETCH`), the edges a viewer sees from the fitted poses (the camera
 * is always above the room and to the right of its axis, so tops, fronts and right-hand sides), and
 * their projection with the camera's own maths (`projectPoint`) to SVG paths, so each stroke lands
 * where the 3D room will draw its edge. The 3D room's geometry is never read: the list is written
 * against `ROOM`, `ANCHORS`, `FURNITURE` and the shared sizes in `layout.ts`.
 *
 * Pure: no React, no DOM; the node test runner loads this file directly. `Sketch.tsx` draws it.
 */
import {
  BAY,
  BENCH,
  BOOKCASE,
  CHAIR,
  DESK,
  DESK_LAMP,
  HEARTH,
  MAIL_SHELF,
  projectPoint,
  ROOM,
  RUG,
  SMALL_SHELF,
  STOVE,
  WINDOW_CENTRE,
  type CameraPose,
  type Point3,
} from "./layout.ts";
import { ANCHORS, CORKBOARD, furniture, PINBOARD } from "./layout-slots.ts";

export type Stroke = {
  /** A name, unique in a list: the SVG key and the tests' handle. */
  id: string;
  points: readonly Point3[];
  /** Back to the first point at the end. */
  closed?: boolean;
  /** A wall's line, running past the frame: drawn in with the back wall, whatever its own depth. */
  shell?: boolean;
};

/** The camera's near plane (`CAMERA.near` in `RoomCanvas.tsx`): nothing nearer is drawn. */
export const NEAR = 0.5;
/** The draw-in: each stroke's own duration, and the spread of the delays from the back wall to the front. */
export const DRAW_MS = 900;
export const SPREAD_MS = 500;

/** Walls and their lines run past the room's edges, as the shell's do (`Shell.tsx`). */
const FAR_RIGHT = 14;
const FAR_FRONT = 10;
const TALL = 10;

const DEGREE = Math.PI / 180;
/** The silhouette direction for round things (the lamp, the kettle): the camera's right at a yaw between the poses' 14° and 25°. */
const SIDE: Point3 = [Math.cos(20 * DEGREE), 0, -Math.sin(20 * DEGREE)];

const add = (a: Point3, b: Point3, scale = 1): Point3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];

/** A ring of `count` points around `centre`, `a` and `b` its two radii's directions (scaled). */
function ring(centre: Point3, a: Point3, b: Point3, count = 14, from = 0, to = Math.PI * 2): Point3[] {
  const points: Point3[] = [];
  const whole = Math.abs(to - from - Math.PI * 2) < 1e-9;
  const steps = whole ? count : count - 1;
  for (let index = 0; index < count; index++) {
    const angle = from + ((to - from) * index) / steps;
    points.push(add(add(centre, a, Math.cos(angle)), b, Math.sin(angle)));
  }
  return points;
}

/** A horizontal ellipse (a circle on the floor plan) of radius `r` at `centre`. */
const flatRing = (centre: Point3, r: number) => ring(centre, [r, 0, 0], [0, 0, r]);

/** An axis-aligned rectangle at height `y`, from x `x0`..`x1`, z `z0`..`z1`. */
const flat = (x0: number, x1: number, y: number, z0: number, z1: number): Point3[] => [
  [x0, y, z0],
  [x1, y, z0],
  [x1, y, z1],
  [x0, y, z1],
];

/** A rectangle facing the room (constant z), x `x0`..`x1`, y `y0`..`y1`. */
const facing = (x0: number, x1: number, y0: number, y1: number, z: number): Point3[] => [
  [x0, y0, z],
  [x0, y1, z],
  [x1, y1, z],
  [x1, y0, z],
];

/** A point given in a piece's own frame (centred at `x`, `z` and turned `turn` about y), in room metres. */
function turned(x: number, z: number, turn: number, local: Point3): Point3 {
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  return [x + local[0] * c + local[2] * s, local[1], z - local[0] * s + local[2] * c];
}

// ---------------------------------------------------------------------------------------------
// The strokes
// ---------------------------------------------------------------------------------------------

function shell(): Stroke[] {
  const { back, left, hearth, door } = ROOM;
  const breastLeft = hearth.x - hearth.width / 2;
  const breastRight = hearth.x + hearth.width / 2;
  const breastFront = back + hearth.depth;
  const casingLeft = door.x - door.width / 2 - 0.08;
  const casingRight = door.x + door.width / 2 + 0.08;
  return [
    // The floor line: the left wall's foot, the corner, the back wall's foot up to the chimney breast.
    {
      id: "floor-line",
      shell: true,
      points: [
        [left, 0, FAR_FRONT],
        [left, 0, back],
        [breastLeft, 0, back],
      ],
    },
    { id: "back-foot-hearth", shell: true, points: [[breastRight, 0, back], [casingLeft, 0, back]] },
    { id: "back-foot-right", shell: true, points: [[casingRight, 0, back], [FAR_RIGHT, 0, back]] },
    { id: "corner", shell: true, points: [[left, 0, back], [left, TALL, back]] },
    // The chimney breast: its two front corners and the corner where its right side meets the wall.
    { id: "breast-left", shell: true, points: [[breastLeft, 0, breastFront], [breastLeft, TALL, breastFront]] },
    { id: "breast-right", shell: true, points: [[breastRight, 0, breastFront], [breastRight, TALL, breastFront]] },
    { id: "breast-side", shell: true, points: [[breastRight, 0, back], [breastRight, TALL, back]] },
  ];
}

/** The window's frame on the glass (the frame's front face sits 0.07 into the wall). */
const FRAME_Z = WINDOW_CENTRE[2] + 0.05;
const BAR = 0.07;

function windowStrokes(bay: boolean): Stroke[] {
  const { window: w, back } = ROOM;
  const left = w.x - w.width / 2;
  const right = w.x + w.width / 2;
  const transom = w.sill + (w.top - w.sill) * 0.62;
  const sillFront = back + 0.25;
  const sillTop = w.sill + 0.01;
  const strokes: Stroke[] = [
    { id: "window", closed: true, points: facing(left, right, w.sill, w.top, back) },
    {
      id: "sill",
      points: [
        [left - 0.15, sillTop, back],
        [left - 0.15, sillTop, sillFront],
        [right + 0.15, sillTop, sillFront],
        [right + 0.15, sillTop, back],
      ],
    },
  ];
  if (!bay) {
    strokes.push(
      { id: "window-frame", closed: true, points: facing(left + BAR, right - BAR, w.sill + BAR, w.top - BAR, FRAME_Z) },
      { id: "mullion", points: [[w.x, w.sill + BAR, FRAME_Z], [w.x, w.top - BAR, FRAME_Z]] },
      { id: "transom", points: [[left + BAR, transom, FRAME_Z], [right - BAR, transom, FRAME_Z]] },
    );
    return strokes;
  }
  // The bay (a milestone): beyond the opening, a box of glass with angled sides, seen through it.
  const outer = back - 0.25;
  const front = outer - BAY.depth;
  const half = (w.width - 2 * BAY.cheek * 0.55) / 2;
  const outline = (y: number): Point3[] => [
    [left, y, outer],
    [w.x - half, y, front],
    [w.x + half, y, front],
    [right, y, outer],
  ];
  strokes.push(
    { id: "bay-bottom", points: outline(w.sill) },
    { id: "bay-top", points: outline(w.top) },
    { id: "bay-left", points: [[w.x - half, w.sill, front], [w.x - half, w.top, front]] },
    { id: "bay-right", points: [[w.x + half, w.sill, front], [w.x + half, w.top, front]] },
  );
  return strokes;
}

function doorStrokes(): Stroke[] {
  const { door, back } = ROOM;
  const left = door.x - door.width / 2;
  const right = door.x + door.width / 2;
  const z = back + 0.05;
  const hallway = back - 0.25 - 1.2;
  return [
    { id: "door-casing", points: facing(left - 0.08, right + 0.08, 0, door.height + 0.08, z) },
    { id: "door-opening", points: facing(left, right, 0, door.height, z) },
    // The foot of the hallway's back wall, where it shows through the opening from the camera's side.
    { id: "hallway", points: [[left - 0.12, 0, hallway], [right - 0.12, 0, hallway]] },
  ];
}

function deskStrokes(): Stroke[] {
  const { x, z, width, depth, top, thickness, leg, drawer } = DESK;
  const [x0, x1, z0, z1] = [x - width / 2, x + width / 2, z - depth / 2, z + depth / 2];
  const under = top - thickness;
  const legs: Stroke[] = [
    [-leg.x, -leg.z],
    [leg.x, -leg.z],
    [-leg.x, leg.z],
    [leg.x, leg.z],
  ].map(([lx, lz], index): Stroke => {
    const [cx, cz, h] = [x + lx, z + lz, leg.size / 2];
    return {
      id: `desk-leg-${index}`,
      points: [
        [cx - h, under, cz + h],
        [cx - h, 0, cz + h],
        [cx + h, 0, cz + h],
        [cx + h, under, cz + h],
      ],
    };
  });
  const [d0, d1] = [x + drawer.x - drawer.width / 2, x + drawer.x + drawer.width / 2];
  const dz = z + drawer.depth / 2;
  return [
    { id: "desk-top", closed: true, points: flat(x0, x1, top, z0, z1) },
    {
      id: "desk-edge",
      points: [
        [x0, top, z1],
        [x0, under, z1],
        [x1, under, z1],
        [x1, under, z0],
        [x1, top, z0],
      ],
    },
    ...legs,
    {
      id: "desk-drawer",
      points: [
        [d0, under, dz],
        [d0, drawer.y - drawer.height / 2, dz],
        [d1, drawer.y - drawer.height / 2, dz],
        [d1, under, dz],
      ],
    },
  ];
}

function chairStrokes(): Stroke[] {
  const at = (local: Point3) => turned(CHAIR.x, CHAIR.z, CHAIR.turn, local);
  const seat = CHAIR.seat;
  const legs = [
    [-0.21, -0.21],
    [0.21, -0.21],
    [-0.21, 0.21],
    [0.21, 0.21],
  ].map(([lx, lz], index): Stroke => ({ id: `chair-leg-${index}`, points: [at([lx, 0, lz]), at([lx, seat - 0.06, lz])] }));
  return [
    { id: "chair-seat", closed: true, points: flat(-0.25, 0.25, seat, -0.24, 0.24).map(at) },
    {
      id: "chair-back",
      closed: true,
      points: facing(-0.25, 0.25, seat + 0.01, seat + 0.53, 0.22).map(at),
    },
    ...legs,
  ];
}

function lampStrokes(): Stroke[] {
  const { x, z, base, shade } = DESK_LAMP;
  const y = DESK.top;
  const bottom = y + shade.y - shade.height / 2;
  const top = y + shade.y + shade.height / 2;
  const side = (r: number, at: number): Point3 => add([x, at, z], SIDE, r);
  return [
    { id: "lamp-base", closed: true, points: flatRing([x, y + 0.03, z], base) },
    { id: "lamp-stem", points: [[x, y + 0.04, z], [x, bottom, z]] },
    { id: "lamp-shade", closed: true, points: [side(-shade.bottom, bottom), side(-shade.top, top), side(shade.top, top), side(shade.bottom, bottom)] },
    { id: "lamp-rim", closed: true, points: flatRing([x, bottom, z], shade.bottom) },
  ];
}

function stoveStrokes(): Stroke[] {
  const { x, z } = STOVE;
  const [x0, x1, z0, z1] = [x - 0.22, x + 0.22, z - 0.19, z + 0.19];
  const kettle: Point3 = [x - 0.05, 0.6, z + 0.02];
  const pipe = { x: x + 0.12, z: z - 0.08, r: 0.045, elbow: 1.46 };
  return [
    {
      id: "stove-body",
      points: [
        [x0, 0.48, z1],
        [x0, 0.12, z1],
        [x1, 0.12, z1],
        [x1, 0.12, z0],
        [x1, 0.48, z0],
      ],
    },
    { id: "stove-corner", points: [[x1, 0.12, z1], [x1, 0.48, z1]] },
    { id: "stove-plate", closed: true, points: flat(x - 0.24, x + 0.24, 0.51, z - 0.21, z + 0.21) },
    { id: "kettle", closed: true, points: ring(kettle, add([0, 0, 0], SIDE, 0.11), [0, 0.088, 0], 16) },
    { id: "kettle-spout", points: [[x + 0.023, 0.593, z + 0.02], [x + 0.117, 0.667, z + 0.02]] },
    { id: "kettle-handle", points: ring([kettle[0], 0.68, kettle[2]], add([0, 0, 0], SIDE, 0.07), [0, 0.07, 0], 9, 0, Math.PI) },
    {
      id: "pipe-left",
      points: [
        [pipe.x - pipe.r, 0.51, pipe.z],
        [pipe.x - pipe.r, pipe.elbow, pipe.z],
        [pipe.x, pipe.elbow + pipe.r, pipe.z],
        [pipe.x, pipe.elbow + pipe.r, ROOM.back],
      ],
    },
    {
      id: "pipe-right",
      points: [
        [pipe.x + pipe.r, 0.51, pipe.z],
        [pipe.x + pipe.r, pipe.elbow - pipe.r, pipe.z],
        [pipe.x + pipe.r, pipe.elbow - pipe.r, ROOM.back],
      ],
    },
  ];
}

function hearthStrokes(): Stroke[] {
  const { hearth, back } = ROOM;
  const front = back + hearth.depth;
  const { surround, firebox, mantel, stone } = HEARTH;
  const face = front + surround.depth;
  const [m0, m1] = [hearth.x - mantel.width / 2, hearth.x + mantel.width / 2];
  const [mz0, mz1] = [front + mantel.out - mantel.depth / 2, front + mantel.out + mantel.depth / 2];
  const [my0, my1] = [mantel.y - mantel.height / 2, mantel.y + mantel.height / 2];
  const [s0, s1] = [hearth.x - stone.width / 2, hearth.x + stone.width / 2];
  const stoneFront = front + stone.out + stone.depth / 2;
  return [
    { id: "hearth-surround", points: facing(hearth.x - surround.half, hearth.x + surround.half, 0, surround.height, face) },
    { id: "hearth-firebox", closed: true, points: facing(hearth.x - firebox.half, hearth.x + firebox.half, stone.height, firebox.height, face + 0.01) },
    { id: "mantel-top", closed: true, points: flat(m0, m1, my1, mz0, mz1) },
    {
      id: "mantel-edge",
      points: [
        [m0, my1, mz1],
        [m0, my0, mz1],
        [m1, my0, mz1],
        [m1, my0, mz0],
        [m1, my1, mz0],
      ],
    },
    {
      id: "hearthstone",
      points: [
        [s0, stone.height, front],
        [s0, stone.height, stoneFront],
        [s1, stone.height, stoneFront],
        [s1, stone.height, front],
      ],
    },
  ];
}

/** The small shelf on the left wall the room starts with: two boards and their brackets. */
function smallShelfStrokes(): Stroke[] {
  const { x, z, boards, depth, length, thickness, brackets } = SMALL_SHELF;
  const front = x + depth / 2;
  const [z0, z1] = [z - length / 2, z + length / 2];
  return [
    ...boards.flatMap((y, index): Stroke[] => [
      {
        id: `shelf-board-${index}`,
        points: [
          [ROOM.left, y + thickness / 2, z0],
          [front, y + thickness / 2, z0],
          [front, y + thickness / 2, z1],
          [ROOM.left, y + thickness / 2, z1],
        ],
      },
      { id: `shelf-edge-${index}`, points: [[front, y - thickness / 2, z0], [front, y - thickness / 2, z1], [front, y + thickness / 2, z1]] },
    ]),
    ...brackets.map(
      (dz, index): Stroke => ({
        id: `shelf-bracket-${index}`,
        closed: true,
        points: [
          [ROOM.left, boards[0] - 0.17, z + dz],
          [ROOM.left, boards[0] - thickness / 2, z + dz],
          [front - 0.02, boards[0] - thickness / 2, z + dz],
        ],
      }),
    ),
  ];
}

/** A floor-standing bookcase against the left wall from z `z0` to `z1` (the session milestones'). */
function bookcaseStrokes(id: string, z0: number, z1: number, shelves: readonly number[]): Stroke[] {
  const { depth, height } = BOOKCASE;
  const front = ROOM.left + depth;
  return [
    {
      id: `${id}-top`,
      points: [
        [ROOM.left, height, z0],
        [front, height, z0],
        [front, height, z1],
        [ROOM.left, height, z1],
      ],
    },
    {
      id: `${id}-front`,
      points: [
        [front, height, z0],
        [front, 0, z0],
        [front, 0, z1],
        [front, height, z1],
      ],
    },
    {
      id: `${id}-side`,
      points: [
        [front, 0, z1],
        [ROOM.left, 0, z1],
        [ROOM.left, height, z1],
      ],
    },
    ...shelves.map((y, index): Stroke => ({ id: `${id}-shelf-${index}`, points: [[front, y, z0 + 0.04], [front, y, z1 - 0.04]] })),
  ];
}

function bookcaseFor(id: "tall-bookcase" | "second-bookcase"): Stroke[] {
  const piece = furniture(id);
  const centre = piece.rows[0][2] + (piece.pitch[2] * (piece.perRow - 1)) / 2;
  const half = (piece.pitch[2] * piece.perRow + 0.12) / 2;
  return bookcaseStrokes(
    id,
    centre - half,
    centre + half,
    piece.rows.map((row) => row[1]),
  );
}

/** The corkboard, or the wide pinboard in its place, on the left wall above the shelving. */
function boardStrokes(width: number, centre: number): Stroke[] {
  const [, y] = ANCHORS.board;
  const x = ROOM.left + 0.04;
  const [z0, z1] = [centre - (width + 0.06) / 2, centre + (width + 0.06) / 2];
  const half = CORKBOARD.height / 2;
  const plane = (y0: number, y1: number, za: number, zb: number, at: number): Point3[] => [
    [at, y0, za],
    [at, y1, za],
    [at, y1, zb],
    [at, y0, zb],
  ];
  return [
    { id: "board-frame", closed: true, points: plane(y - half, y + half, z0, z1, x) },
    { id: "board-cork", closed: true, points: plane(y - half + 0.04, y + half - 0.04, z0 + 0.04, z1 - 0.04, x + 0.01) },
  ];
}

/** The furniture with slots by the hearth and the door, empty: the plant stand, the mail tray's shelf, the key rack. */
function slotStrokes(): Stroke[] {
  const stand = furniture("plant-stand");
  const sx = stand.rows[0][0] + (stand.pitch[0] * (stand.perRow - 1)) / 2;
  const sw = (stand.pitch[0] * stand.perRow + 0.04) / 2;
  const sz = stand.rows[0][2];
  const [sz0, sz1] = [sz - 0.13, sz + 0.13];
  const legX = sw - 0.02;
  const legZ = 0.11;
  const rack = furniture("key-rack");
  const rx = rack.rows[0][0] + (rack.pitch[0] * (rack.perRow - 1)) / 2;
  const rw = (rack.pitch[0] * rack.perRow + 0.06) / 2;
  const [, ry, rz] = rack.rows[0];
  const shelf = MAIL_SHELF;
  const [m0, m1] = [shelf.x - shelf.width / 2, shelf.x + shelf.width / 2];
  const mTop = shelf.y + 0.015;
  const mFront = shelf.z + shelf.depth / 2;
  return [
    ...stand.rows.map((row, index): Stroke => ({ id: `stand-tier-${index}`, closed: true, points: flat(sx - sw, sx + sw, row[1], sz0, sz1) })),
    { id: "stand-leg-0", points: [[sx - legX, 0, sz + legZ], [sx - legX, stand.rows[0][1], sz + legZ]] },
    { id: "stand-leg-1", points: [[sx + legX, 0, sz + legZ], [sx + legX, stand.rows[0][1], sz + legZ]] },
    { id: "stand-leg-2", points: [[sx + legX, 0, sz - legZ], [sx + legX, stand.rows[0][1], sz - legZ]] },
    {
      id: "mail-shelf",
      points: [
        [m0, mTop, ROOM.back],
        [m0, mTop, mFront],
        [m1, mTop, mFront],
        [m1, mTop, ROOM.back],
      ],
    },
    { id: "mail-tray", points: facing(shelf.x - 0.16, shelf.x + 0.16, mTop + 0.01, mTop + 0.06, mFront - 0.02) },
    { id: "key-rack", closed: true, points: facing(rx - rw, rx + rw, ry + 0.01 - 0.035, ry + 0.01 + 0.035, rz - 0.0125) },
  ];
}

function floorStrokes(): Stroke[] {
  const rug = (size: readonly number[], y: number) => flat(RUG.x - size[0] / 2, RUG.x + size[0] / 2, y, RUG.z - size[1] / 2, RUG.z + size[1] / 2);
  const { x, z, width, depth, top, thickness, leg } = BENCH;
  const [x0, x1, z0, z1] = [x - width / 2, x + width / 2, z - depth / 2, z + depth / 2];
  const [over, under] = [top + thickness / 2, top - thickness / 2];
  return [
    { id: "rug", closed: true, points: rug(RUG.outer, 0.03) },
    { id: "rug-field", closed: true, points: rug(RUG.inner, 0.034) },
    { id: "bench-top", closed: true, points: flat(x0, x1, over, z0, z1) },
    {
      id: "bench-edge",
      points: [
        [x0, over, z1],
        [x0, under, z1],
        [x1, under, z1],
        [x1, under, z0],
        [x1, over, z0],
      ],
    },
    { id: "bench-leg-0", points: [[x - leg.x, 0, z + leg.z], [x - leg.x, under, z + leg.z]] },
    { id: "bench-leg-1", points: [[x + leg.x, 0, z + leg.z], [x + leg.x, under, z + leg.z]] },
    { id: "bench-leg-2", points: [[x + leg.x, 0, z - leg.z], [x + leg.x, under, z - leg.z]] },
  ];
}

/**
 * The strokes for the room with `reached` milestones in (none: the room as it starts). Milestones
 * change only the lines they change: the tall bookcase replaces the small shelf, the second
 * bookcase stands beside it, the wide pinboard replaces the corkboard, and the bay's outline shows
 * beyond the window (whose mullion and transom go with the panes). The rest are left out.
 */
export function sketchStrokes(reached: ReadonlySet<string> = new Set()): Stroke[] {
  const bay = reached.has("bay-window");
  const wide = reached.has("wide-pinboard");
  return [
    ...shell(),
    ...windowStrokes(bay),
    ...doorStrokes(),
    ...deskStrokes(),
    ...chairStrokes(),
    ...lampStrokes(),
    ...stoveStrokes(),
    ...hearthStrokes(),
    ...(reached.has("tall-bookcase") ? bookcaseFor("tall-bookcase") : smallShelfStrokes()),
    ...(reached.has("second-bookcase") ? bookcaseFor("second-bookcase") : []),
    ...(wide ? boardStrokes(PINBOARD.width, PINBOARD.centre) : boardStrokes(CORKBOARD.width, ANCHORS.board[2])),
    ...slotStrokes(),
    ...floorStrokes(),
  ];
}

/** The room as it starts, in pencil. */
export const SKETCH: readonly Stroke[] = sketchStrokes();

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

export type Size = { width: number; height: number };
export type ScreenPoint = { x: number; y: number };

/** A point in front of the near plane, projected; the depth `z` kept for clipping. */
type Projected = { x: number; y: number; z: number; point: Point3 };

const lerp3 = (a: Point3, b: Point3, t: number): Point3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Splits a polyline into the runs in front of the near plane (depth > `NEAR`): a segment that
 * crosses it is cut where it does (depth is affine along a segment in room space, so the cut is
 * exact), and a run behind it is dropped.
 */
function clipToNear(pose: CameraPose, points: readonly Point3[], size: Size): ScreenPoint[][] {
  const project = (point: Point3): Projected => ({ ...projectPoint(pose, point, size), point });
  const runs: ScreenPoint[][] = [];
  let run: ScreenPoint[] = [];
  let previous: Projected | null = null;
  for (const point of points) {
    const current = project(point);
    if (previous) {
      const [inA, inB] = [previous.z > NEAR, current.z > NEAR];
      if (inA !== inB) {
        const cut = project(lerp3(previous.point, current.point, (previous.z - NEAR) / (previous.z - current.z)));
        if (inA) {
          run.push({ x: cut.x, y: cut.y });
          runs.push(run);
          run = [];
        } else run.push({ x: cut.x, y: cut.y });
      }
    }
    if (current.z > NEAR) run.push({ x: current.x, y: current.y });
    previous = current;
  }
  if (run.length > 1) runs.push(run);
  return runs.filter((part) => part.length > 1);
}

export type ProjectedStroke = {
  id: string;
  /** The stroke's runs in front of the near plane, in CSS pixels (a stroke wholly in front has one). */
  runs: ScreenPoint[][];
  closed: boolean;
  /** Room depth for the draw-in (z, back wall at `ROOM.back`): the shell's lines count at the back wall. */
  depth: number;
};

/**
 * Each stroke's points mapped with `projectPoint` (the camera's maths) for `pose` on a `size`
 * viewport: CSS pixels, where the 3D room draws the same edge. Strokes behind the near plane are
 * cut at it.
 */
export function projectSketch(pose: CameraPose, size: Size, strokes: readonly Stroke[] = SKETCH): ProjectedStroke[] {
  return strokes.map((stroke) => {
    const points = stroke.closed ? [...stroke.points, stroke.points[0]] : stroke.points;
    const mean = stroke.points.reduce((sum, point) => sum + point[2], 0) / stroke.points.length;
    return {
      id: stroke.id,
      runs: clipToNear(pose, points, size),
      closed: !!stroke.closed,
      depth: stroke.shell ? ROOM.back : Math.max(ROOM.back, mean),
    };
  });
}

/** The draw-in's delays (ms), in the strokes' order: the back wall at 0, the nearest stroke at `SPREAD_MS`. */
export function drawDelays(strokes: readonly { depth: number }[]): number[] {
  const depths = strokes.map((stroke) => stroke.depth);
  const [near, far] = [Math.max(...depths), Math.min(...depths)];
  return depths.map((depth) => (near > far ? Math.round((SPREAD_MS * (depth - far)) / (near - far)) : 0));
}

const fixed = (value: number) => Math.round(value * 10) / 10;

/** An SVG path's `d` for a projected stroke's runs (a closed stroke's run already returns to its start). */
export function pathOf(runs: readonly (readonly ScreenPoint[])[]): string {
  return runs.map((run) => run.map((point, index) => `${index ? "L" : "M"}${fixed(point.x)} ${fixed(point.y)}`).join("")).join("");
}

/**
 * Clips a polygon to the near plane (Sutherland-Hodgman against the one plane) and projects it;
 * empty when it lies wholly behind.
 */
function projectPolygon(pose: CameraPose, points: readonly Point3[], size: Size): ScreenPoint[] {
  const out: ScreenPoint[] = [];
  const depth = (point: Point3) => projectPoint(pose, point, size).z;
  const push = (point: Point3) => {
    const { x, y } = projectPoint(pose, point, size);
    out.push({ x, y });
  };
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const [za, zb] = [depth(a), depth(b)];
    if (za > NEAR) push(a);
    if (za > NEAR !== zb > NEAR) push(lerp3(a, b, (za - NEAR) / (za - zb)));
  }
  return out;
}

const polygonPath = (points: readonly ScreenPoint[]) => (points.length > 2 ? `${pathOf([points])}Z` : "");

export type Glow = { x: number; y: number; r: number };

export type SketchFigure = {
  strokes: { id: string; d: string; delay: number }[];
  /** The walls' region above the floor lines, a shade lighter than the ground. */
  wall: string;
  /** The window's panes (the glass inside the frame; with the bay, the whole opening). */
  panes: string;
  lamp: Glow | null;
  hearth: Glow | null;
  /** Where `WINDOW_CENTRE` lands: the window hotspot's point, for the UI test. */
  window: ScreenPoint;
};

/** A glow of `radius` metres around `centre`, as a circle on screen; none when behind the near plane. */
function glowAt(pose: CameraPose, centre: Point3, radius: number, size: Size): Glow | null {
  const { x, y, z } = projectPoint(pose, centre, size);
  if (z <= NEAR) return null;
  const tV = Math.tan((pose.fov / 2) * DEGREE);
  return { x, y, r: (radius * size.height) / (2 * z * tV) };
}

/** Everything `Sketch.tsx` draws, for `pose` on a `size` viewport, with `strokes`. */
export function sketchFigure(pose: CameraPose, size: Size, strokes: readonly Stroke[] = SKETCH, bay = false): SketchFigure {
  const projected = projectSketch(pose, size, strokes);
  const delays = drawDelays(projected);
  const { window: w, back, left } = ROOM;
  const wall: Point3[] = [
    [left, 0, FAR_FRONT],
    [left, 0, back],
    [FAR_RIGHT, 0, back],
    [FAR_RIGHT, TALL, back],
    [left, TALL, back],
    [left, TALL, FAR_FRONT],
  ];
  const panes = bay
    ? facing(w.x - w.width / 2, w.x + w.width / 2, w.sill, w.top, back)
    : facing(w.x - w.width / 2 + BAR, w.x + w.width / 2 - BAR, w.sill + BAR, w.top - BAR, FRAME_Z);
  const centre = projectPoint(pose, WINDOW_CENTRE, size);
  return {
    strokes: projected.map((stroke, index) => ({ id: stroke.id, d: pathOf(stroke.runs), delay: delays[index] })).filter((stroke) => stroke.d !== ""),
    wall: polygonPath(projectPolygon(pose, wall, size)),
    panes: polygonPath(projectPolygon(pose, panes, size)),
    lamp: glowAt(pose, [DESK_LAMP.x, DESK.top + DESK_LAMP.shade.y - 0.05, DESK_LAMP.z], 0.9, size),
    hearth: glowAt(pose, [ROOM.hearth.x, 0.35, back + ROOM.hearth.depth + 0.1], 1.0, size),
    window: { x: centre.x, y: centre.y },
  };
}
