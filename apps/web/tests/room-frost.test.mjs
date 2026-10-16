import assert from "node:assert/strict";
import test from "node:test";
import {
  collectFrost,
  EDGE,
  effectiveOpacity,
  FLOATS_PER_PANEL,
  FROST_SELECTOR,
  frostChanged,
  frostQuad,
  intersect,
  MOTION_ATTRIBUTE,
  OPACITY_REFRESH_MS,
  parseRadius,
  resetFrost,
} from "../src/room/frost/registry.ts";

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

/**
 * A page of fake elements for `collectFrost`: each has a class list, a box, a computed style and a
 * parent; the document's query returns the ones matching any of the selector's classes.
 */
/** One media query list for every fake page: the registry keeps the first it is given. */
const reducedTransparencyQuery = { matches: false };

function fakePage(elements, { reducedTransparency = false } = {}) {
  reducedTransparencyQuery.matches = reducedTransparency;
  const attributes = new Set();
  const root = {
    parentElement: null,
    style: {},
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => attributes.add(name),
    removeAttribute: (name) => attributes.delete(name),
  };
  const previous = {};
  const globals = {
    document: {
      documentElement: root,
      querySelectorAll(selector) {
        const classes = selector.split(",").map((part) => part.trim().replace(/^\./, ""));
        return elements.filter((element) => element.classes.some((name) => classes.includes(name)));
      },
    },
    window: { matchMedia: () => reducedTransparencyQuery },
    // Live, as the browser's are: a later change to `element.style` shows through.
    getComputedStyle: (element) =>
      new Proxy(
        {},
        { get: (_, key) => (key in element.style ? element.style[key] : { position: "static", overflowX: "visible", overflowY: "visible", borderTopLeftRadius: "0px", opacity: "1" }[key]) },
      ),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return {
    root,
    restore() {
      resetFrost();
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

const element = (classes, box, parentElement, style = {}) => ({
  classes,
  classList: { contains: (name) => classes.includes(name) },
  getBoundingClientRect: () => box,
  parentElement,
  style,
});

test("liquid panels are frosted and flagged in the instance buffer's tenth float", () => {
  assert.equal(FLOATS_PER_PANEL, 11);
  assert.equal(FROST_SELECTOR, ".frost, .frost-subtle");
  const panels = [];
  const page = fakePage(panels);
  try {
    const sidebar = element(["frost-subtle", "liquid"], { left: 10, top: 10, width: 280, height: 880 }, page.root, { borderTopLeftRadius: "18px" });
    const composer = element(["frost"], { left: 400, top: 800, width: 600, height: 80 }, page.root, { borderTopLeftRadius: "16px" });
    // Liquid alone, without a frost class, is still a panel.
    const logo = element(["liquid"], { left: 10, top: 10, width: 36, height: 36 }, page.root, { borderTopLeftRadius: "12px" });
    panels.push(sidebar, composer, logo);
    const buffer = { data: new Float32Array(FLOATS_PER_PANEL), liquid: 0 };
    assert.equal(collectFrost(space(1), buffer), 3);
    assert.equal(buffer.liquid, 2);
    const at = (index) => buffer.data.slice(index * FLOATS_PER_PANEL, (index + 1) * FLOATS_PER_PANEL);
    assert.deepEqual([...at(0)], [150, 450, 140, 440, 10 - EDGE, 10 - EDGE, 290 + EDGE, 890 + EDGE, 18, 1, 1]);
    assert.equal(at(1)[9], 0);
    assert.equal(at(1)[8], 16);
    assert.equal(at(2)[9], 1);

    // Under reduced transparency nothing is drawn, liquid glass included.
    page.restore();
    const solid = fakePage(panels, { reducedTransparency: true });
    try {
      assert.equal(collectFrost(space(1), buffer), 0);
      assert.equal(buffer.liquid, 0);
    } finally {
      solid.restore();
    }
  } finally {
    page.restore();
  }
});

test("a liquid panel keeps its rim under a clipping ancestor; plain frost is cut to it; the canvas cuts both", () => {
  const panels = [];
  const page = fakePage(panels);
  try {
    // A shell that clips to x ≥ 100, with a panel sliding out past its left edge.
    const shell = { parentElement: page.root, style: { overflowX: "hidden", overflowY: "hidden" }, getBoundingClientRect: () => ({ left: 100, top: 0, width: 1340, height: 900 }) };
    const box = { left: -80, top: 10, width: 280, height: 880 };
    panels.push(element(["frost-subtle", "liquid"], box, shell), element(["frost-subtle"], box, shell));
    const buffer = { data: new Float32Array(2 * FLOATS_PER_PANEL), liquid: 0 };
    assert.equal(collectFrost(space(1), buffer), 2);
    const liquid = buffer.data.slice(0, FLOATS_PER_PANEL);
    const plain = buffer.data.slice(FLOATS_PER_PANEL, 2 * FLOATS_PER_PANEL);
    // The liquid quad starts at the canvas's edge, not the shell's; the plain one at the shell's.
    assert.equal(liquid[4], 0);
    assert.equal(plain[4], 100);
    // Both keep the whole panel's shape, so the rim's SDF is the panel's.
    assert.deepEqual([liquid[0], liquid[2]], [60, 140]);
    assert.deepEqual([plain[0], plain[2]], [60, 140]);
    assert.equal(liquid[6], 200 + EDGE);
  } finally {
    page.restore();
  }
});

test("opacities multiply up the ancestors", () => {
  assert.equal(effectiveOpacity([{ opacity: "1" }, { opacity: "0.5" }, { opacity: "0.5" }]), 0.25);
  assert.equal(effectiveOpacity([]), 1);
  // Unparsable counts as 1; out of range is clamped.
  assert.equal(effectiveOpacity([{ opacity: "" }, { opacity: "2" }]), 1);
  assert.equal(effectiveOpacity([{ opacity: "-1" }]), 0);
});

test("a panel inside a fading ancestor is drawn at the ancestor's opacity, read live only while things move", (t) => {
  let now = 10_000;
  t.mock.method(performance, "now", () => now);
  const panels = [];
  const page = fakePage(panels);
  try {
    const centre = { parentElement: page.root, style: {} };
    const composer = element(["frost"], { left: 400, top: 800, width: 600, height: 80 }, centre, { borderTopLeftRadius: "16px" });
    panels.push(composer);
    const buffer = { data: new Float32Array(FLOATS_PER_PANEL), liquid: 0 };
    assert.equal(collectFrost(space(1), buffer), 1);
    assert.equal(buffer.data[10], 1);

    // Palace mode fades the centre column: while the shell holds the motion attribute, every frame reads it.
    page.root.setAttribute(MOTION_ATTRIBUTE);
    centre.style.opacity = "0.4";
    now += 16;
    collectFrost(space(1), buffer);
    assert.ok(Math.abs(buffer.data[10] - 0.4) < 1e-6);
    // The composer's own opacity multiplies in.
    composer.style.opacity = "0.5";
    now += 16;
    collectFrost(space(1), buffer);
    assert.ok(Math.abs(buffer.data[10] - 0.2) < 1e-6);
    // Faded to nothing: not drawn at all.
    centre.style.opacity = "0";
    now += 16;
    assert.equal(collectFrost(space(1), buffer), 0);

    // Back at full opacity once the motion ends, then nothing moves: the cached value stands and no style is read
    // until the periodic refresh.
    centre.style.opacity = "1";
    composer.style.opacity = "1";
    now += 16;
    collectFrost(space(1), buffer);
    assert.equal(buffer.data[10], 1);
    page.root.removeAttribute(MOTION_ATTRIBUTE);
    now += 1_000;
    collectFrost(space(1), buffer);
    centre.style.opacity = "0.5";
    now += 16;
    collectFrost(space(1), buffer);
    assert.equal(buffer.data[10], 1, "an unannounced fade is not seen between refreshes");
    now += OPACITY_REFRESH_MS;
    collectFrost(space(1), buffer);
    assert.equal(buffer.data[10], 0.5, "the refresh catches it");
    // And a panel below 1 keeps being read every frame, so it settles back without waiting.
    centre.style.opacity = "1";
    now += 16;
    collectFrost(space(1), buffer);
    assert.equal(buffer.data[10], 1);
  } finally {
    page.restore();
  }
});

test("the still frame learns when panels move, fade, come or go since it was drawn", (t) => {
  t.mock.method(performance, "now", () => 50_000);
  const panels = [];
  const page = fakePage(panels);
  try {
    const box = { left: 10, top: 10, width: 280, height: 880 };
    const sidebar = element(["frost-subtle", "liquid"], box, page.root, { borderTopLeftRadius: "18px" });
    panels.push(sidebar);
    // Nothing drawn yet: nothing to compare with.
    assert.equal(frostChanged(), false);
    const buffer = { data: new Float32Array(FLOATS_PER_PANEL), liquid: 0 };
    collectFrost(space(1), buffer);
    assert.equal(frostChanged(), false);
    // Slid out (Palace mode, a collapse under reduced motion): changed until a frame draws it.
    box.left = -200;
    assert.equal(frostChanged(), true);
    collectFrost(space(1), buffer);
    assert.equal(frostChanged(), false);
    // Gone from the page.
    panels.length = 0;
    assert.equal(frostChanged(), true);
    collectFrost(space(1), buffer);
    assert.equal(frostChanged(), false);
  } finally {
    page.restore();
  }
});
