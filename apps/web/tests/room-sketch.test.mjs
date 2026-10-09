import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import { cameraPosition, framePose, projectPoint, ROOM, WINDOW_CENTRE } from "../src/room/layout.ts";
import { drawDelays, NEAR, pathOf, projectSketch, SKETCH, sketchFigure, sketchStrokes, SPREAD_MS } from "../src/room/sketch.ts";


/** The six viewports the fit is checked at (docs/PALACE.md, Revision 2, Camera). */
const VIEWPORTS = [
  { name: "1440 × 900", width: 1440, height: 900 },
  { name: "1920 × 1080", width: 1920, height: 1080 },
  { name: "1280 × 720", width: 1280, height: 720 },
  { name: "820 × 1180", width: 820, height: 1180 },
  { name: "390 × 844", width: 390, height: 844 },
  { name: "844 × 390", width: 844, height: 390 },
];

const EVERY_MILESTONE = new Set(["tall-bookcase", "second-bookcase", "wide-pinboard", "bay-window"]);

/** A three.js camera placed as `Camera.tsx` places it. */
function threeCamera(pose, width, height) {
  const camera = new PerspectiveCamera(pose.fov, width / height, 0.5, 220);
  camera.position.set(...cameraPosition(pose));
  camera.lookAt(...pose.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

test("every sketch point projects where a three.js camera set up as Camera.tsx draws it, in front of the near plane", () => {
  for (const strokes of [SKETCH, sketchStrokes(EVERY_MILESTONE)]) {
    for (const { name, width, height } of VIEWPORTS) {
      const pose = framePose(width / height);
      const camera = threeCamera(pose, width, height);
      const projected = projectSketch(pose, { width, height }, strokes);
      strokes.forEach((stroke, index) => {
        // Every authored point is in front of the near plane, so each stroke is one run, unclipped.
        const { runs } = projected[index];
        assert.equal(runs.length, 1, `${name}, ${stroke.id}: one run`);
        const points = stroke.closed ? [...stroke.points, stroke.points[0]] : stroke.points;
        assert.equal(runs[0].length, points.length, `${name}, ${stroke.id}: every point kept`);
        points.forEach((point, at) => {
          assert.ok(projectPoint(pose, point, { width, height }).z > NEAR, `${name}, ${stroke.id}: in front of the near plane`);
          const theirs = new Vector3(...point).project(camera);
          const x = ((theirs.x + 1) / 2) * width;
          const y = ((1 - theirs.y) / 2) * height;
          const ours = runs[0][at];
          assert.ok(Math.abs(ours.x - x) < 0.01 && Math.abs(ours.y - y) < 0.01, `${name}, ${stroke.id} ${point}: ${ours.x}, ${ours.y} against ${x}, ${y}`);
        });
      });
    }
  }
});

test("the sketch has about fifty strokes for the room as it starts, and the milestones change only their own lines", () => {
  const ids = SKETCH.map((stroke) => stroke.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.ok(SKETCH.length >= 45 && SKETCH.length <= 75, `${SKETCH.length} strokes`);
  assert.ok(ids.includes("shelf-board-0") && ids.includes("mullion") && ids.includes("board-frame"));

  const grown = sketchStrokes(EVERY_MILESTONE).map((stroke) => stroke.id);
  assert.equal(new Set(grown).size, grown.length, "ids are unique with every milestone");
  // The tall bookcase replaces the small shelf; the second stands beside it.
  assert.ok(!grown.some((id) => id.startsWith("shelf-")), "the small shelf is gone");
  assert.equal(grown.filter((id) => id.startsWith("tall-bookcase-shelf-")).length, 5);
  assert.equal(grown.filter((id) => id.startsWith("second-bookcase-shelf-")).length, 5);
  // The bay takes the panes out: no mullion or transom, its outline beyond the opening.
  assert.ok(!grown.includes("mullion") && !grown.includes("transom"));
  assert.ok(grown.includes("bay-bottom") && grown.includes("bay-top"));
  // Everything else is the same strokes.
  const changed = /^(shelf-|tall-bookcase|second-bookcase|mullion|transom|window-frame|bay-|board-)/;
  assert.deepEqual(
    grown.filter((id) => !changed.test(id)),
    ids.filter((id) => !changed.test(id)),
  );
  // The wide pinboard is wider than the corkboard it replaces.
  const width = (strokes) => {
    const frame = strokes.find((stroke) => stroke.id === "board-frame").points.map((point) => point[2]);
    return Math.max(...frame) - Math.min(...frame);
  };
  assert.ok(width(sketchStrokes(new Set(["wide-pinboard"]))) > width(SKETCH) + 0.7);
});

test("the strokes draw in from the back wall to the front over half a second", () => {
  const pose = framePose(1.6);
  const projected = projectSketch(pose, { width: 1440, height: 900 });
  const delays = drawDelays(projected);
  const delayOf = (id) => delays[projected.findIndex((stroke) => stroke.id === id)];
  // The walls' lines and what stands against the back wall first.
  for (const id of ["floor-line", "corner", "breast-left", "window", "hallway"]) assert.equal(delayOf(id), 0, id);
  for (const id of ["door-casing", "sill", "mail-shelf", "key-rack"]) assert.ok(delayOf(id) <= 30, id);
  assert.equal(Math.max(...delays), SPREAD_MS);
  assert.equal(Math.min(...delays), 0);
  // Later the nearer a stroke stands.
  assert.ok(delayOf("window") < delayOf("desk-top") && delayOf("desk-top") < delayOf("chair-seat") && delayOf("chair-seat") < delayOf("rug"));
  assert.ok(delayOf("rug") >= 400 && delayOf("bench-top") >= 400, "the rug and the bench last");
  projected.forEach((stroke, index) => {
    projected.forEach((other, at) => {
      if (stroke.depth < other.depth) assert.ok(delays[index] <= delays[at], `${stroke.id} before ${other.id}`);
    });
  });
});

test("a stroke that crosses the near plane is cut where it does, and one behind it is dropped", () => {
  const pose = framePose(1.6);
  const size = { width: 1440, height: 900 };
  const camera = cameraPosition(pose);
  // From the room's middle straight through the camera and past it.
  const towards = [camera[0] - pose.target[0], camera[1] - pose.target[1], camera[2] - pose.target[2]];
  const at = (t) => [pose.target[0] + towards[0] * t, pose.target[1] + towards[1] * t, pose.target[2] + towards[2] * t];
  const strokes = [
    { id: "through", points: [at(0), at(2)] },
    { id: "behind", points: [at(1.5), at(2)] },
  ];
  const [through, behind] = projectSketch(pose, size, strokes);
  assert.equal(through.runs.length, 1);
  assert.equal(through.runs[0].length, 2);
  // The cut lies on the near plane: the line through the camera is the screen's centre, end to end.
  for (const point of through.runs[0]) assert.ok(Math.abs(point.x - 720) < 1e-6 && Math.abs(point.y - 450) < 1e-6);
  assert.deepEqual(behind.runs, []);
});

test("the sketch's window lands where the camera draws it, on a phone too, and its paths are plain SVG", () => {
  const phone = framePose(390 / 844);
  const figure = sketchFigure(phone, { width: 390, height: 844 });
  const phoneWindow = projectPoint(phone, WINDOW_CENTRE, { width: 390, height: 844 });
  assert.ok(Math.abs(figure.window.x - phoneWindow.x) < 0.01 && Math.abs(figure.window.y - phoneWindow.y) < 0.01, `${figure.window.x}, ${figure.window.y}`);
  assert.equal(figure.strokes.length, SKETCH.length);
  for (const stroke of figure.strokes) assert.match(stroke.d, /^(M-?\d+(\.\d)? -?\d+(\.\d)?(L-?\d+(\.\d)? -?\d+(\.\d)?)+)+$/);
  assert.match(figure.wall, /Z$/);
  assert.match(figure.panes, /Z$/);
  assert.ok(figure.lamp && figure.hearth && figure.lamp.r > 0 && figure.hearth.r > 0);

  const desktop = framePose(1.6);
  const plain = sketchFigure(desktop, { width: 1440, height: 900 });
  const centre = projectPoint(desktop, WINDOW_CENTRE, { width: 1440, height: 900 });
  assert.deepEqual(plain.window, { x: centre.x, y: centre.y });
  // The panes lie inside the window's opening on screen.
  const opening = [
    [ROOM.window.x - ROOM.window.width / 2, ROOM.window.sill, ROOM.back],
    [ROOM.window.x + ROOM.window.width / 2, ROOM.window.top, ROOM.back],
  ].map((point) => projectPoint(desktop, point, { width: 1440, height: 900 }));
  const xs = [...plain.panes.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(Math.min(...xs) > opening[0].x - 1 && Math.max(...xs) < opening[1].x + 1);
  assert.equal(pathOf([[{ x: 1.04, y: 2 }, { x: -3.25, y: 4.96 }]]), "M1 2L-3.2 5");
});
