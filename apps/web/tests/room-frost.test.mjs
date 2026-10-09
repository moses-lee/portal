import assert from "node:assert/strict";
import test from "node:test";
import { EDGE, frostQuad, intersect, parseRadius } from "../src/room/frost/registry.ts";

/** A 1440 × 900 CSS-pixel canvas at the viewport's origin, drawn at a pixel ratio of `dpr`. */
const space = (dpr = 1) => ({ left: 0, top: 0, width: 1440, height: 900, bufferWidth: 1440 * dpr, bufferHeight: 900 * dpr });

test("a panel's box becomes canvas pixels: scaled by the pixel ratio, Y flipped to point up", () => {
  // A 280 × 900 sidebar at the left edge, at 1.5×.
  const sidebar = frostQuad({ left: 0, top: 0, width: 280, height: 900 }, null, 0, space(1.5));
  assert.deepEqual(sidebar, { cx: 210, cy: 675, halfWidth: 210, halfHeight: 675, radius: 0, x0: 0, y0: 0, x1: 420 + EDGE, y1: 1350 });

  // A card 100 px from the top and 50 px tall sits 750..800 px up from the bottom at 1×.
  const card = frostQuad({ left: 400, top: 100, width: 600, height: 50 }, null, 16, space(1));
  assert.equal(card.cy, 900 - 125);
  assert.equal(card.halfHeight, 25);
  assert.equal(card.cx, 700);
  assert.deepEqual([card.x0, card.y0, card.x1, card.y1], [400 - EDGE, 750 - EDGE, 1000 + EDGE, 800 + EDGE]);
  // At 2× everything doubles, the radius too.
  const sharp = frostQuad({ left: 400, top: 100, width: 600, height: 50 }, null, 16, space(2));
  assert.deepEqual([sharp.cx, sharp.cy, sharp.halfWidth, sharp.halfHeight, sharp.radius], [1400, 1550, 600, 50, 32]);
});

test("a canvas that does not start at the viewport's origin offsets the box", () => {
  const offset = { left: 100, top: 50, width: 800, height: 600, bufferWidth: 800, bufferHeight: 600 };
  const quad = frostQuad({ left: 100, top: 50, width: 200, height: 100 }, null, 0, offset);
  assert.deepEqual([quad.cx, quad.cy], [100, 550]);
});

test("the radius is clamped to half the shorter side", () => {
  // Tailwind's rounded-full computes to a huge length: a pill, not a nonsense SDF.
  const pill = frostQuad({ left: 0, top: 0, width: 120, height: 32 }, null, parseRadius("3.35544e+07px", 120, 32), space(1.5));
  assert.equal(pill.radius, 24);
  assert.equal(frostQuad({ left: 0, top: 0, width: 40, height: 40 }, null, -4, space(1)).radius, 0);
});

test("radii parse from computed styles", () => {
  assert.equal(parseRadius("16px", 100, 100), 16);
  assert.equal(parseRadius("0px", 100, 100), 0);
  assert.equal(parseRadius("", 100, 100), 0);
  assert.equal(parseRadius("50%", 200, 40), 20);
  assert.equal(parseRadius("12px 6px", 100, 100), 12);
});

test("the quad is cut to the panel's clipping ancestors and to the canvas; nothing shows, nothing drawn", () => {
  // A card half scrolled out of a scroller that starts 60 px down: the quad stops at the scroller's top.
  const scroller = { left: 300, top: 60, width: 800, height: 700 };
  const card = frostQuad({ left: 400, top: 20, width: 600, height: 100 }, scroller, 16, space(1));
  assert.equal(card.y1, 900 - 60);
  // The shape is still the whole card, so the clipped edge is straight and the corners below stay round.
  assert.equal(card.cy, 900 - 70);
  assert.equal(card.halfHeight, 50);
  // Scrolled out entirely, or off the canvas, or empty: no quad.
  assert.equal(frostQuad({ left: 400, top: -200, width: 600, height: 100 }, scroller, 16, space(1)), null);
  assert.equal(frostQuad({ left: 1500, top: 10, width: 100, height: 100 }, null, 0, space(1)), null);
  assert.equal(frostQuad({ left: 10, top: 10, width: 0, height: 100 }, null, 0, space(1)), null);
  // Partly off the canvas: the quad stops at its edge.
  const edge = frostQuad({ left: 1400, top: 0, width: 100, height: 100 }, null, 0, space(1));
  assert.equal(edge.x1, 1440);
});

test("clips intersect", () => {
  assert.deepEqual(intersect({ left: 0, top: 0, width: 100, height: 100 }, { left: 50, top: 25, width: 100, height: 50 }), {
    left: 50,
    top: 25,
    width: 50,
    height: 50,
  });
  assert.deepEqual(intersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 20, width: 5, height: 5 }).width, 0);
});
