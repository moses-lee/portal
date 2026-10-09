import assert from "node:assert/strict";
import test from "node:test";
import { LAYOUT_VERSION, MILESTONES, mulberry32 } from "@portal/shared/room";
import {
  BOOKS_PER_ROW,
  FURNITURE,
  SLOT_LAYOUT_VERSION,
  capacityOf,
  furnitureFor,
  placeItems,
  rowsOf,
} from "../src/room/layout-slots.ts";
import {
  NEUTRAL_SPINE,
  PURGED_SPINE,
  bookList,
  booksLabel,
  daysSince,
  describeGrowth,
  frameList,
  framesLabel,
  growthSummary,
  keysLabel,
  noteCount,
  notesLabel,
  plantList,
  plantsLabel,
  projectColour,
  season,
  shelfCount,
  treeScale,
  treeSpec,
  treeStage,
} from "../src/room/growth.ts";

const all = new Set(MILESTONES.map((milestone) => milestone.id));
const ids = (random, n) => Array.from({ length: n }, () => Math.floor(random() * 2 ** 32).toString(36) + Math.floor(random() * 2 ** 32).toString(36));
const key = (place) => `${place.furniture}:${place.row}:${place.slot}`;

test("the slot layout is the shared generator's version", () => {
  assert.equal(SLOT_LAYOUT_VERSION, LAYOUT_VERSION);
  // Every piece's milestone is one the shared table knows.
  for (const piece of FURNITURE) if (piece.milestone) assert.ok(all.has(piece.milestone), piece.id);
});

test("furniture: milestones add pieces and replace the ones they grow out of", () => {
  assert.deepEqual(furnitureFor("book", new Set()).map((piece) => piece.id), ["small-shelf"]);
  assert.deepEqual(furnitureFor("book", new Set(["tall-bookcase"])).map((piece) => piece.id), ["tall-bookcase"]);
  assert.deepEqual(furnitureFor("book", all).map((piece) => piece.id), ["tall-bookcase", "second-bookcase"]);
  assert.deepEqual(furnitureFor("note", new Set()).map((piece) => piece.id), ["corkboard"]);
  assert.deepEqual(furnitureFor("note", new Set(["wide-pinboard"])).map((piece) => piece.id), ["wide-pinboard"]);
  assert.deepEqual(furnitureFor("frame", new Set()).map((piece) => piece.id), ["frames", "gallery"]);
});

test("capacity and rows: a row of 24 on the small shelf, five more rows per bookcase", () => {
  assert.equal(capacityOf(furnitureFor("book", new Set())), 24);
  assert.equal(rowsOf(furnitureFor("book", new Set())), 1);
  assert.equal(capacityOf(furnitureFor("book", new Set(["tall-bookcase"]))), 120);
  assert.equal(rowsOf(furnitureFor("book", new Set(["tall-bookcase", "second-bookcase"]))), 10);
  assert.equal(capacityOf(furnitureFor("note", new Set())), 60);
  assert.equal(capacityOf(furnitureFor("note", new Set(["wide-pinboard"]))), 60);
  assert.equal(capacityOf(furnitureFor("plant", new Set())), 6 + 8);
  assert.equal(capacityOf(furnitureFor("frame", new Set())), 6 + 8);
  assert.equal(capacityOf(furnitureFor("key", new Set())), 8);
});

