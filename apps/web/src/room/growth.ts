/**
 * The room's accumulated objects (docs/PALACE.md, Objects): what stands for something that happened
 * and stays. Books for sessions, notes for memory, plants for watches, frames for pinned projects,
 * keys for standing grants, and the tree outside for how long Portal has been yours; each from the
 * census and the lists the page already holds, capped and then bucketed, its look from a hash of its
 * id. The scene's components draw from these; `RoomBackground` writes their summary into `data-room`
 * and the hover cards come from `describeGrowth`. No React, no DOM, no three.js.
 */
import type { RoomCensus, RoomMilestone } from "@portal/contracts/room";
import { bucket, hashId, LAYOUT_VERSION, mulberry32 } from "@portal/shared/room";
import { BOOKS_PER_ROW, capacityOf, furnitureFor } from "./layout-slots.ts";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A reached milestone set from the state's list. */
export function reachedSet(milestones: readonly RoomMilestone[] | null | undefined): Set<string> {
  return new Set((milestones ?? []).map((milestone) => milestone.id));
}

// ---------------------------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------------------------

/** What a book reads from a session's list entry. */
export type BookSession = { id: string; title: string | null; projectId: string; createdAt: number };
export type BookProject = { id: string; name: string };

export type BookSpec = {
  /** The session id, or `purged:<n>` for a session that no longer exists. */
  id: string;
  title: string;
  /** The project's name; null when the project is gone (and for purged books). */
  project: string | null;
  createdAt: number | null;
  purged: boolean;
  /** Spine colour, height and thickness (metres). */
  colour: string;
  height: number;
  thickness: number;
};

const SPINES = ["#b8483e", "#3f6fb0", "#d08a2c", "#5d8a4a", "#8a5aa8", "#2f8f8a", "#b85c7a", "#c4a03a", "#4a6b8a", "#9c5b33"] as const;
/** A book whose project is gone: a plain cloth spine. */
export const NEUTRAL_SPINE = "#b6ab9a";
/** A purged session's book: neutral and a little greyer. */
export const PURGED_SPINE = "#9d968b";

/** A project's spine colour, from its id's hash. */
export function projectColour(projectId: string): string {
  return SPINES[hashId(projectId, 5) % SPINES.length];
}

/** A book's size from its id: 0.2–0.29 m tall, 0.034–0.052 m thick. */
export function bookSize(id: string): { height: number; thickness: number } {
  const random = mulberry32(hashId(id, 29));
  return { height: 0.2 + random() * 0.09, thickness: 0.034 + random() * 0.018 };
}

/**
 * One book per session ever (`sessionsEver`): neutral purged books first (the sessions gone from
 * the list, which are the old ones), then the listed sessions oldest first, so a new session's book
 * goes after every other and moves none of them.
 */
export function bookList(sessions: readonly BookSession[], projects: readonly BookProject[], sessionsEver: number): BookSpec[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const purged = Math.max(0, Math.floor(sessionsEver) - sessions.length);
  const books: BookSpec[] = [];
  for (let index = 0; index < purged; index++) {
    const id = `purged:${index}`;
    books.push({ id, title: "A purged session", project: null, createdAt: null, purged: true, colour: PURGED_SPINE, ...bookSize(id) });
  }
  const listed = [...sessions].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const session of listed) {
    const project = names.get(session.projectId) ?? null;
    books.push({
      id: session.id,
      title: session.title || "New conversation",
      project,
      createdAt: session.createdAt,
      purged: false,
      colour: project === null ? NEUTRAL_SPINE : projectColour(session.projectId),
      ...bookSize(session.id),
    });
  }
  return books;
}

/** How many books the shelves hold with these milestones reached: one row on the small shelf, five per bookcase. */
export function shelfCapacity(reached: ReadonlySet<string>): number {
  return capacityOf(furnitureFor("book", reached));
}

export type ShelfCount = { total: number; drawn: number; rows: number; boxed: number; purged: number };

/** The shelves' numbers: books drawn (up to the shelves' room), the rows they fill, and the rest in boxes. */
export function shelfCount(total: number, purged: number, reached: ReadonlySet<string>): ShelfCount {
  const { shown, extra } = bucket(total, shelfCapacity(reached));
  return { total: Math.max(0, Math.floor(total)), drawn: shown, rows: Math.ceil(shown / BOOKS_PER_ROW), boxed: extra, purged: Math.max(0, Math.floor(purged)) };
}

