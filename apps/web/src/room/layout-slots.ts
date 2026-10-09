/**
 * The room's anchors and slots (docs/PALACE.md, Shell and anchors). Anchors are an authored list of
 * places on the shell; furniture standing at an anchor declares its own slots: rows, slots per row,
 * the kind of object it accepts, and the pitch from one slot to the next. Growth is an ordered fill:
 * items arrive oldest first, take the first piece of furniture (or row) with room, and within it
 * `slot = hash(itemId) mod capacity`, walking to the next free slot on a collision (`assignSlots`).
 * Gaps are fine. Adding an item never moves another; with the last placement given, removing one
 * never does either.
 *
 * Furniture that a milestone brings carries the milestone's id, and may replace a piece the room
 * started with (the tall bookcase replaces the small shelf, the wide pinboard the corkboard). Any
 * change here that would move an object is a `LAYOUT_VERSION` bump (`@portal/shared/room`).
 *
 * Pure: no React, no three.js; the node test runner loads this file directly.
 */
import { LAYOUT_VERSION, slotFor } from "@portal/shared/room";
import { ROOM } from "./layout.ts";

/** The slot layout's version: the shared generator version, so the server and the page agree on it. */
export const SLOT_LAYOUT_VERSION = LAYOUT_VERSION;

export type Vec3 = readonly [number, number, number];

/** Named places on the shell (metres; floor at y 0, x right, z towards the camera). */
export const ANCHORS = {
  /** The left wall's shelving: the first bookcase's centre, on the floor against the wall. */
  shelf: [ROOM.left, 0, -1.3],
  /** The second bookcase, further along the left wall. */
  shelf2: [ROOM.left, 0, 0.5],
  /** The corkboard above the shelving. */
  board: [ROOM.left, 2.78, -1.3],
  /** The window's inside sill, where active watches' plants stand. */
  sill: [ROOM.window.x, ROOM.window.sill + 0.01, ROOM.back + 0.1],
  /** The desk's top under the window. */
  desk: [ROOM.window.x, 0.795, ROOM.back + 0.45],
  /** The plant stand beside the hearth. */
  hearth: [2.45, 0, -2.2],
  /** The back wall beside the window, over the desk's end: the pinned projects' frames. */
  wall: [-3.1, 1.86, ROOM.back],
  /** The key rack on the wall by the door. */
  door: [2.55, 1.5, ROOM.back],
  /** The front-left corner of the floor: the reading nook. */
  floor: [-3.2, 0, 2.0],
} as const satisfies Record<string, Vec3>;

export type AnchorId = keyof typeof ANCHORS;

/** The corkboard above the shelving: its cork's width along the wall and the frame's height. */
export const CORKBOARD = { width: 1.3, height: 0.68 } as const;
/** The wide pinboard's width and centre along the wall (it grows towards the room's front). */
export const PINBOARD = { width: 2.1, centre: ANCHORS.board[2] + 0.35 } as const;

/** What a slot takes. */
export type SlotKind = "book" | "note" | "plant" | "frame" | "key";

export type Furniture = {
  id: string;
  anchor: AnchorId;
  kind: SlotKind;
  /** Each row's slot 0 (its centre; for books and plants the surface they stand on), in fill order. */
  rows: readonly Vec3[];
  perRow: number;
  /** From one slot to the next along a row. */
  pitch: Vec3;
  /** The milestone that brings it; none for what the room starts with. */
  milestone?: string;
  /** The piece it takes the place of once its milestone is in. */
  replaces?: string;
};

/** Books per shelf row (docs/PALACE.md: shelves fill a row of 24 at a time). */
export const BOOKS_PER_ROW = 24;
/** Book centres sit this far out from the left wall. */
const BOOK_X = ROOM.left + 0.18;
const BOOK_PITCH: Vec3 = [0, 0, 0.058];
/** The bookcases' shelf tops, in fill order: eye level first, then down, then the top shelf. */
const BOOKCASE_SHELVES = [1.68, 1.22, 0.76, 2.14, 0.3] as const;
const bookcaseRows = (z0: number): Vec3[] => BOOKCASE_SHELVES.map((y) => [BOOK_X, y, z0] as const);

/** Notes on a board: five rows from the top, twelve across. */
const NOTE_ROWS = [3.0, 2.89, 2.78, 2.67, 2.56] as const;
const NOTE_X = ROOM.left + 0.066;

