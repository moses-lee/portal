import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkspaceOp, EMPTY_WORKSPACE, tabPanes } from "@portal/shared/workspace";
import { flatPanes } from "../src/lib/workspace.ts";
import {
  focusScope,
  KEYBOARD_DROP_PX,
  MOBILE_QUERY,
  NARROW_QUERY,
  paneCounter,
  paneNeighbours,
  swipeOutcome,
  switcherPanes,
  tabRendersSplit,
  viewportAfterResize,
  viewportKind,
  viewportKindOf,
} from "../src/lib/workspace-mobile.ts";

function ids() {
  let n = 0;
  return () => `n${++n}`;
}

function build(ops) {
  const next = ids();
  return ops.reduce((ws, op) => applyWorkspaceOp(ws, op, next, 1000).workspace, EMPTY_WORKSPACE);
}

/** A single, a two-column split, and a three-column split: one tab of each size class. */
const ws = build([
  { op: "open", sessionId: "a" },
  { op: "arrange", sessionIds: ["b", "c"], preset: "columns-2" },
  { op: "arrange", sessionIds: ["d", "e", null], preset: "columns-3" },
]);
const [single, pair, triple] = ws.tabs;

test("viewport classes: below 768 a phone, up to 1100 a tablet, past it a desktop; the media queries say the same", () => {
  assert.equal(viewportKindOf(320), "mobile");
  assert.equal(viewportKindOf(767), "mobile");
  assert.equal(viewportKindOf(768), "tablet");
  assert.equal(viewportKindOf(1100), "tablet");
  assert.equal(viewportKindOf(1101), "desktop");
  assert.equal(viewportKind(true, true), "mobile");
  assert.equal(viewportKind(false, true), "tablet");
  assert.equal(viewportKind(false, false), "desktop");
  assert.equal(MOBILE_QUERY, "(max-width: 767px)");
  assert.equal(NARROW_QUERY, "(max-width: 1100px)");
});

test("tablet rule: tabs of 1 or 2 panes split, 3 or 4 show one pane; desktop always splits, a phone never", () => {
  assert.equal(tabRendersSplit(single, "tablet"), true);
  assert.equal(tabRendersSplit(pair, "tablet"), true);
  assert.equal(tabRendersSplit(triple, "tablet"), false);
  assert.equal(tabRendersSplit(triple, "desktop"), true);
  assert.equal(tabRendersSplit(single, "mobile"), false);
  // The focus scope the view reports: "pane" wherever one pane shows at a time.
  assert.equal(focusScope(pair, "desktop"), "tab");
  assert.equal(focusScope(pair, "tablet"), "tab");
  assert.equal(focusScope(triple, "tablet"), "pane");
  assert.equal(focusScope(single, "mobile"), "pane");
  assert.equal(focusScope(null, "mobile"), "tab");
});

test("the switcher's list: the whole workspace flat on a phone, one big tab's panes on a tablet, none otherwise", () => {
  assert.deepEqual(switcherPanes(ws, pair, "mobile"), flatPanes(ws));
  assert.deepEqual(
    switcherPanes(ws, pair, "mobile").map(({ pane }) => pane.sessionId),
    ["a", "b", "c", "d", "e", null],
  );
  assert.equal(switcherPanes(ws, pair, "tablet"), null);
  assert.deepEqual(
    switcherPanes(ws, triple, "tablet").map(({ tabId, pane }) => [tabId, pane.sessionId]),
    [[triple.id, "d"], [triple.id, "e"], [triple.id, null]],
  );
  assert.equal(switcherPanes(ws, triple, "desktop"), null);
  assert.equal(switcherPanes(ws, null, "tablet"), null);
  assert.deepEqual(switcherPanes(ws, null, "mobile"), flatPanes(ws));
});

test("neighbours: the panes either side in the list, none past the ends, nothing for a pane that is not there", () => {
  const panes = flatPanes(ws);
  const [p1, p2, , , , p6] = panes;
  assert.deepEqual(paneNeighbours(panes, p1.pane.id), { index: 0, previous: null, next: p2 });
  assert.deepEqual(paneNeighbours(panes, p2.pane.id), { index: 1, previous: p1, next: panes[2] });
  assert.deepEqual(paneNeighbours(panes, p6.pane.id), { index: 5, previous: panes[4], next: null });
  assert.deepEqual(paneNeighbours(panes, "gone"), { index: -1, previous: null, next: null });
  assert.deepEqual(paneNeighbours(panes, null), { index: -1, previous: null, next: null });
  // Scoped to a tab on a tablet: the tab's own ends.
  const scoped = tabPanes(triple).map((pane) => ({ tabId: triple.id, pane }));
  assert.equal(paneNeighbours(scoped, scoped[0].pane.id).previous, null);
  assert.equal(paneNeighbours(scoped, scoped[2].pane.id).next, null);
  assert.equal(paneCounter(1, 7), "2 of 7");
  assert.equal(paneCounter(0, 1), "1 of 1");
});

test("swipe: 40 px sideways switches (left pulls the next pane in), vertical drift past 30 px cancels, a still touch is a tap", () => {
  assert.equal(swipeOutcome(-40, 0), "next");
  assert.equal(swipeOutcome(-120, 20), "next");
  assert.equal(swipeOutcome(40, 0), "previous");
  assert.equal(swipeOutcome(39, 0), "none");
  assert.equal(swipeOutcome(-39, 0), "none");
  // Drift beyond the limit cancels, however far the pointer went sideways.
  assert.equal(swipeOutcome(-80, 31), "none");
  assert.equal(swipeOutcome(-80, 30), "next");
  // A tap: within the slop both ways.
  assert.equal(swipeOutcome(0, 0), "tap");
  assert.equal(swipeOutcome(8, 8), "tap");
  assert.equal(swipeOutcome(-8, 3), "tap");
  assert.equal(swipeOutcome(9, 0), "none");
  assert.equal(swipeOutcome(0, 9), "none");
});

test("keyboard up: the viewport 150 px below its largest height; back when it returns; a width change starts over", () => {
  assert.equal(KEYBOARD_DROP_PX, 150);
  let state = viewportAfterResize(null, 390, 800);
  assert.deepEqual(state, { width: 390, largestHeight: 800, keyboardUp: false });
  state = viewportAfterResize(state, 390, 650);
  assert.equal(state.keyboardUp, false);
  state = viewportAfterResize(state, 390, 649);
  assert.equal(state.keyboardUp, true);
  assert.equal(state.largestHeight, 800);
  state = viewportAfterResize(state, 390, 800);
  assert.equal(state.keyboardUp, false);
  // Taller than ever seen: the new largest.
  state = viewportAfterResize(state, 390, 820);
  assert.deepEqual(state, { width: 390, largestHeight: 820, keyboardUp: false });
  // Rotation: a shorter landscape viewport is not a keyboard.
  state = viewportAfterResize(state, 844, 390);
  assert.deepEqual(state, { width: 844, largestHeight: 390, keyboardUp: false });
  state = viewportAfterResize(state, 844, 200);
  assert.equal(state.keyboardUp, true);
  // A custom threshold.
  assert.equal(viewportAfterResize({ width: 390, largestHeight: 800, keyboardUp: false }, 390, 700, 50).keyboardUp, true);
});
