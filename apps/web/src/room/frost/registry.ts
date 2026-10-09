/**
 * Where the frost goes (docs/PALACE.md, Web → Frost): every `.frost` and `.frost-subtle` element on
 * the page, as rounded rectangles in the canvas's drawing-buffer pixels with Y pointing up, written
 * into the instance buffer the mask pass draws.
 *
 * The maths (`parseRadius`, `frostQuad`) is pure and unit-tested. `collectFrost` is browser only:
 * it queries the panels once per rendered frame and reads their boxes then (they move with every
 * scroll), while each panel's corner radius and clipping ancestors are read once and kept until a
 * `ResizeObserver` or `MutationObserver` (class or style) says the panel changed.
 */

export type Box = { left: number; top: number; width: number; height: number };

/** The canvas: its box in CSS pixels and its drawing buffer in device pixels. */
export type FrostSpace = Box & { bufferWidth: number; bufferHeight: number };

/** A panel in drawing-buffer pixels from the bottom left: its centre, half size and corner radius, and the quad to draw. */
export type FrostQuad = {
  cx: number;
  cy: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
  /** The quad: the panel plus `EDGE` pixels for the antialiased edge, cut to its clip and the canvas. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** Drawing-buffer pixels added around each panel, so the edge's antialiasing (one mask texel, two pixels) is not cut off. */
export const EDGE = 2;

/** Floats per panel in the instance buffer: shape (cx, cy, half width, half height), quad (x0, y0, x1, y1), radius. */
export const FLOATS_PER_PANEL = 9;

/**
 * A computed `border-radius` corner (`"12px"`, `"50%"`, `"8px 4px"`, or Tailwind's
 * `calc(infinity * 1px)` computed to a huge length) in CSS pixels for a box of `width` × `height`.
 * Elliptical corners use their first radius. Not clamped here; `frostQuad` clamps.
 */
export function parseRadius(value: string, width: number, height: number): number {
  const first = value.trim().split(/\s+/)[0] ?? "";
  const number = Number.parseFloat(first);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (first.endsWith("%")) return (number / 100) * Math.min(width, height);
  return number;
}

/**
 * `box` (CSS pixels, viewport coordinates) in the canvas's drawing buffer: scaled by the buffer's
 * pixel ratio, flipped so Y points up, its radius clamped to half its shorter side, and its quad cut
 * to `clip` (CSS pixels; the overflow ancestors that hide part of it) and to the canvas. Null when
 * nothing of it shows.
 */
export function frostQuad(box: Box, clip: Box | null, radius: number, space: FrostSpace): FrostQuad | null {
  if (box.width <= 0 || box.height <= 0 || space.width <= 0 || space.height <= 0) return null;
  const sx = space.bufferWidth / space.width;
  const sy = space.bufferHeight / space.height;
  const toX = (x: number) => (x - space.left) * sx;
  /** A CSS y (down from the top) as a buffer y (up from the bottom). */
  const toY = (y: number) => space.bufferHeight - (y - space.top) * sy;

  const left = toX(box.left);
  const right = toX(box.left + box.width);
  const bottom = toY(box.top + box.height);
  const top = toY(box.top);
  const halfWidth = (right - left) / 2;
  const halfHeight = (top - bottom) / 2;

  let x0 = Math.max(0, left - EDGE);
  let x1 = Math.min(space.bufferWidth, right + EDGE);
  let y0 = Math.max(0, bottom - EDGE);
  let y1 = Math.min(space.bufferHeight, top + EDGE);
  if (clip) {
    x0 = Math.max(x0, toX(clip.left));
    x1 = Math.min(x1, toX(clip.left + clip.width));
    y0 = Math.max(y0, toY(clip.top + clip.height));
    y1 = Math.min(y1, toY(clip.top));
  }
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;

  return {
    cx: left + halfWidth,
    cy: bottom + halfHeight,
    halfWidth,
    halfHeight,
    radius: Math.max(0, Math.min(radius * Math.min(sx, sy), halfWidth, halfHeight)),
    x0,
    y0,
    x1,
    y1,
  };
}

/** The overlap of two boxes; zero-sized (not null) when they do not meet. */
export function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// ---------------------------------------------------------------------------------------------
// The registry (browser only)
// ---------------------------------------------------------------------------------------------

export const FROST_SELECTOR = ".frost, .frost-subtle";

/** What is read once per panel: its radius as computed, and the ancestors whose overflow clips it. */
type Panel = { radius: string; clips: Element[] };

const panels = new Map<Element, Panel>();
let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
let reducedTransparency: MediaQueryList | null = null;

/** Forget what was read about a panel; the next frame reads it again. */
function stale(element: Element) {
  const panel = panels.get(element);
  if (panel) panel.radius = "";
}

function observers() {
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) stale(entry.target);
  });
  mutationObserver ??= new MutationObserver((records) => {
    for (const record of records) stale(record.target as Element);
  });
  return { resize: resizeObserver, mutation: mutationObserver };
}