/** Every piece of furniture with slots, in fill order per kind. */
export const FURNITURE: readonly Furniture[] = [
  // Books: the small shelf, then the bookcases the session milestones bring.
  { id: "small-shelf", anchor: "shelf", kind: "book", rows: [[BOOK_X, 1.675, -2.01]], perRow: BOOKS_PER_ROW, pitch: BOOK_PITCH },
  {
    id: "tall-bookcase",
    anchor: "shelf",
    kind: "book",
    rows: bookcaseRows(-2.01),
    perRow: BOOKS_PER_ROW,
    pitch: BOOK_PITCH,
    milestone: "tall-bookcase",
    replaces: "small-shelf",
  },
  { id: "second-bookcase", anchor: "shelf2", kind: "book", rows: bookcaseRows(-0.21), perRow: BOOKS_PER_ROW, pitch: BOOK_PITCH, milestone: "second-bookcase" },
  // Notes: the corkboard, which the wide pinboard replaces; sixty either way, then layered.
  { id: "corkboard", anchor: "board", kind: "note", rows: NOTE_ROWS.map((y) => [NOTE_X, y, -1.85] as const), perRow: 12, pitch: [0, 0, 0.1] },
  {
    id: "wide-pinboard",
    anchor: "board",
    kind: "note",
    rows: NOTE_ROWS.map((y) => [NOTE_X, y, -1.85] as const),
    perRow: 12,
    pitch: [0, 0, 0.164],
    milestone: "wide-pinboard",
    replaces: "corkboard",
  },
  // Plants: six on the sill (active watches); eight on the stand by the hearth (finished ones).
  { id: "sill", anchor: "sill", kind: "plant", rows: [[ROOM.window.x - 0.85, ROOM.window.sill + 0.01, ROOM.back + 0.12]], perRow: 6, pitch: [0.34, 0, 0] },
  {
    id: "plant-stand",
    anchor: "hearth",
    kind: "plant",
    rows: [
      [2.25, 0.86, -2.2],
      [2.25, 0.46, -2.2],
    ],
    perRow: 4,
    pitch: [0.135, 0, 0],
  },
  // Frames: six beside the window, then a gallery row of small ones above it.
  {
    id: "frames",
    anchor: "wall",
    kind: "frame",
    rows: [
      [-3.6, 2.15, ROOM.back + 0.02],
      [-3.6, 1.58, ROOM.back + 0.02],
    ],
    perRow: 3,
    pitch: [0.5, 0, 0],
  },
  { id: "gallery", anchor: "wall", kind: "frame", rows: [[-2.08, 2.8, ROOM.back + 0.02]], perRow: 8, pitch: [0.25, 0, 0] },
  // Keys: eight hooks on the rack by the door.
  { id: "key-rack", anchor: "door", kind: "key", rows: [[2.36, 1.44, ROOM.back + 0.04]], perRow: 8, pitch: [0.055, 0, 0] },
];

const byId = new Map(FURNITURE.map((piece) => [piece.id, piece]));

/** A piece of furniture by id (throws for an unknown one: the list is authored). */
export function furniture(id: string): Furniture {
  const piece = byId.get(id);
  if (!piece) throw new Error(`Unknown furniture "${id}".`);
  return piece;
}

/** The pieces of `kind` the room has with these milestones reached, in fill order; replaced pieces drop out. */
export function furnitureFor(kind: SlotKind, reached: ReadonlySet<string>): Furniture[] {
  const present = FURNITURE.filter((piece) => piece.kind === kind && (!piece.milestone || reached.has(piece.milestone)));
  const replaced = new Set(present.flatMap((piece) => (piece.replaces ? [piece.replaces] : [])));
  return present.filter((piece) => !replaced.has(piece.id));
}

/** How many slots the pieces hold together. */
export function capacityOf(pieces: readonly Furniture[]): number {
  return pieces.reduce((sum, piece) => sum + piece.rows.length * piece.perRow, 0);
}

/** How many rows the pieces hold together. */
export function rowsOf(pieces: readonly Furniture[]): number {
  return pieces.reduce((sum, piece) => sum + piece.rows.length, 0);
}

export type Placement = {
  id: string;
  furniture: string;
  row: number;
  slot: number;
  /** The slot's centre (books and plants: on the surface they stand on). */
  position: [number, number, number];
};

