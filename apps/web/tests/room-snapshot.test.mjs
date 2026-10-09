import assert from "node:assert/strict";
import test from "node:test";
import { LAYOUT_VERSION } from "@portal/shared/room";
import { framePose, layoutOffset, projectPoint, ROOM, WINDOW_CENTRE } from "../src/room/layout.ts";
import {
  captureSize,
  SNAPSHOT_ASPECT_TOLERANCE,
  SNAPSHOT_LONG_SIDE,
  SNAPSHOT_MAX_AGE_MS,
  snapshotEligibility,
  snapshotPlacement,
} from "../src/room/snapshot.ts";

const rect = (left, width, top = 0, height = 900) => ({ left, top, width, height });

const AT = Date.UTC(2026, 9, 9, 15, 0, 0);
const record = { layoutVersion: LAYOUT_VERSION, at: AT, scene: "day", aspect: 1.6 };
const now = { layoutVersion: LAYOUT_VERSION, at: AT + 60_000, scene: "day", aspect: 1.6 };

test("a snapshot is eligible from this layout version, under six hours old, in this scene, at an aspect within 5 %", () => {
  assert.equal(snapshotEligibility(record, now), "eligible");
  assert.equal(snapshotEligibility(record, { ...now, at: AT }), "eligible");
});

test("eligibility: the layout version must be the current one", () => {
  assert.equal(snapshotEligibility({ ...record, layoutVersion: LAYOUT_VERSION - 1 }, now), "layout");
  assert.equal(snapshotEligibility({ ...record, layoutVersion: LAYOUT_VERSION + 1 }, now), "layout");
});

test("eligibility: six hours old is too old, a millisecond less is not, and a record from the future is not shown", () => {
  assert.equal(snapshotEligibility(record, { ...now, at: AT + SNAPSHOT_MAX_AGE_MS - 1 }), "eligible");
  assert.equal(snapshotEligibility(record, { ...now, at: AT + SNAPSHOT_MAX_AGE_MS }), "stale");
  assert.equal(snapshotEligibility(record, { ...now, at: AT - 1 }), "stale");
});

test("eligibility: a day snapshot is not shown at night, nor a night one by day", () => {
  assert.equal(snapshotEligibility(record, { ...now, scene: "night" }), "scene");
  assert.equal(snapshotEligibility({ ...record, scene: "night" }, now), "scene");
  assert.equal(snapshotEligibility({ ...record, scene: "night" }, { ...now, scene: "night" }), "eligible");
});

test("eligibility: the aspect within 5 % of the viewport's either way, at the edge included, and not past it", () => {
  const viewport = 1440 / 900;
  for (const sign of [1, -1]) {
    const edge = viewport * (1 + sign * SNAPSHOT_ASPECT_TOLERANCE);
    assert.equal(snapshotEligibility({ ...record, aspect: edge }, { ...now, aspect: viewport }), "eligible");
    const past = viewport * (1 + sign * (SNAPSHOT_ASPECT_TOLERANCE + 0.0005));
    assert.equal(snapshotEligibility({ ...record, aspect: past }, { ...now, aspect: viewport }), "aspect");
  }
  // A portrait snapshot on a landscape screen.
  assert.equal(snapshotEligibility({ ...record, aspect: 390 / 844 }, { ...now, aspect: viewport }), "aspect");
});

/** A layout's view offset as the canvas sets it, and its viewport, as a `SnapshotView`. */
function view(layout) {
  const pose = framePose(layout.width / layout.height);
  const offset = layoutOffset(layout, pose);
  return { pose, size: { width: layout.width, height: layout.height }, view: { width: layout.width, height: layout.height, offset: { x: offset.x, y: offset.y } }, offset };
}

/** Points across the room, so a placement that is off by a scale or a shift shows. */
const POINTS = [
  WINDOW_CENTRE,
  [ROOM.left, 0, ROOM.back],
  [3.9, 2.4, ROOM.back],
  [0.3, 0, 1.75],
  [-2.4, 0.96, -2.75],
  [2.3, 1.08, -2.55],
];

/** Where a room point drawn in the stored frame shows once the frame is placed: its stored pixel, scaled, then translated. */
function placed(box, stored, point) {
  const scale = box.width / stored.view.width;
  const q = projectPoint(stored.pose, point, stored.size, stored.offset);
  return { x: q.x * scale + box.x, y: q.y * scale + box.y };
}