/** The element's ancestors that clip it (overflow other than visible), up to a fixed-position element, which escapes them. */
function clippingAncestors(element: Element): Element[] {
  const clips: Element[] = [];
  if (getComputedStyle(element).position === "fixed") return clips;
  for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") clips.push(node);
    if (style.position === "fixed") break;
  }
  return clips;
}

function read(element: Element): Panel {
  let panel = panels.get(element);
  if (!panel) {
    const { resize, mutation } = observers();
    resize.observe(element);
    mutation.observe(element, { attributes: true, attributeFilter: ["class", "style"] });
    panel = { radius: "", clips: [] };
    panels.set(element, panel);
  }
  if (!panel.radius) {
    // Never empty once read, so a panel is read once per change.
    panel.radius = getComputedStyle(element).borderTopLeftRadius || "0px";
    panel.clips = clippingAncestors(element);
  }
  return panel;
}

/** A growable instance buffer: `FLOATS_PER_PANEL` floats per panel. */
export type FrostBuffer = { data: Float32Array };

/**
 * Writes every visible frosted panel into `buffer` (growing it when needed) and returns how many
 * there are; 0 means the frame needs no frost at all. Under `prefers-reduced-transparency` the
 * panels are solid and nothing is drawn.
 */
export function collectFrost(space: FrostSpace, buffer: FrostBuffer): number {
  reducedTransparency ??= window.matchMedia("(prefers-reduced-transparency: reduce)");
  const elements = reducedTransparency.matches ? [] : document.querySelectorAll(FROST_SELECTOR);
  const seen = new Set<Element>();
  const clipBoxes = new Map<Element, Box>();
  let count = 0;
  for (const element of elements) {
    seen.add(element);
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const panel = read(element);
    let clip: Box | null = null;
    for (const ancestor of panel.clips) {
      let ancestorBox = clipBoxes.get(ancestor);
      if (!ancestorBox) {
        const rect = ancestor.getBoundingClientRect();
        ancestorBox = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        clipBoxes.set(ancestor, ancestorBox);
      }
      clip = clip ? intersect(clip, ancestorBox) : ancestorBox;
    }
    const quad = frostQuad(box, clip, parseRadius(panel.radius, box.width, box.height), space);
    if (!quad) continue;
    if ((count + 1) * FLOATS_PER_PANEL > buffer.data.length) {
      const grown = new Float32Array(Math.max(buffer.data.length * 2, (count + 1) * FLOATS_PER_PANEL));
      grown.set(buffer.data);
      buffer.data = grown;
    }
    const data = buffer.data;
    const at = count * FLOATS_PER_PANEL;
    data[at] = quad.cx;
    data[at + 1] = quad.cy;
    data[at + 2] = quad.halfWidth;
    data[at + 3] = quad.halfHeight;
    data[at + 4] = quad.x0;
    data[at + 5] = quad.y0;
    data[at + 6] = quad.x1;
    data[at + 7] = quad.y1;
    data[at + 8] = quad.radius;
    count += 1;
  }
  // Panels that left the page stop being observed.
  for (const element of panels.keys()) {
    if (seen.has(element)) continue;
    panels.delete(element);
    resizeObserver?.unobserve(element);
  }
  return count;
}

/** Stops observing every panel (the canvas unmounted). */
export function resetFrost() {
  panels.clear();
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  resizeObserver = null;
  mutationObserver = null;
}
