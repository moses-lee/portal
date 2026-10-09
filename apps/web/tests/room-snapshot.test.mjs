import assert from "node:assert/strict";
import test from "node:test";
import { LAYOUT_VERSION } from "@portal/shared/room";
import { CAMERA_VERSION, framePose, layoutOffset, projectPoint, ROOM, WINDOW_CENTRE } from "../src/room/layout.ts";
import {
  captureSize,
  SNAPSHOT_ASPECT_TOLERANCE,
  SNAPSHOT_LONG_SIDE,
  SNAPSHOT_MAX_AGE_MS,
  snapshotEligibility,
  snapshotPlacement,
} from "../src/room/snapshot.ts";
import { sceneAt } from "../src/room/sun.ts";

const rect = (left, width, top = 0, height = 900) => ({ left, top, width, height });

/** 11:00 EDT in New York, where the record was taken. */
const AT = Date.UTC(2026, 9, 9, 15, 0, 0);
const newYork = { latitude: 40.71, longitude: -74.01 };
const berlin = { latitude: 52.52, longitude: 13.4 };
const record = { layoutVersion: LAYOUT_VERSION, cameraVersion: CAMERA_VERSION, at: AT, scene: "day", aspect: 1.6, ...newYork };
const now = { layoutVersion: LAYOUT_VERSION, cameraVersion: CAMERA_VERSION, at: AT + 60_000, aspect: 1.6 };

test("a snapshot is eligible from this layout version, under six hours old, in this scene, at an aspect within 5 %", () => {
  assert.equal(snapshotEligibility(record, now), "eligible");
  assert.equal(snapshotEligibility(record, { ...now, at: AT }), "eligible");
});

test("eligibility: the layout version and the camera version must be the current ones", () => {
  assert.equal(snapshotEligibility({ ...record, layoutVersion: LAYOUT_VERSION - 1 }, now), "layout");
  assert.equal(snapshotEligibility({ ...record, layoutVersion: LAYOUT_VERSION + 1 }, now), "layout");
  // A frame drawn under another camera rule (Revision 2's, before the aim) does not line up with the room.
  assert.equal(snapshotEligibility({ ...record, cameraVersion: CAMERA_VERSION - 1 }, now), "layout");
});

test("eligibility: six hours old is too old, a millisecond less is not, and a record from the future is not shown", () => {
  assert.equal(snapshotEligibility(record, { ...now, at: AT + SNAPSHOT_MAX_AGE_MS - 1 }), "eligible");
  assert.equal(snapshotEligibility(record, { ...now, at: AT + SNAPSHOT_MAX_AGE_MS }), "stale");
  assert.equal(snapshotEligibility(record, { ...now, at: AT - 1 }), "stale");
});

test("eligibility: a day snapshot is not shown at night, nor a night one by day", () => {
  // 23:00 EDT, five hours after sunset in New York.
  const night = Date.UTC(2026, 9, 10, 3, 0, 0);
  // Taken at 15:00 EDT, looked at 19:00 EDT, after sunset.
  assert.equal(snapshotEligibility({ ...record, at: Date.UTC(2026, 9, 9, 19, 0, 0) }, { ...now, at: Date.UTC(2026, 9, 9, 23, 0, 0) }), "scene");
  assert.equal(snapshotEligibility({ ...record, scene: "night" }, now), "scene");
  assert.equal(snapshotEligibility({ ...record, at: night - 60_000, scene: "night" }, { ...now, at: night }), "eligible");
});

test("eligibility: the scene now is worked out at the place the snapshot was taken, whatever the page guesses first", () => {
  // Sunset in New York on 2026-10-09 is about 18:26 EDT (22:26 UTC).
  const before = Date.UTC(2026, 9, 9, 22, 0, 0);
  const soon = Date.UTC(2026, 9, 9, 22, 10, 0);
  const after = Date.UTC(2026, 9, 9, 22, 40, 0);
  assert.equal(sceneAt(soon, newYork), "day");
  assert.equal(sceneAt(after, newYork), "night");
  // At the same instants it is night in Berlin: a check over another place's sun would refuse the first.
  assert.equal(sceneAt(soon, berlin), "night");
  const dusk = { ...record, at: before, scene: "day" };
  assert.equal(snapshotEligibility(dusk, { ...now, at: soon }), "eligible");
  assert.equal(snapshotEligibility(dusk, { ...now, at: after }), "scene");
  // Taken in Berlin at night, it stays eligible however New York's sun stands.
  assert.equal(snapshotEligibility({ ...dusk, scene: "night", ...berlin }, { ...now, at: soon }), "eligible");
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

test("placement: a frame stored at 1440 × 900 lands on the room at 1280 × 800, scaled with the height; no panel moves either", () => {
  const stored = view({ width: 1440, height: 900, covers: [] });
  const current = view({ width: 1280, height: 800, covers: [] });
  const box = snapshotPlacement(stored.view, current.view);
  assert.ok(Math.abs(box.width - 1280) < 1e-9 && Math.abs(box.height - 800) < 1e-9);
  // Both frames are drawn centred (the aim is in the pose, not the offset), so the scaled frame fills the viewport.
  assert.ok(Math.abs(box.x) < 1e-9, `x ${box.x}`);
  assert.ok(Math.abs(box.y) < 1e-9);
  for (const point of POINTS) {
    const at = placed(box, stored, point);
    const drawn = projectPoint(current.pose, point, current.size, current.offset);
    assert.ok(Math.abs(at.x - drawn.x) < 0.01 && Math.abs(at.y - drawn.y) < 0.01, `${point}: ${at.x},${at.y} against ${drawn.x},${drawn.y}`);
  }
});

test("placement: a phone frame stored on the Palace page lands on the room under the strip, window to the strip's centre", () => {
  const stored = view({ width: 390, height: 844, covers: [] });
  const strip = { width: 390, height: 844, covers: [{ kind: "focus", rect: rect(0, 390, 0, 72) }] };
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