/** "30 books on 2 shelf rows", and the boxes past the shelves' room. */
export function booksLabel(shelves: ShelfCount): string {
  if (shelves.total === 0) return "No books yet: one arrives with each session";
  const rows = count(shelves.rows, "shelf row", "shelf rows");
  if (shelves.boxed > 0) return `${count(shelves.total, "book", "books")}: ${shelves.drawn} on ${rows}, ${shelves.boxed} more in boxes`;
  return `${count(shelves.total, "book", "books")} on ${rows}`;
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

/** Notes pinned to the board before the rest layer over them. */
export const NOTE_CAP = 60;
/** Inbox notes drawn loose on the desk. */
export const LOOSE_CAP = 8;

export type NoteCount = { pinned: number; layered: number; loose: number; looseExtra: number };

/** One note per active memory record, sixty on the board and the rest layered; unreviewed inbox items loose on the desk. */
export function noteCount(memoryActive: number, memoryInbox: number): NoteCount {
  const board = bucket(memoryActive, NOTE_CAP);
  const desk = bucket(memoryInbox, LOOSE_CAP);
  return { pinned: board.shown, layered: board.extra, loose: desk.shown, looseExtra: desk.extra };
}

/** The board's and the desk's lines. */
export function notesLabel(notes: NoteCount): string[] {
  const board =
    notes.layered > 0
      ? `${notes.pinned} notes pinned, ${notes.layered} more layered underneath`
      : count(notes.pinned, "memory record pinned", "memory records pinned");
  const inbox = notes.loose + notes.looseExtra;
  return [board, inbox === 0 ? "The inbox is empty" : `${count(inbox, "item waits", "items wait")} in the inbox, loose on the desk`];
}

// ---------------------------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------------------------

/** Plants on the sill (active watches) and on the stand (finished ones) before the rest are counted. */
export const SILL_CAP = 6;
export const STAND_CAP = 8;
/** Blooms a plant carries at most, one per fire. */
export const BLOOM_CAP = 5;
export const SPECIES = 4;

export type PlantSpec = { id: string; title: string; species: number; blooms: number; fires: number; pot: string; bloom: string };

const POTS = ["#c0694a", "#d8c6a5", "#6f8fa6", "#b0805a", "#e2d7c3"] as const;
const BLOOMS = ["#f2a7b8", "#f6d36b", "#f08c5a", "#c9a3e6", "#ffffff"] as const;

/** A plant's looks from its id: species, pot and bloom colours. */
export function plantLook(id: string): { species: number; pot: string; bloom: string } {
  const random = mulberry32(hashId(id, 41));
  return {
    species: Math.floor(random() * SPECIES) % SPECIES,
    pot: POTS[Math.floor(random() * POTS.length) % POTS.length],
    bloom: BLOOMS[Math.floor(random() * BLOOMS.length) % BLOOMS.length],
  };
}

/** What a plant reads from an active watch. */
export type PlantWatch = { id: string; text: string; fires: number; createdAt: number };

/** One plant per active watch, oldest first; one bloom per fire up to five. */
export function plantList(watches: readonly PlantWatch[]): PlantSpec[] {
  return [...watches]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((watch) => ({ id: watch.id, title: watch.text, fires: watch.fires, blooms: Math.min(BLOOM_CAP, Math.max(0, Math.floor(watch.fires))), ...plantLook(watch.id) }));
}

/** A finished watch's plant on the stand (`finished:<n>`): its looks from its place. */
export function standPlant(index: number): PlantSpec {
  const id = `finished:${index}`;
  return { id, title: "A finished watch", fires: 0, blooms: 0, ...plantLook(id) };
}

/** The sill's and the stand's lines. */
export function plantsLabel(active: number, finished: number): string[] {
  const sill = bucket(active, SILL_CAP);
  const stand = bucket(finished, STAND_CAP);
  return [
    sill.extra > 0 ? `${active} active watches: ${sill.shown} on the sill, ${sill.extra} more in the greenhouse` : count(active, "active watch on the sill", "active watches on the sill"),
    stand.extra > 0 ? `${finished} finished: ${stand.shown} on the stand, ${stand.extra} more in the greenhouse` : count(finished, "finished watch on the stand", "finished watches on the stand"),
  ];
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

/** Frames beside the window, then small ones in the gallery row above it. */
export const FRAME_CAP = 6;
export const GALLERY_CAP = 8;

export type FrameSpec = { id: string; name: string; style: 0 | 1 | 2; frame: string; picture: string; hill: string };

const FRAME_WOODS = ["#8e5d3d", "#d9b45a", "#2f2c2a", "#efe6d6", "#6f4a35"] as const;
const PICTURES = ["#9cc5d6", "#f0d9a8", "#c8dcb0", "#e9b6a0", "#c3b2de", "#f4e3c1"] as const;
const HILLS = ["#5d8a4a", "#3f6fb0", "#c8763e", "#7a6aa8", "#2f8f8a"] as const;

/** A frame's style and colours from its project's id. */
export function frameLook(projectId: string): Omit<FrameSpec, "id" | "name"> {
  const random = mulberry32(hashId(projectId, 53));
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length) % list.length];
  return { style: (Math.floor(random() * 3) % 3) as 0 | 1 | 2, frame: pick(FRAME_WOODS), picture: pick(PICTURES), hill: pick(HILLS) };
}