test("books fill a row of 24 before the next row starts, and past the shelves' room they overflow", () => {
  const random = mulberry32(7);
  const shelves = furnitureFor("book", new Set(["tall-bookcase"]));
  const thirty = placeItems(ids(random, 30), shelves, { unit: "row" });
  assert.equal(thirty.overflow, 0);
  const rows = new Map();
  for (const place of thirty.placed) rows.set(place.row, (rows.get(place.row) ?? 0) + 1);
  assert.deepEqual([...rows.entries()].sort(), [
    [0, 24],
    [1, 6],
  ]);
  // Slots within a row are distinct and in range.
  assert.equal(new Set(thirty.placed.map(key)).size, 30);
  for (const place of thirty.placed) assert.ok(place.slot >= 0 && place.slot < BOOKS_PER_ROW);
  // The small shelf alone holds 24; the rest overflow (the card buckets them).
  const small = placeItems(ids(random, 30), furnitureFor("book", new Set()), { unit: "row" });
  assert.equal(small.placed.length, 24);
  assert.equal(small.overflow, 6);
  // Positions follow the row's origin and pitch.
  const [first] = small.placed;
  const piece = FURNITURE.find((each) => each.id === first.furniture);
  assert.deepEqual(first.position, [piece.rows[0][0], piece.rows[0][1], piece.rows[0][2] + piece.pitch[2] * first.slot]);
});

test("stability over 200 seeds: adding an item never moves another, by row or by piece", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = mulberry32(seed);
    const n = 1 + Math.floor(random() * 70);
    const list = ids(random, n + 1);
    for (const [unit, pieces] of [
      ["row", furnitureFor("book", new Set(["tall-bookcase"]))],
      ["piece", furnitureFor("note", new Set())],
      ["piece", furnitureFor("frame", new Set())],
    ]) {
      const before = new Map(placeItems(list.slice(0, n), pieces, { unit }).placed.map((place) => [place.id, key(place)]));
      const after = new Map(placeItems(list, pieces, { unit }).placed.map((place) => [place.id, key(place)]));
      for (const [id, slot] of before) assert.equal(after.get(id), slot, `seed ${seed}, ${unit}: ${id} moved`);
    }
  }
});

test("stability over 200 seeds: with the last placement, removing an item never moves another", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = mulberry32(seed * 31);
    const pieces = furnitureFor("frame", new Set());
    const list = ids(random, 1 + Math.floor(random() * 14));
    const first = placeItems(list, pieces, { unit: "piece" });
    const previous = new Map(first.placed.map((place) => [place.id, place]));
    const gone = list[Math.floor(random() * list.length)];
    const rest = list.filter((id) => id !== gone);
    const second = placeItems(rest, pieces, { unit: "piece", previous });
    for (const place of second.placed) assert.equal(key(place), key(previous.get(place.id)), `seed ${seed}: ${place.id} moved`);
    // A newcomer takes a free slot and moves nobody either.
    const newcomer = ids(random, 1)[0];
    const third = placeItems([...rest, newcomer], pieces, { unit: "piece", previous: new Map(second.placed.map((place) => [place.id, place])) });
    for (const place of third.placed) if (place.id !== newcomer) assert.equal(key(place), key(previous.get(place.id)));
    assert.equal(new Set(third.placed.map(key)).size, third.placed.length);
  }
});

test("a placement snapshot: at this layout version these ids land in these slots (a change here is a version bump)", () => {
  const slots = (list, pieces, unit) => placeItems(list, pieces, { unit }).placed.map(({ id, furniture, row, slot }) => `${id} ${furniture} ${row}:${slot}`);
  assert.equal(LAYOUT_VERSION, 1);
  assert.deepEqual(slots(["s1", "s2", "s3"], furnitureFor("book", new Set()), "row"), ["s1 small-shelf 0:15", "s2 small-shelf 0:0", "s3 small-shelf 0:7"]);
  assert.deepEqual(slots(["p1", "p2", "p3", "p4", "p5", "p6", "p7"], furnitureFor("frame", new Set()), "piece"), [
    "p1 frames 1:0",
    "p2 frames 1:1",
    "p3 frames 0:0",
    "p4 frames 1:2",
    "p5 frames 0:1",
    "p6 frames 0:2",
    "p7 gallery 0:0",
  ]);
});