function placement(id: string, piece: Furniture, row: number, slot: number): Placement {
  const origin = piece.rows[row];
  return {
    id,
    furniture: piece.id,
    row,
    slot,
    position: [origin[0] + piece.pitch[0] * slot, origin[1] + piece.pitch[1] * slot, origin[2] + piece.pitch[2] * slot],
  };
}

export type PlaceOptions = {
  /**
   * `"row"`: each row is its own unit; items fill rows in arrival order (the n-th item's row is
   * `n / perRow`), hashed within the row. Books: a row fills before the next one starts.
   * `"piece"`: a whole piece is one unit; items hash across all its slots.
   */
  unit: "row" | "piece";
  /** The last placement (piece unit): items still listed keep their slots, so a removal moves nothing. */
  previous?: ReadonlyMap<string, Placement>;
};

/**
 * Places `ids` (oldest first) on `pieces` (in fill order). Items past the pieces' capacity are
 * counted in `overflow`, never drawn.
 */
export function placeItems(ids: readonly string[], pieces: readonly Furniture[], { unit, previous }: PlaceOptions): { placed: Placement[]; overflow: number } {
  // The units in fill order: every row of every piece, or every piece whole.
  const units = pieces.flatMap((piece) =>
    unit === "row" ? piece.rows.map((_, row) => ({ piece, rows: [row], capacity: piece.perRow })) : [{ piece, rows: piece.rows.map((_, row) => row), capacity: piece.rows.length * piece.perRow }],
  );
  const taken = units.map(() => new Set<number>());
  const unitIndex = new Map(units.map((entry, index) => [`${entry.piece.id}:${entry.rows[0]}`, index]));
  const placed = new Map<string, Placement>();
  const toUnitSlot = (index: number, local: number) => {
    const entry = units[index];
    const row = entry.rows[Math.floor(local / entry.piece.perRow)];
    return placement("", entry.piece, row, local % entry.piece.perRow);
  };

  if (unit === "row") {
    const total = Math.min(ids.length, units.reduce((sum, entry) => sum + entry.capacity, 0));
    let start = 0;
    for (let index = 0; index < units.length && start < total; index++) {
      const entry = units[index];
      const chunk = ids.slice(start, Math.min(total, start + entry.capacity));
      for (const id of chunk) {
        const local = slotFor(id, entry.capacity, taken[index]);
        taken[index].add(local);
        placed.set(id, { ...toUnitSlot(index, local), id });
      }
      start += chunk.length;
    }
    return { placed: ids.flatMap((id) => placed.get(id) ?? []), overflow: ids.length - placed.size };
  }

  // Piece unit: keep what was placed before (where its piece is still here), then fill the rest in order.
  if (previous) {
    for (const id of ids) {
      const before = previous.get(id);
      if (!before) continue;
      const index = unitIndex.get(`${before.furniture}:0`);
      if (index === undefined) continue;
      const entry = units[index];
      const local = entry.rows.indexOf(before.row) * entry.piece.perRow + before.slot;
      if (local < 0 || before.slot >= entry.piece.perRow || taken[index].has(local)) continue;
      taken[index].add(local);
      placed.set(id, { ...toUnitSlot(index, local), id });
    }
  }
  for (const id of ids) {
    if (placed.has(id)) continue;
    const index = units.findIndex((entry, at) => taken[at].size < entry.capacity);
    if (index < 0) continue;
    const local = slotFor(id, units[index].capacity, taken[index]);
    taken[index].add(local);
    placed.set(id, { ...toUnitSlot(index, local), id });
  }
  return { placed: ids.flatMap((id) => placed.get(id) ?? []), overflow: ids.length - placed.size };
}

const remembered = new Map<string, ReadonlyMap<string, Placement>>();

/**
 * `placeItems` with the piece unit, remembering the last placement under `key` for the page load, so
 * an item that leaves (a watch finishing, a project unpinned) leaves a gap rather than moving the rest.
 */
export function placeRemembered(key: string, ids: readonly string[], pieces: readonly Furniture[]): { placed: Placement[]; overflow: number } {
  const result = placeItems(ids, pieces, { unit: "piece", previous: remembered.get(key) });
  remembered.set(key, new Map(result.placed.map((place) => [place.id, place])));
  return result;
}