/** What a frame reads from a project. */
export type FrameProject = { id: string; name: string; pinnedAt: number | null };

/** One frame per pinned project, in the order they were pinned (a new pin goes last and moves none). */
export function frameList(projects: readonly FrameProject[]): FrameSpec[] {
  return projects
    .filter((project) => project.pinnedAt !== null)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((project) => ({ id: project.id, name: project.name, ...frameLook(project.id) }));
}

export function framesLabel(pinned: number): string {
  const main = bucket(pinned, FRAME_CAP);
  const gallery = bucket(main.extra, GALLERY_CAP);
  if (pinned === 0) return "No pinned projects";
  if (gallery.extra > 0) return `${pinned} pinned projects: ${FRAME_CAP} framed, ${GALLERY_CAP} in the gallery row, ${gallery.extra} more in the drawer`;
  if (main.extra > 0) return `${pinned} pinned projects: ${FRAME_CAP} framed, ${main.extra} in the gallery row`;
  return count(pinned, "pinned project", "pinned projects");
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

export const KEY_CAP = 8;

export function keysLabel(grants: number): string {
  const { shown, extra } = bucket(grants, KEY_CAP);
  if (extra > 0) return `${grants} standing grants: ${shown} keys on the rack, ${extra} more on the ring`;
  return grants === 0 ? "No standing grants" : count(grants, "standing grant", "standing grants");
}

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

export type TreeStage = "sapling" | "young" | "full" | "big";
export type Season = "spring" | "summer" | "autumn" | "winter";

const DAY_MS = 86_400_000;

/** Whole days since the first session; 0 before one. */
export function daysSince(since: number | null, now: number): number {
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY_MS));
}

/** Sapling to 30 days, young to 180, then full (fully grown at 365), big past 730. */
export function treeStage(days: number): TreeStage {
  if (days < 30) return "sapling";
  if (days < 180) return "young";
  if (days < 730) return "full";
  return "big";
}

/** The tree's size (1 is full grown): growing through each stage, full at 365 days, big at 730. */
export function treeScale(days: number): number {
  const stops: [number, number][] = [
    [0, 0.3],
    [30, 0.42],
    [180, 0.68],
    [365, 1],
    [730, 1.3],
  ];
  if (days >= 730) return 1.3;
  for (let index = 1; index < stops.length; index++) {
    const [d1, s1] = stops[index];
    const [d0, s0] = stops[index - 1];
    if (days < d1) return s0 + ((s1 - s0) * (Math.max(0, days) - d0)) / (d1 - d0);
  }
  return 1;
}

/** The season for a month (0 January) at a latitude: the southern hemisphere's is six months on. */
export function season(latitude: number, month: number): Season {
  const shifted = latitude < 0 ? (month + 6) % 12 : month;
  if (shifted >= 2 && shifted <= 4) return "spring";
  if (shifted >= 5 && shifted <= 7) return "summer";
  if (shifted >= 8 && shifted <= 10) return "autumn";
  return "winter";
}

/** Leaf colours for a season; winter is bare (no canopy). */
export const LEAVES: Record<Season, { canopy: string; accent: string } | null> = {
  spring: { canopy: "#8cc46a", accent: "#f4b6c8" },
  summer: { canopy: "#4f8f3e", accent: "#3f7a33" },
  autumn: { canopy: "#d9822b", accent: "#b8442e" },
  winter: null,
};

export type TreeSpec = { stage: TreeStage; season: Season; scale: number; days: number };

export function treeSpec(since: number | null, now: number, latitude: number): TreeSpec {
  const days = daysSince(since, now);
  return { stage: treeStage(days), season: season(latitude, new Date(now).getMonth()), scale: treeScale(days), days };
}

const STAGE_NAMES: Record<TreeStage, string> = { sapling: "A sapling", young: "A young tree", full: "A full-grown tree", big: "A big old tree" };
const SEASON_LINES: Record<Season, string> = {
  spring: "Spring: fresh leaves and blossom",
  summer: "Summer: deep green",
  autumn: "Autumn: the leaves are turning",
  winter: "Winter: bare branches",
};

export function treeLabel(tree: TreeSpec): string[] {
  return [`${STAGE_NAMES[tree.stage]}: ${count(tree.days, "day", "days")} since the first session`, SEASON_LINES[tree.season]];
}

// ---------------------------------------------------------------------------------------------
// The scene, the cards, the summary
// ---------------------------------------------------------------------------------------------