test("books: purged ones first and neutral, listed ones oldest first, spines by project", () => {
  const sessions = [
    { id: "b", title: "Second", projectId: "p1", createdAt: 2 },
    { id: "a", title: null, projectId: "gone", createdAt: 1 },
  ];
  const books = bookList(sessions, [{ id: "p1", name: "portal" }], 4);
  assert.deepEqual(
    books.map((book) => [book.id, book.purged, book.colour]),
    [
      ["purged:0", true, PURGED_SPINE],
      ["purged:1", true, PURGED_SPINE],
      ["a", false, NEUTRAL_SPINE],
      ["b", false, projectColour("p1")],
    ],
  );
  assert.equal(books[2].title, "New conversation");
  assert.equal(books[3].project, "portal");
  // Height and thickness from the id, in range, and stable.
  for (const book of books) {
    assert.ok(book.height >= 0.2 && book.height <= 0.29);
    assert.ok(book.thickness >= 0.034 && book.thickness <= 0.052);
  }
  assert.deepEqual(bookList(sessions, [], 2)[1].height, bookList(sessions, [], 2)[1].height);
  // A census behind the list never takes listed books away.
  assert.equal(bookList(sessions, [], 1).length, 2);
});

test("bucket labels for the cards", () => {
  const none = new Set();
  const tall = new Set(["tall-bookcase"]);
  assert.equal(booksLabel(shelfCount(0, 0, none)), "No books yet: one arrives with each session");
  assert.equal(booksLabel(shelfCount(1, 0, none)), "1 book on 1 shelf row");
  assert.equal(booksLabel(shelfCount(30, 0, tall)), "30 books on 2 shelf rows");
  assert.equal(booksLabel(shelfCount(30, 0, none)), "30 books: 24 on 1 shelf row, 6 more in boxes");
  assert.deepEqual(shelfCount(130, 4, tall), { total: 130, drawn: 120, rows: 5, boxed: 10, purged: 4 });

  assert.deepEqual(notesLabel(noteCount(1, 0)), ["1 memory record pinned", "The inbox is empty"]);
  assert.deepEqual(notesLabel(noteCount(75, 11)), ["60 notes pinned, 15 more layered underneath", "11 items wait in the inbox, loose on the desk"]);
  assert.deepEqual(noteCount(75, 11), { pinned: 60, layered: 15, loose: 8, looseExtra: 3 });

  assert.deepEqual(plantsLabel(2, 1), ["2 active watches on the sill", "1 finished watch on the stand"]);
  assert.deepEqual(plantsLabel(9, 12), ["9 active watches: 6 on the sill, 3 more in the greenhouse", "12 finished: 8 on the stand, 4 more in the greenhouse"]);

  assert.equal(framesLabel(0), "No pinned projects");
  assert.equal(framesLabel(3), "3 pinned projects");
  assert.equal(framesLabel(9), "9 pinned projects: 6 framed, 3 in the gallery row");
  assert.equal(framesLabel(20), "20 pinned projects: 6 framed, 8 in the gallery row, 6 more in the drawer");

  assert.equal(keysLabel(0), "No standing grants");
  assert.equal(keysLabel(1), "1 standing grant");
  assert.equal(keysLabel(11), "11 standing grants: 8 keys on the rack, 3 more on the ring");
});

test("the tree's stage and size follow the days since the first session", () => {
  assert.equal(treeStage(0), "sapling");
  assert.equal(treeStage(29), "sapling");
  assert.equal(treeStage(30), "young");
  assert.equal(treeStage(179), "young");
  assert.equal(treeStage(180), "full");
  assert.equal(treeStage(729), "full");
  assert.equal(treeStage(730), "big");
  // Size grows monotonically, full grown at 365, big at 730 and on.
  let last = 0;
  for (let days = 0; days <= 900; days += 5) {
    const scale = treeScale(days);
    assert.ok(scale >= last, `day ${days}`);
    last = scale;
  }
  assert.equal(treeScale(365), 1);
  assert.equal(treeScale(730), 1.3);
  assert.equal(treeScale(2000), 1.3);
  assert.equal(daysSince(null, Date.now()), 0);
  assert.equal(daysSince(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 31)), 30);
});

