import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import {
  FRAME_PAD,
  LANDSCAPE_ASPECT,
  PORTRAIT_ASPECT,
  WINDOW_CENTRE,
  boxCorners,
  cameraPosition,
  framePose,
  frameSpec,
  projectPoint,
  readLayout,
  registerStage,
} from "../src/room/layout.ts";
import { looksLowPower, targetFps, CADENCE_SAMPLES } from "../src/room/loop.ts";

const DEGREE = Math.PI / 180;

/** The six viewports the fit is checked at (docs/PALACE.md, Revision 4: 1920 × 1080 took the strip's place). */
const VIEWPORTS = [
  { name: "1440 × 900", width: 1440, height: 900 },
  { name: "1920 × 1080", width: 1920, height: 1080 },
  { name: "1280 × 720", width: 1280, height: 720 },
  { name: "820 × 1180", width: 820, height: 1180 },
  { name: "390 × 844", width: 390, height: 844 },
  { name: "844 × 390", width: 844, height: 390 },
];

/** The camera's right axis for a pose, as `basis` in layout.ts has it. */
const rightOf = (pose) => [Math.cos(pose.yaw), 0, -Math.sin(pose.yaw)];

/** The pose before its aim: the target moved back along the camera's right axis by the blended aim. */
function unaimed(aspect) {
  const pose = framePose(aspect);
  const r = rightOf(pose);
  const { aim } = frameSpec(aspect);
  return { ...pose, target: pose.target.map((value, axis) => value - aim * r[axis]) };
}

/** The blended hero box's corners on the fitted frame before its aim (no view offset), in CSS pixels. */
function frameBounds(width, height) {
  const pose = unaimed(width / height);
  const points = boxCorners(frameSpec(width / height).box).map((corner) => projectPoint(pose, corner, { width, height }));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

test("the fitted pose, before its aim, holds the hero box inside the pad, centred, and touching the pad on the axis that set the distance", () => {
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

test("the landscape aim draws the frame 140 px right of the centre at 1440 × 900, the portrait aim nothing", () => {
  // The frame's centre is the unaimed target; the aimed pose draws it right of the viewport's centre.
  const desktop = framePose(1440 / 900);
  const centre = projectPoint(desktop, unaimed(1440 / 900).target, { width: 1440, height: 900 });
  assert.ok(Math.abs(centre.x - 860) < 1 && Math.abs(centre.y - 450) < 1e-6, `the frame's centre at ${centre.x}, ${centre.y}`);
  // The same room-metre aim at 1920 × 1080: the same pose (the height sets the distance), scaled with the height.
  const wide = framePose(1920 / 1080);
  assert.deepEqual(wide, desktop);
  const wideCentre = projectPoint(wide, unaimed(1920 / 1080).target, { width: 1920, height: 1080 });
  assert.ok(Math.abs(wideCentre.x - (960 + 140 * (1080 / 900))) < 1.2, `at 1920 × 1080: ${wideCentre.x}`);
  // The portrait aim is zero: the phone's pose is the plain fit (the target pinned, so an aim on any axis would show).
  const phone = framePose(390 / 844);
  assert.deepEqual(phone.target, unaimed(390 / 844).target);
  for (const [axis, expected] of [-0.159, 1.179, -0.901].entries()) assert.ok(Math.abs(phone.target[axis] - expected) < 0.001, `phone target ${axis}: ${phone.target[axis]}`);
  assert.equal(frameSpec(0.8).aim, 0);
  assert.ok(Math.abs(frameSpec(1.1).aim - frameSpec(1.4).aim / 2) < 1e-9, "the aim blends with the angles");
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
  for (const { name, width, height } of VIEWPORTS) {
    const pose = framePose(width / height);
    const camera = new PerspectiveCamera(pose.fov, width / height, 0.5, 220);
    camera.position.set(...cameraPosition(pose));
    camera.lookAt(...pose.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const points = [...boxCorners(frameSpec(width / height).box), WINDOW_CENTRE];
    for (const point of points) {
      const ours = projectPoint(pose, point, { width, height });
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

test("the registry's viewport is the room's fixed element, the size the canvas takes, not the window's inner size", () => {
  const frames = [];
  // A classic scrollbar: the window is 1440 wide, the root and the fixed element 1425.
  globalThis.window = { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { clientWidth: 1425, clientHeight: 900 } };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
  };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  const flush = () => frames.splice(0).forEach((callback) => callback(0));
  try {
    const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1425, height: 812 }) };
    const unstage = registerStage(stage);
    // The stage's box once measured; the root's client size again after the stage goes.
    flush();
    assert.deepEqual([readLayout().width, readLayout().height], [1425, 812]);
    unstage();
    flush();
    assert.deepEqual([readLayout().width, readLayout().height], [1425, 900]);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.ResizeObserver;
    delete globalThis.requestAnimationFrame;
  }
});
