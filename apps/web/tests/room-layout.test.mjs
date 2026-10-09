import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import {
  FRAME_PAD,
  LANDSCAPE_ASPECT,
  MIN_MARGIN,
  PORTRAIT_ASPECT,
  WINDOW_CENTRE,
  boxCorners,
  cameraPosition,
  framePose,
  frameSpec,
  interestPoint,
  layoutOffset,
  projectPoint,
  readLayout,
  registerCover,
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

test("the view offset shifts the full frame so its anchor (by default its centre) lands on the point", () => {
  assert.deepEqual(viewOffset(1440, 900, { x: 720, y: 450 }), { fullWidth: 1440, fullHeight: 900, x: 0, y: 0, width: 1440, height: 900 });
  assert.deepEqual(viewOffset(1440, 900, { x: 860, y: 450 }), { fullWidth: 1440, fullHeight: 900, x: -140, y: 0, width: 1440, height: 900 });
  assert.deepEqual(viewOffset(390, 844, { x: 195, y: 36 }), { fullWidth: 390, fullHeight: 844, x: 0, y: 386, width: 390, height: 844 });
  assert.deepEqual(viewOffset(390, 844, { x: 195, y: 36 }, { x: 170, y: 330 }), { fullWidth: 390, fullHeight: 844, x: -25, y: 294, width: 390, height: 844 });
});

/** The six viewports the fit is checked at (docs/PALACE.md, Revision 2, Camera). */
const VIEWPORTS = [
  { name: "1440 × 900", width: 1440, height: 900, covers: [] },
  { name: "1440 × 900 with a 320 px right panel", width: 1440, height: 900, covers: [{ kind: "right", rect: rect(1120, 320) }] },
  { name: "1280 × 720", width: 1280, height: 720, covers: [] },
  { name: "820 × 1180", width: 820, height: 1180, covers: [] },
  { name: "390 × 844", width: 390, height: 844, covers: [] },
  { name: "844 × 390", width: 844, height: 390, covers: [] },
];

/** The blended hero box's corners on the fitted frame (no view offset), in CSS pixels. */
function frameBounds(width, height) {
  const pose = framePose(width / height);
  const points = boxCorners(frameSpec(width / height).box).map((corner) => projectPoint(pose, corner, { width, height }));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

test("the fitted pose holds the hero box inside the pad, centred, and touching the pad on the axis that set the distance", () => {
  for (const { name, width, height } of VIEWPORTS) {
    const { left, right, top, bottom } = frameBounds(width, height);
    const [padX, padY] = [FRAME_PAD * width, FRAME_PAD * height];
    // Inside the pad, to 1e-6 px.
    assert.ok(left >= padX - 1e-6 && right <= width - padX + 1e-6, `${name}: x ${left}..${right}`);
    assert.ok(top >= padY - 1e-6 && bottom <= height - padY + 1e-6, `${name}: y ${top}..${bottom}`);
    // Centred on the frame's centre.
    assert.ok(Math.abs((left + right) / 2 - width / 2) < 0.01, `${name}: centred across`);
    assert.ok(Math.abs((top + bottom) / 2 - height / 2) < 0.01, `${name}: centred down`);
    // Touching the pad on both sides of one axis: no smaller distance would fit.
    const touchesX = Math.abs(left - padX) < 0.01 && Math.abs(right - (width - padX)) < 0.01;
    const touchesY = Math.abs(top - padY) < 0.01 && Math.abs(bottom - (height - padY)) < 0.01;
    assert.ok(touchesX || touchesY, `${name}: touches the pad`);
  }
});

test("a right-hand panel moves the frame and not the pose; the phone strip aims the window at its centre from the same pose", () => {
  const plain = layoutOffset({ width: 1440, height: 900, covers: [] }, framePose(1440 / 900));
  assert.deepEqual([plain.x, plain.y], [0, 0]);
  const panelled = layoutOffset(VIEWPORTS[1], framePose(1440 / 900));
  assert.deepEqual([panelled.x, panelled.y], [160, 0]);

  const phone = framePose(390 / 844);
  const strip = { width: 390, height: 844, covers: [{ kind: "column", rect: rect(0, 390, 72, 772) }, { kind: "focus", rect: rect(0, 390, 0, 72) }] };
  const offset = layoutOffset(strip, phone);
  const window = projectPoint(phone, WINDOW_CENTRE, { width: 390, height: 844 }, offset);
  assert.ok(Math.abs(window.x - 195) < 0.01 && Math.abs(window.y - 36) < 0.01, `the window lands at ${window.x}, ${window.y}`);
  // The view offset is a translation of the full frame.
  assert.deepEqual([offset.fullWidth, offset.fullHeight, offset.width, offset.height], [390, 844, 390, 844]);
});

test("the angles are the anchors' at and beyond 0.8 and 1.4, and the pose never jumps as the aspect changes", () => {
  const degrees = (pose) => [pose.yaw / DEGREE, pose.pitch / DEGREE];
  for (const aspect of [LANDSCAPE_ASPECT, 1.6, 2.5]) {
    const [yaw, pitch] = degrees(framePose(aspect));
    assert.ok(Math.abs(yaw - 25) < 1e-9 && Math.abs(pitch - 25) < 1e-9, `landscape at ${aspect}`);
  }
  for (const aspect of [PORTRAIT_ASPECT, 0.6, 0.45]) {
    const [yaw, pitch] = degrees(framePose(aspect));
    assert.ok(Math.abs(yaw - 14) < 1e-9 && Math.abs(pitch - 30) < 1e-9, `portrait at ${aspect}`);
  }
  const [yaw, pitch] = degrees(framePose(1.1));
  assert.ok(Math.abs(yaw - 19.5) < 1e-9 && Math.abs(pitch - 27.5) < 1e-9, "halfway between");
  assert.equal(framePose(1.6).fov, 30);

  let last = framePose(0.45);
  for (let step = 451; step <= 2500; step++) {
    const pose = framePose(step / 1000);
    const moved = [pose.distance - last.distance, ...pose.target.map((value, axis) => value - last.target[axis])];
    assert.ok(
      moved.every((delta) => Math.abs(delta) < 0.1),
      `at aspect ${step / 1000}: ${moved.map((delta) => delta.toFixed(3)).join(", ")}`,
    );
    last = pose;
  }
  const [x, y, z] = cameraPosition(framePose(1.6));
  const { target } = framePose(1.6);
  assert.ok(y > target[1] && z > target[2] && x > target[0], "above, in front of and to the right of the room");
});

test("projectPoint agrees with a three.js camera placed as Camera.tsx places it", () => {
  for (const { name, width, height, covers } of VIEWPORTS) {
    const pose = framePose(width / height);
    const offset = layoutOffset({ width, height, covers }, pose);
    const camera = new PerspectiveCamera(pose.fov, width / height, 0.5, 220);
    camera.position.set(...cameraPosition(pose));
    camera.lookAt(...pose.target);
    camera.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const points = [...boxCorners(frameSpec(width / height).box), WINDOW_CENTRE];
    for (const point of points) {
      const ours = projectPoint(pose, point, { width, height }, offset);
      const theirs = new Vector3(...point).project(camera);
      const x = ((theirs.x + 1) / 2) * width;
      const y = ((1 - theirs.y) / 2) * height;
      assert.ok(Math.abs(ours.x - x) < 0.01 && Math.abs(ours.y - y) < 0.01, `${name}, ${point}: ${ours.x}, ${ours.y} against ${x}, ${y}`);
      assert.ok(ours.z > 0.5, `${name}, ${point}: in front of the near plane`);
    }
  }
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

test("a cover's element leaves the registry when its registration is undone, and the room stops making room for it", () => {
  // Just enough browser for the registry: a window, a ResizeObserver, frames run on demand.
  const frames = [];
  globalThis.window = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
  };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  const flush = () => frames.splice(0).forEach((callback) => callback(0));
  try {
    const column = { getBoundingClientRect: () => ({ left: 400, top: 0, width: 720, height: 900 }) };
    const unregister = registerCover(column, "column");
    flush();
    assert.deepEqual(readLayout().covers, [{ kind: "column", rect: { left: 400, top: 0, width: 720, height: 900 } }]);
    unregister();
    flush();
    assert.deepEqual(readLayout().covers, []);
  } finally {
    delete globalThis.window;
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
  }
});