test("the season follows the month in the room's hemisphere", () => {
  assert.equal(season(40, 0), "winter");
  assert.equal(season(40, 3), "spring");
  assert.equal(season(40, 6), "summer");
  assert.equal(season(40, 9), "autumn");
  assert.equal(season(40, 11), "winter");
  // Six months on south of the equator.
  assert.equal(season(-33, 0), "summer");
  assert.equal(season(-33, 3), "autumn");
  assert.equal(season(-33, 6), "winter");
  assert.equal(season(-33, 9), "spring");
  const tree = treeSpec(Date.UTC(2025, 9, 1), Date.UTC(2026, 9, 9, 12), 40.7);
  assert.deepEqual({ stage: tree.stage, season: tree.season }, { stage: "full", season: "autumn" });
  assert.equal(treeSpec(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 9, 12), -33.9).season, "spring");
});

test("cards for the accumulated objects, and the summary tests read", () => {
  const census = { sessionsEver: 3, memoryActive: 4, memoryInbox: 1, watches: { active: 1, finished: 2, fires: 3, ever: 3 }, grants: 2, activityLastHour: 0, since: Date.UTC(2026, 9, 1) };
  const books = bookList([{ id: "s1", title: "Fix the build", projectId: "p1", createdAt: Date.UTC(2026, 9, 2) }], [{ id: "p1", name: "portal", pinnedAt: 5 }], 3);
  const plants = plantList([{ id: "w1", text: "Watch PR 42", fires: 7, createdAt: 1 }]);
  const frames = frameList([
    { id: "p2", name: "later", pinnedAt: 9 },
    { id: "p1", name: "portal", pinnedAt: 5 },
    { id: "p3", name: "unpinned", pinnedAt: null },
  ]);
  assert.deepEqual(frames.map((frame) => frame.id), ["p1", "p2"]);
  assert.equal(plants[0].blooms, 5);
  const milestones = [{ id: "tall-bookcase", at: 1, summary: "" }];
  const scene = {
    milestones,
    books,
    notes: noteCount(4, 1),
    plants: { sill: plants, stand: 2 },
    frames,
    keys: 2,
    tree: treeSpec(census.since, Date.UTC(2026, 9, 9), 40),
  };
  const data = { scene, census, shelves: shelfCount(books.length, 2, new Set(["tall-bookcase"])), books, plants, frames, approvals: 0 };
  const book = describeGrowth({ kind: "book", id: "s1" }, data);
  assert.equal(book.title, "Fix the build");
  assert.ok(book.lines.includes("In portal"));
  assert.equal(book.hint, "Click to open the session");
  const purged = describeGrowth({ kind: "book", id: "purged:0" }, data);
  assert.equal(purged.hint, null);
  assert.ok(purged.lines.includes("The session is gone; its book stays"));
  assert.equal(describeGrowth({ kind: "plant", id: "w1" }, data).lines[0], "7 fires (five blooms)");
  assert.equal(describeGrowth({ kind: "notes", id: "board" }, data).hint, "Click to open Memory");
  assert.equal(describeGrowth({ kind: "frame", id: "p1" }, data).hint, "Click to open the project");
  assert.equal(describeGrowth({ kind: "key", id: "rack" }, data).hint, "Click to open the grants in System");
  assert.equal(describeGrowth({ kind: "key", id: "rack" }, { ...data, approvals: 1 }).hint, "Click to open the approvals");
  assert.equal(describeGrowth({ kind: "tree", id: "tree" }, data).hint, null);
  assert.equal(describeGrowth({ kind: "book", id: "nope" }, data), null);
  assert.deepEqual(growthSummary(data), {
    layout: LAYOUT_VERSION,
    furniture: ["tall-bookcase"],
    books: { total: 3, drawn: 3, rows: 1, boxed: 0, purged: 2 },
    notes: { pinned: 4, layered: 0, loose: 1, looseExtra: 0 },
    plants: { sill: 1, stand: 2, blooms: 5 },
    frames: { framed: 2, gallery: 0 },
    keys: 2,
    tree: { stage: "sapling", season: "autumn" },
  });
});