/** What the canvas draws of the accumulated objects; JSON-equal values keep the memoised canvas still. */
export type GrowthScene = {
  /** The milestones reached; null until the room's state is known. */
  milestones: RoomMilestone[] | null;
  /** Books in shelf order, at most the shelves' room. */
  books: BookSpec[];
  notes: NoteCount;
  /** Active watches' plants, oldest first, at most six; the stand's finished ones by count. */
  plants: { sill: PlantSpec[]; stand: number };
  /** Pinned projects' frames, in pin order, at most fourteen (six framed, eight in the gallery). */
  frames: FrameSpec[];
  keys: number;
  tree: TreeSpec;
};

/** What the cards read: the scene plus the whole counts behind it. */
export type GrowthData = {
  scene: GrowthScene;
  census: RoomCensus;
  shelves: ShelfCount;
  /** Every book, not only those drawn (a card for any of them). */
  books: readonly BookSpec[];
  /** Active watches (all, for the cards and counts). */
  plants: readonly PlantSpec[];
  /** Pinned projects (all). */
  frames: readonly FrameSpec[];
  /** Pending approvals: the key rack's click opens them when there are any. */
  approvals: number;
};

export type GrowthKind = "book" | "notes" | "plant" | "frame" | "key" | "tree";
export const GROWTH_KINDS: readonly GrowthKind[] = ["book", "notes", "plant", "frame", "key", "tree"];

export function isGrowthKind(kind: string): kind is GrowthKind {
  return (GROWTH_KINDS as readonly string[]).includes(kind);
}

export type GrowthCard = { title: string; about: string; lines: string[]; hint: string | null; action: string | null; credit: boolean };

const dateOf = (at: number) => new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The hover card for an accumulated object; null when it is gone. */
export function describeGrowth(target: { kind: GrowthKind; id: string }, data: GrowthData): GrowthCard | null {
  const card = (title: string, about: string, lines: string[], where: string | null): GrowthCard => ({
    title,
    about,
    lines,
    hint: where ? `Click to open ${where}` : null,
    action: where ? `Open ${where}` : null,
    credit: false,
  });
  switch (target.kind) {
    case "book": {
      const book = data.books.find((each) => each.id === target.id);
      if (!book) return null;
      if (book.purged) return card("A purged session", "A session's book", ["The session is gone; its book stays", booksLabel(data.shelves)], null);
      return card(
        book.title,
        "A session's book",
        [book.project ? `In ${book.project}` : "Its project is gone (a plain spine)", ...(book.createdAt === null ? [] : [`Started ${dateOf(book.createdAt)}`]), booksLabel(data.shelves)],
        "the session",
      );
    }
    case "notes":
      return card(
        furnitureFor("note", reachedSet(data.scene.milestones))[0]?.id === "wide-pinboard" ? "Pinboard" : "Corkboard",
        "Memory: a note per record, the inbox loose on the desk",
        notesLabel(data.scene.notes),
        "Memory",
      );
    case "plant": {
      const plant = data.plants.find((each) => each.id === target.id);
      const { active, finished } = data.census.watches;
      if (plant) {
        return card(plant.title, "A watch's plant", [plant.fires === 0 ? "Not fired yet" : `${count(plant.fires, "fire", "fires")}${plant.fires > BLOOM_CAP ? " (five blooms)" : ""}`, ...plantsLabel(active, finished)], "Watches");
      }
      if (target.id.startsWith("finished:")) return card("A finished watch", "Its plant moved to the stand", plantsLabel(active, finished), "Watches");
      return null;
    }
    case "frame": {
      const frame = data.frames.find((each) => each.id === target.id);
      if (!frame) return null;
      return card(frame.name, "A pinned project", [framesLabel(data.frames.length)], "the project");
    }
    case "key": {
      const lines = [keysLabel(data.census.grants)];
      if (data.approvals > 0) lines.push(count(data.approvals, "approval waits", "approvals wait"));
      return card("Key rack", "Standing approval grants: one key each", lines, data.approvals > 0 ? "the approvals" : "the grants in System");
    }
    case "tree":
      return card("The tree outside", "How long Portal has been yours", treeLabel(data.scene.tree), null);
  }
}

/** The `data-room` summary of the accumulated objects and the milestones' furniture, for tests. */
export function growthSummary(data: GrowthData) {
  const scene = data.scene;
  return {
    layout: LAYOUT_VERSION,
    furniture: (scene.milestones ?? []).map((milestone) => milestone.id),
    books: data.shelves,
    notes: scene.notes,
    plants: { sill: scene.plants.sill.length, stand: scene.plants.stand, blooms: scene.plants.sill.reduce((sum, plant) => sum + plant.blooms, 0) },
    frames: { framed: Math.min(data.frames.length, FRAME_CAP), gallery: Math.min(Math.max(0, data.frames.length - FRAME_CAP), GALLERY_CAP) },
    keys: Math.min(data.census.grants, KEY_CAP),
    tree: { stage: scene.tree.stage, season: scene.tree.season },
  };
}