test("placement: a frame stored at 1440 × 900 with the tracked panel lands on the room at 1280 × 800 with the sidebar", () => {
  const stored = view({ width: 1440, height: 900, covers: [{ kind: "right", rect: rect(1120, 320) }] });
  const current = view({ width: 1280, height: 800, covers: [{ kind: "left", rect: rect(0, 280, 0, 800) }] });
  const box = snapshotPlacement(stored.view, current.view);
  assert.ok(Math.abs(box.width - 1280) < 1e-9 && Math.abs(box.height - 800) < 1e-9);
  // The stored frame's centre was drawn 160 px left of the screen's centre, the current one 140 px right: 160 × 8/9 + 140.
  assert.ok(Math.abs(box.x - (160 * (800 / 900) + 140)) < 1e-9, `x ${box.x}`);
  assert.ok(Math.abs(box.y) < 1e-9);
  for (const point of POINTS) {
    const at = placed(box, stored, point);
    const drawn = projectPoint(current.pose, point, current.size, current.offset);
    assert.ok(Math.abs(at.x - drawn.x) < 0.01 && Math.abs(at.y - drawn.y) < 0.01, `${point}: ${at.x},${at.y} against ${drawn.x},${drawn.y}`);
  }
});

test("placement: a phone frame stored on the Palace page lands on the room under the strip, window to the strip's centre", () => {
  const stored = view({ width: 390, height: 844, covers: [] });
  const strip = { width: 390, height: 844, covers: [{ kind: "column", rect: rect(0, 390, 72, 772) }, { kind: "focus", rect: rect(0, 390, 0, 72) }] };
  const current = view(strip);
  const box = snapshotPlacement(stored.view, current.view);
  assert.equal(box.width, 390);
  assert.equal(box.height, 844);
  assert.ok(box.y < -100, `the frame moves up to put the window in the strip: ${box.y}`);
  const window = placed(box, stored, WINDOW_CENTRE);
  assert.ok(Math.abs(window.x - 195) < 0.01 && Math.abs(window.y - 36) < 0.01, `${window.x},${window.y}`);
  // And back: a frame stored under the strip shown on the Palace page.
  const back = snapshotPlacement(current.view, stored.view);
  for (const point of POINTS) {
    const at = placed(back, current, point);
    const drawn = projectPoint(stored.pose, point, stored.size, stored.offset);
    assert.ok(Math.abs(at.x - drawn.x) < 0.01 && Math.abs(at.y - drawn.y) < 0.01, `${point}`);
  }
});

test("placement: at an aspect a little off, the frame scales with the height and keeps the centres lined up", () => {
  // 1440 × 900 (1.6) shown at 1500 × 900 (1.667, 4 % wider): both past 1.59, so the same pose; the room is the same size and centred.
  const stored = view({ width: 1440, height: 900, covers: [] });
  const current = view({ width: 1500, height: 900, covers: [] });
  const box = snapshotPlacement(stored.view, current.view);
  assert.equal(box.width, 1440);
  assert.equal(box.height, 900);
  assert.ok(Math.abs(box.x - 30) < 1e-9 && Math.abs(box.y) < 1e-9, `${box.x},${box.y}`);
  for (const point of POINTS) {
    const at = placed(box, stored, point);
    const drawn = projectPoint(current.pose, point, current.size, current.offset);
    assert.ok(Math.abs(at.x - drawn.x) < 0.01 && Math.abs(at.y - drawn.y) < 0.01, `${point}`);
  }
  // In the blend (portrait to landscape) the pose differs a little within 5 %: the window lands within a few pixels.
  const tablet = view({ width: 820, height: 1180, covers: [] });
  const wider = view({ width: 860, height: 1180, covers: [] });
  const shifted = snapshotPlacement(tablet.view, wider.view);
  const at = placed(shifted, tablet, WINDOW_CENTRE);
  const drawn = projectPoint(wider.pose, WINDOW_CENTRE, wider.size, wider.offset);
  assert.ok(Math.hypot(at.x - drawn.x, at.y - drawn.y) < 12, `${Math.hypot(at.x - drawn.x, at.y - drawn.y)} px`);
});

test("the stored frame is at most 1600 px on its long side and never enlarged", () => {
  assert.deepEqual(captureSize(2160, 1350), { width: SNAPSHOT_LONG_SIDE, height: 1000 });
  assert.deepEqual(captureSize(585, 1266), { width: 585, height: 1266 });
  assert.deepEqual(captureSize(1266, 2400), { width: 844, height: 1600 });
  assert.deepEqual(captureSize(1440, 900), { width: 1440, height: 900 });
});
