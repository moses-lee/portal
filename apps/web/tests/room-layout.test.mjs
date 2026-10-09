import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_MARGIN,
  PORTRAIT_ASPECT,
  cameraPose,
  cameraPosition,
  driftYaw,
  interestPoint,
  parallax,
  viewOffset,
} from "../src/room/layout.ts";
import { looksLowPower, targetFps, CADENCE_SAMPLES } from "../src/room/loop.ts";

const DEGREE = Math.PI / 180;
const rect = (left, width, top = 0, height = 900) => ({ left, top, width, height });

test("with nothing covering it the room centres in the viewport", () => {
  assert.deepEqual(interestPoint({ width: 1440, height: 900, covers: [] }), { x: 720, y: 450 });
});

test("the sidebar and the right-hand panels move the centre into the open region", () => {
  const sidebar = { kind: "left", rect: rect(0, 280) };
  const inspector = { kind: "right", rect: rect(1100, 340) };
  assert.deepEqual(interestPoint({ width: 1440, height: 900, covers: [sidebar] }), { x: 860, y: 450 });
  assert.deepEqual(interestPoint({ width: 1440, height: 900, covers: [sidebar, inspector] }), { x: 690, y: 450 });
  // Hidden parts (zero size) cover nothing.
  assert.deepEqual(interestPoint({ width: 1440, height: 900, covers: [{ kind: "left", rect: rect(0, 0) }] }), { x: 720, y: 450 });
});

test("beside a reading column the room aims for the wider margin when it is wide enough", () => {
  const sidebar = { kind: "left", rect: rect(0, 280) };
  // 1920 wide: the open region is 280..1920, the column 680..1520 leaves 400 left and 400 right; a tie goes left.
  const centred = { kind: "column", rect: rect(680, 840) };
  assert.deepEqual(interestPoint({ width: 1920, height: 1080, covers: [sidebar, centred] }), { x: 480, y: 540 });
  const offRight = { kind: "column", rect: rect(900, 840) };
  assert.deepEqual(interestPoint({ width: 1920, height: 1080, covers: [sidebar, offRight] }), { x: 590, y: 540 });
  // Margins narrower than MIN_MARGIN are not worth it: the open region's centre.
  const narrow = { kind: "column", rect: rect(280 + MIN_MARGIN - 10, 840) };
  assert.equal(interestPoint({ width: 1440, height: 900, covers: [sidebar, narrow] }).x, 860);
});

test("a focus region (the phone strip) wins over everything else", () => {
  const strip = { kind: "focus", rect: rect(0, 390, 0, 72) };
  assert.deepEqual(interestPoint({ width: 390, height: 844, covers: [{ kind: "column", rect: rect(0, 390) }, strip] }), { x: 195, y: 36 });
});

test("covers that leave no room are ignored", () => {
  const covers = [{ kind: "left", rect: rect(0, 900) }, { kind: "right", rect: rect(500, 940) }];
  assert.equal(interestPoint({ width: 1440, height: 900, covers }).x, 720);
});

test("the view offset shifts the full frame so its centre lands on the point", () => {
  assert.deepEqual(viewOffset(1440, 900, { x: 720, y: 450 }), { fullWidth: 1440, fullHeight: 900, x: 0, y: 0, width: 1440, height: 900 });
  assert.deepEqual(viewOffset(1440, 900, { x: 860, y: 450 }), { fullWidth: 1440, fullHeight: 900, x: -140, y: 0, width: 1440, height: 900 });
  assert.deepEqual(viewOffset(390, 844, { x: 195, y: 36 }), { fullWidth: 390, fullHeight: 844, x: 0, y: 386, width: 390, height: 844 });
});

test("the camera is a three-quarter view; portrait screens pull back, rise and face the back wall", () => {
  const wide = cameraPose(1.6);
  assert.equal(wide.fov, 30);
  assert.ok(Math.abs(wide.yaw - 25 * DEGREE) < 1e-9);
  assert.ok(Math.abs(wide.pitch - 25 * DEGREE) < 1e-9);
  assert.deepEqual(cameraPose(PORTRAIT_ASPECT), wide);
  const tall = cameraPose(0.46);
  assert.ok(tall.distance > wide.distance);
  assert.ok(tall.pitch > wide.pitch);
  assert.ok(tall.yaw < wide.yaw);
  assert.ok(tall.target[2] < wide.target[2], "aims nearer the back wall");
  const [, y, z] = cameraPosition(wide);
  assert.ok(y > wide.target[1] && z > wide.target[2], "above and in front of the room");
});

test("the drift spans 1.5° over a minute and the parallax at most 0.5°", () => {
  assert.equal(driftYaw(0), 0);
  assert.ok(Math.abs(driftYaw(15) - 0.75 * DEGREE) < 1e-9);
  assert.ok(Math.abs(driftYaw(45) + 0.75 * DEGREE) < 1e-9);
  assert.ok(Math.abs(driftYaw(60)) < 1e-9);
  assert.ok(Math.abs(parallax(5, -5).yaw) <= 0.5 * DEGREE + 1e-12);
  assert.ok(Math.abs(parallax(5, -5).pitch) <= 0.5 * DEGREE + 1e-12);
  assert.deepEqual(parallax(0, 0), { yaw: -0, pitch: 0 });
});

test("the loop's rate follows visibility, dialogs, power and scrolling", () => {
  const base = { hidden: false, slow: false, scrolling: false, lowPower: false };
  assert.equal(targetFps(base), 24);
  assert.equal(targetFps({ ...base, scrolling: true }), 60);
  assert.equal(targetFps({ ...base, slow: true, scrolling: true }), 6);
  assert.equal(targetFps({ ...base, lowPower: true }), 12);
  assert.equal(targetFps({ ...base, hidden: true, scrolling: true }), 0);
});

test("Low Power Mode is a ~30 Hz animation-frame cadence over a full window", () => {
  const fill = (ms) => Array.from({ length: CADENCE_SAMPLES }, () => ms);
  assert.equal(looksLowPower(fill(16.7)), false);
  assert.equal(looksLowPower(fill(8.3)), false);
  assert.equal(looksLowPower(fill(33.3)), true);
  assert.equal(looksLowPower(fill(33.3).slice(1)), false, "needs a full window");
  // A few long frames on a 60 Hz display do not count.
  assert.equal(looksLowPower([...fill(16.7).slice(10), ...Array(10).fill(34)]), false);
});
