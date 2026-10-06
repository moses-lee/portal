import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WORKSPACE,
  WorkspaceError,
  allPanes,
  applyWorkspaceOp,
  buildPreset,
  defaultTabTitle,
  depthOf,
  findTab,
  locatePane,
  locateSession,
  normalizeSizes,
  panesOf,
  parseWorkspaceOp,
  presetOf,
  presetSlotCount,
  tabPanes,
  validateWorkspace,
} from "../src/workspace.ts";

const NOW = 1_700_000_000_000;
const PRESETS = ["single", "columns-2", "columns-3", "rows-2", "grid-2x2", "one-beside-two"];

const counter = (prefix = "n") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value)) freeze(value[key]);
  }
  return value;
};

// Fixture builders.
const pane = (id, sessionId = null) => ({ kind: "pane", id, sessionId });
const split = (id, direction, children, sizes = normalizeSizes([], children.length)) => ({ kind: "split", id, direction, children, sizes });
const tab = (id, root, extra = {}) => ({ id, title: null, titleSource: null, root, createdAt: NOW - 1000, ...extra });
const ws = (...tabs) => ({ tabs, version: 3 });

/** Applies an op to a deep-frozen copy of `workspace`, so any mutation of the input throws. */
const apply = (workspace, op, ids = counter()) => applyWorkspaceOp(freeze(structuredClone(workspace)), op, ids, NOW);

const throwsCode = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof WorkspaceError, `expected WorkspaceError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
};

const sessionsOf = (t) => tabPanes(t).map((p) => p.sessionId);

// ---------------------------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------------------------

test("open with no target appends a one-pane tab and answers its location", () => {
  const result = apply(EMPTY_WORKSPACE, { op: "open", sessionId: "s1" });
  assert.equal(result.changed, true);
  assert.equal(result.workspace.version, 0, "the reducer never bumps version");
  assert.equal(result.workspace.tabs.length, 1);
  const [t] = result.workspace.tabs;
  assert.deepEqual(t, { id: "n2", title: null, titleSource: null, root: pane("n1", "s1"), createdAt: NOW });
  assert.deepEqual(result.location, { tabId: "n2", paneId: "n1" });

  const second = apply(result.workspace, { op: "open", sessionId: "s2" });
  assert.deepEqual(second.workspace.tabs.map((x) => sessionsOf(x)), [["s1"], ["s2"]]);
});

test("open of a session already open changes nothing and answers where it is", () => {
  const start = ws(tab("A", pane("p1", "s1")), tab("B", split("sp", "row", [pane("p2", "s2"), pane("p3", "s3")])));
  const result = apply(start, { op: "open", sessionId: "s3" });
  assert.equal(result.changed, false);
  assert.deepEqual(result.location, { tabId: "B", paneId: "p3" });
  assert.deepEqual(result.workspace, start);
  // Even with a target: the session is not duplicated.
  const targeted = apply(start, { op: "open", sessionId: "s1", target: { tabId: "B", paneId: "p2", edge: "right" } });
  assert.equal(targeted.changed, false);
  assert.deepEqual(targeted.location, { tabId: "A", paneId: "p1" });
});

test("open with sessionId null makes a start-page tab, and start pages may repeat", () => {
  const ids = counter();
  const one = apply(EMPTY_WORKSPACE, { op: "open", sessionId: null }, ids);
  const two = apply(one.workspace, { op: "open", sessionId: null }, ids);
  assert.equal(two.changed, true);
  assert.deepEqual(two.workspace.tabs.map(sessionsOf), [[null], [null]]);
  validateWorkspace(two.workspace);
});

test("open with an edge wraps the target pane in a split of the matching direction", () => {
  const start = ws(tab("A", pane("p1", "s1")));
  const right = apply(start, { op: "open", sessionId: "s2", target: { tabId: "A", paneId: "p1", edge: "right" } });
  assert.deepEqual(right.workspace.tabs[0].root, split("n2", "row", [pane("p1", "s1"), pane("n1", "s2")], [50, 50]));
  assert.deepEqual(right.location, { tabId: "A", paneId: "n1" });

  const left = apply(start, { op: "open", sessionId: "s2", target: { tabId: "A", paneId: "p1", edge: "left" } });
  assert.deepEqual(left.workspace.tabs[0].root.children.map((c) => c.sessionId), ["s2", "s1"]);
  assert.equal(left.workspace.tabs[0].root.direction, "row");

  const top = apply(start, { op: "open", sessionId: null, target: { tabId: "A", paneId: "p1", edge: "top" } });
  assert.equal(top.workspace.tabs[0].root.direction, "column");
  assert.deepEqual(top.workspace.tabs[0].root.children.map((c) => c.sessionId), [null, "s1"]);

  const bottom = apply(start, { op: "open", sessionId: "s2", target: { tabId: "A", paneId: "p1", edge: "bottom" } });
  assert.equal(bottom.workspace.tabs[0].root.direction, "column");
  assert.deepEqual(bottom.workspace.tabs[0].root.children.map((c) => c.sessionId), ["s1", "s2"]);
});

test("open with an edge along the parent's direction inserts a sibling that takes half the target's share", () => {
  const start = ws(tab("A", split("sp", "row", [pane("p1", "s1"), pane("p2", "s2")], [50, 50])));
  const right = apply(start, { op: "open", sessionId: "s3", target: { tabId: "A", paneId: "p1", edge: "right" } });
  const root = right.workspace.tabs[0].root;
  assert.equal(root.id, "sp", "no new split: the pane joins the existing row");
  assert.deepEqual(root.children.map((c) => c.sessionId), ["s1", "s3", "s2"]);
  assert.deepEqual(root.sizes, [25, 25, 50]);
  assert.equal(depthOf(root), 1);

  const left = apply(start, { op: "open", sessionId: "s3", target: { tabId: "A", paneId: "p2", edge: "left" } });
  assert.deepEqual(left.workspace.tabs[0].root.children.map((c) => c.sessionId), ["s1", "s3", "s2"]);
  assert.deepEqual(left.workspace.tabs[0].root.sizes, [50, 25, 25]);

  // Across the parent's direction it nests instead.
  const below = apply(start, { op: "open", sessionId: "s3", target: { tabId: "A", paneId: "p1", edge: "bottom" } });
  const nested = below.workspace.tabs[0].root;
  assert.equal(nested.id, "sp");
  assert.deepEqual(nested.sizes, [50, 50]);
  assert.deepEqual(nested.children[0], split("n2", "column", [pane("p1", "s1"), pane("n1", "s3")], [50, 50]));
  assert.equal(depthOf(nested), 2);
  validateWorkspace(below.workspace);
});

test("open refuses a fifth pane and a third level of nesting", () => {
  const four = ws(tab("A", buildPreset("grid-2x2", ["s1", "s2", "s3", "s4"], counter("b"))));
  const [first] = tabPanes(four.tabs[0]);
  throwsCode(() => apply(four, { op: "open", sessionId: "s5", target: { tabId: "A", paneId: first.id, edge: "right" } }), "refused");

  const deep = ws(tab("A", buildPreset("one-beside-two", ["s1", "s2", "s3"], counter("b"))));
  const stacked = tabPanes(deep.tabs[0])[1]; // inside the column; a row edge would nest a third level
  throwsCode(() => apply(deep, { op: "open", sessionId: "s4", target: { tabId: "A", paneId: stacked.id, edge: "right" } }), "refused");
  // The same pane split along its column is a sibling, so it fits.
  const ok = apply(deep, { op: "open", sessionId: "s4", target: { tabId: "A", paneId: stacked.id, edge: "bottom" } });
  assert.deepEqual(sessionsOf(ok.workspace.tabs[0]), ["s1", "s2", "s4", "s3"]);
  validateWorkspace(ok.workspace);
});

test("open with an unknown pane, or a pane in another tab, is not_found", () => {
  const start = ws(tab("A", pane("p1", "s1")), tab("B", pane("p2", "s2")));
  throwsCode(() => apply(start, { op: "open", sessionId: "s3", target: { tabId: "A", paneId: "nope", edge: "right" } }), "not_found");
  throwsCode(() => apply(start, { op: "open", sessionId: "s3", target: { tabId: "A", paneId: "p2", edge: "right" } }), "not_found");
});

// ---------------------------------------------------------------------------------------------
// replace_pane
// ---------------------------------------------------------------------------------------------

test("replace_pane turns a start page into the session's pane", () => {
  const start = ws(tab("A", pane("p1", null)));
  const result = apply(start, { op: "replace_pane", paneId: "p1", sessionId: "s1" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.workspace.tabs[0].root, pane("p1", "s1"));
  assert.deepEqual(result.location, { tabId: "A", paneId: "p1" });
  assert.equal(apply(result.workspace, { op: "replace_pane", paneId: "p1", sessionId: "s1" }).changed, false);
});

test("replace_pane moves a session that is open elsewhere, closing its old pane", () => {
  const start = ws(tab("A", pane("pa", "s1")), tab("B", split("sp", "row", [pane("pb", "s2"), pane("pc", null)])));
  const result = apply(start, { op: "replace_pane", paneId: "pc", sessionId: "s1" });
  assert.deepEqual(result.workspace.tabs.map((t) => t.id), ["B"], "tab A emptied and went away");
  assert.deepEqual(sessionsOf(result.workspace.tabs[0]), ["s2", "s1"]);
  validateWorkspace(result.workspace);

  // Within one tab: the old pane closes and the split collapses onto the target.
  const inner = apply(start, { op: "replace_pane", paneId: "pc", sessionId: "s2" });
  assert.deepEqual(inner.workspace.tabs[1].root, pane("pc", "s2"));
});

test("replace_pane over a session pane is 'open here'", () => {
  const start = ws(tab("A", pane("p1", "s1")));
  const result = apply(start, { op: "replace_pane", paneId: "p1", sessionId: "s9" });
  assert.deepEqual(result.workspace.tabs[0].root, pane("p1", "s9"));
  throwsCode(() => apply(start, { op: "replace_pane", paneId: "zz", sessionId: "s9" }), "not_found");
});

// ---------------------------------------------------------------------------------------------
// arrange
// ---------------------------------------------------------------------------------------------

test("arrange builds every preset in a new tab at the end, filling slots in order and padding with start pages", () => {
  const start = ws(tab("A", pane("p1", "s0")));
  for (const preset of PRESETS) {
    const result = apply(start, { op: "arrange", sessionIds: ["s1"], preset });
    assert.equal(result.workspace.tabs.length, 2, preset);
    const built = result.workspace.tabs[1];
    assert.equal(presetOf(built.root), preset);
    const sessions = sessionsOf(built);
    assert.equal(sessions.length, presetSlotCount(preset), preset);
    assert.deepEqual(sessions, ["s1", ...Array(presetSlotCount(preset) - 1).fill(null)], preset);
    assert.deepEqual(result.location, { tabId: built.id, paneId: tabPanes(built)[0].id });
    assert.equal(built.createdAt, NOW);
    validateWorkspace(result.workspace);
  }
});

test("arrange rejects more sessions than the preset holds, and a session listed twice", () => {
  throwsCode(() => apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: ["a", "b", "c"], preset: "columns-2" }), "invalid");
  throwsCode(() => apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: ["a", "a"], preset: "columns-2" }), "refused");
  throwsCode(() => apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: ["a"], preset: "single", tabId: "ghost" }), "not_found");
  // Two start pages in one list are fine.
  const ok = apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: [null, null], preset: "rows-2" });
  assert.deepEqual(sessionsOf(ok.workspace.tabs[0]), [null, null]);
});

test("arrange moves sessions that are open in other tabs; emptied tabs go, splits collapse", () => {
  const start = ws(tab("A", pane("pa", "s1")), tab("B", split("sb", "row", [pane("pb", "s2"), pane("pc", "s3")])), tab("C", pane("pcc", "s4")));
  const result = apply(start, { op: "arrange", sessionIds: ["s3", "s1"], preset: "columns-2" });
  assert.deepEqual(result.workspace.tabs.map((t) => t.id), ["B", "C", "n4"]);
  assert.deepEqual(result.workspace.tabs[0].root, pane("pb", "s2"), "B collapsed onto its remaining pane");
  assert.deepEqual(sessionsOf(result.workspace.tabs[2]), ["s3", "s1"]);
  validateWorkspace(result.workspace);
});

test("arrange with tabId rebuilds in place, keeping id, createdAt and title", () => {
  const start = ws(tab("A", pane("pa", "s1")), tab("B", pane("pb", "s2"), { title: "Mine", titleSource: "user", createdAt: 42 }), tab("C", pane("pc", "s3")));
  const result = apply(start, { op: "arrange", sessionIds: ["s2", "s1"], preset: "rows-2", tabId: "B" });
  assert.deepEqual(result.workspace.tabs.map((t) => t.id), ["B", "C"], "A emptied; B stays in its slot");
  const b = result.workspace.tabs[0];
  assert.equal(b.title, "Mine");
  assert.equal(b.titleSource, "user");
  assert.equal(b.createdAt, 42);
  assert.equal(presetOf(b.root), "rows-2");
  assert.deepEqual(sessionsOf(b), ["s2", "s1"]);
  assert.deepEqual(result.location, { tabId: "B", paneId: tabPanes(b)[0].id });
});

test("arrange moves sessions the rebuilt tab has no room for into their own tabs right after it", () => {
  const start = ws(tab("A", pane("pa", "s0")), tab("T", buildPreset("columns-3", ["s1", "s2", "s3"], counter("b"))), tab("Z", pane("pz", "s9")));
  const result = apply(start, { op: "arrange", sessionIds: ["s2"], preset: "single", tabId: "T" });
  const tabs = result.workspace.tabs;
  assert.deepEqual(tabs.map((t) => t.id), ["A", "T", "n3", "n5", "Z"]);
  assert.deepEqual(tabs.map(sessionsOf), [["s0"], ["s2"], ["s1"], ["s3"], ["s9"]]);
  assert.equal(tabs[2].title, null);
  assert.equal(tabs[2].createdAt, NOW);
  validateWorkspace(result.workspace);
  // A start page in the old tab is not carried over.
  const withStart = ws(tab("T", split("sp", "row", [pane("p1", "s1"), pane("p2", null)])));
  const dropped = apply(withStart, { op: "arrange", sessionIds: [null], preset: "single", tabId: "T" });
  assert.deepEqual(dropped.workspace.tabs.map(sessionsOf), [[null], ["s1"]]);
});

test("arrange title names the tab as user by default, or as portal; portal never overrides user", () => {
  const user = apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: [], preset: "single", title: "  Review  " });
  assert.equal(user.workspace.tabs[0].title, "Review");
  assert.equal(user.workspace.tabs[0].titleSource, "user");

  const portal = apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: [], preset: "single", title: "Bot", titleSource: "portal" });
  assert.equal(portal.workspace.tabs[0].titleSource, "portal");

  const named = ws(tab("T", pane("p", "s1"), { title: "Mine", titleSource: "user" }));
  throwsCode(() => apply(named, { op: "arrange", sessionIds: ["s1"], preset: "single", tabId: "T", title: "Bot", titleSource: "portal" }), "refused");
  const keep = apply(named, { op: "arrange", sessionIds: ["s1"], preset: "columns-2", tabId: "T", titleSource: "portal" });
  assert.equal(keep.workspace.tabs[0].title, "Mine", "no title given: nothing to refuse");
  const cleared = apply(named, { op: "arrange", sessionIds: ["s1"], preset: "single", tabId: "T", title: "" });
  assert.deepEqual([cleared.workspace.tabs[0].title, cleared.workspace.tabs[0].titleSource], [null, null]);
  throwsCode(() => apply(EMPTY_WORKSPACE, { op: "arrange", sessionIds: [], preset: "single", title: "x".repeat(61) }), "invalid");
});

// ---------------------------------------------------------------------------------------------
// close_tab, close_pane
// ---------------------------------------------------------------------------------------------

test("close_tab removes the tab; unknown is not_found", () => {
  const start = ws(tab("A", pane("p1", "s1")), tab("B", pane("p2", "s2")));
  const result = apply(start, { op: "close_tab", tabId: "A" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.workspace.tabs.map((t) => t.id), ["B"]);
  assert.equal(result.location, undefined);
  throwsCode(() => apply(start, { op: "close_tab", tabId: "Q" }), "not_found");
});

test("close_pane removes the pane and renormalises the split's sizes", () => {
  const start = ws(tab("A", split("sp", "row", [pane("p1", "s1"), pane("p2", "s2"), pane("p3", "s3")], [20, 30, 50])));
  const result = apply(start, { op: "close_pane", paneId: "p1" });
  assert.deepEqual(result.workspace.tabs[0].root, split("sp", "row", [pane("p2", "s2"), pane("p3", "s3")], [37.5, 62.5]));
});

test("close_pane collapses a split left with one child into that child", () => {
  const two = ws(tab("A", split("sp", "row", [pane("p1", "s1"), pane("p2", "s2")])));
  assert.deepEqual(apply(two, { op: "close_pane", paneId: "p2" }).workspace.tabs[0].root, pane("p1", "s1"));

  const grid = ws(tab("A", buildPreset("grid-2x2", ["s1", "s2", "s3", "s4"], counter("b"))));
  const [, , third] = tabPanes(grid.tabs[0]);
  const root = apply(grid, { op: "close_pane", paneId: third.id }).workspace.tabs[0].root;
  assert.equal(root.direction, "column");
  assert.equal(root.children[0].kind, "split");
  assert.deepEqual(root.children[1], pane(tabPanes(grid.tabs[0])[3].id, "s4"), "the bottom row collapsed into its last pane");
  assert.equal(presetOf(root), null);
  validateWorkspace({ tabs: [{ ...grid.tabs[0], root }], version: 0 });
});

test("close_pane removes a tab whose last pane closed; unknown is not_found", () => {
  const start = ws(tab("A", pane("p1", "s1")), tab("B", pane("p2", "s2")));
  const result = apply(start, { op: "close_pane", paneId: "p1" });
  assert.deepEqual(result.workspace.tabs.map((t) => t.id), ["B"]);
  throwsCode(() => apply(start, { op: "close_pane", paneId: "nope" }), "not_found");
});

// ---------------------------------------------------------------------------------------------
// move_tab
// ---------------------------------------------------------------------------------------------

test("move_tab reorders; same index is no change; out of range is invalid", () => {
  const start = ws(tab("A", pane("p1")), tab("B", pane("p2")), tab("C", pane("p3")));
  assert.deepEqual(apply(start, { op: "move_tab", tabId: "A", index: 2 }).workspace.tabs.map((t) => t.id), ["B", "C", "A"]);
  assert.deepEqual(apply(start, { op: "move_tab", tabId: "C", index: 0 }).workspace.tabs.map((t) => t.id), ["C", "A", "B"]);
  assert.deepEqual(apply(start, { op: "move_tab", tabId: "C", index: 1 }).workspace.tabs.map((t) => t.id), ["A", "C", "B"]);
  assert.equal(apply(start, { op: "move_tab", tabId: "B", index: 1 }).changed, false);
  throwsCode(() => apply(start, { op: "move_tab", tabId: "B", index: 3 }), "invalid");
  throwsCode(() => apply(start, { op: "move_tab", tabId: "B", index: -1 }), "invalid");
  throwsCode(() => apply(start, { op: "move_tab", tabId: "B", index: 1.5 }), "invalid");
  throwsCode(() => apply(start, { op: "move_tab", tabId: "Q", index: 0 }), "not_found");
});

// ---------------------------------------------------------------------------------------------
// rename_tab
// ---------------------------------------------------------------------------------------------

test("rename_tab trims, clears on empty or null, and records the source", () => {
  const start = ws(tab("A", pane("p1")));
  const named = apply(start, { op: "rename_tab", tabId: "A", title: "  Review PRs ", source: "user" });
  assert.equal(named.changed, true);
  assert.deepEqual([named.workspace.tabs[0].title, named.workspace.tabs[0].titleSource], ["Review PRs", "user"]);
  assert.equal(apply(named.workspace, { op: "rename_tab", tabId: "A", title: "Review PRs", source: "user" }).changed, false);

  const cleared = apply(named.workspace, { op: "rename_tab", tabId: "A", title: null, source: "user" });
  assert.deepEqual([cleared.workspace.tabs[0].title, cleared.workspace.tabs[0].titleSource], [null, null]);
  const blank = apply(named.workspace, { op: "rename_tab", tabId: "A", title: "   ", source: "user" });
  assert.deepEqual([blank.workspace.tabs[0].title, blank.workspace.tabs[0].titleSource], [null, null]);
  assert.equal(apply(start, { op: "rename_tab", tabId: "A", title: null, source: "user" }).changed, false);
});

test("rename_tab: portal never overwrites or clears a user title; user outranks everything", () => {
  const byUser = ws(tab("A", pane("p1"), { title: "Mine", titleSource: "user" }));
  throwsCode(() => apply(byUser, { op: "rename_tab", tabId: "A", title: "Bot", source: "portal" }), "refused");
  throwsCode(() => apply(byUser, { op: "rename_tab", tabId: "A", title: null, source: "portal" }), "refused");

  const byPortal = ws(tab("A", pane("p1"), { title: "Bot", titleSource: "portal" }));
  assert.equal(apply(byPortal, { op: "rename_tab", tabId: "A", title: "Bot 2", source: "portal" }).workspace.tabs[0].title, "Bot 2");
  const taken = apply(byPortal, { op: "rename_tab", tabId: "A", title: "Mine", source: "user" }).workspace.tabs[0];
  assert.deepEqual([taken.title, taken.titleSource], ["Mine", "user"]);
  // Same text, higher source: a change.
  assert.equal(apply(byPortal, { op: "rename_tab", tabId: "A", title: "Bot", source: "user" }).changed, true);
  const unnamed = ws(tab("A", pane("p1")));
  assert.equal(apply(unnamed, { op: "rename_tab", tabId: "A", title: "Bot", source: "portal" }).workspace.tabs[0].titleSource, "portal");
});

test("rename_tab: 60 characters fit, 61 are invalid; unknown tab is not_found", () => {
  const start = ws(tab("A", pane("p1")));
  assert.equal(apply(start, { op: "rename_tab", tabId: "A", title: "x".repeat(60), source: "user" }).workspace.tabs[0].title.length, 60);
  throwsCode(() => apply(start, { op: "rename_tab", tabId: "A", title: "x".repeat(61), source: "user" }), "invalid");
  assert.equal(apply(start, { op: "rename_tab", tabId: "A", title: " " + "x".repeat(60) + " ", source: "user" }).workspace.tabs[0].title.length, 60, "trimmed first");
  throwsCode(() => apply(start, { op: "rename_tab", tabId: "Q", title: "x", source: "user" }), "not_found");
});

// ---------------------------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------------------------

test("resize normalises and clamps; identical sizes are no change", () => {
  const start = ws(tab("A", split("sp", "row", [pane("p1"), pane("p2")], [50, 50])));
  const result = apply(start, { op: "resize", splitId: "sp", sizes: [1, 3] });
  assert.deepEqual(result.workspace.tabs[0].root.sizes, [25, 75]);
  assert.equal(result.changed, true);
  assert.deepEqual(apply(start, { op: "resize", splitId: "sp", sizes: [1, 99] }).workspace.tabs[0].root.sizes, [10, 90]);
  assert.equal(apply(start, { op: "resize", splitId: "sp", sizes: [50, 50] }).changed, false);
  assert.equal(apply(start, { op: "resize", splitId: "sp", sizes: [7, 7] }).changed, false);

  const nested = ws(tab("A", buildPreset("one-beside-two", ["s1", "s2", "s3"], counter("b"))));
  const inner = nested.tabs[0].root.children[1];
  const deep = apply(nested, { op: "resize", splitId: inner.id, sizes: [30, 70] });
  assert.deepEqual(deep.workspace.tabs[0].root.children[1].sizes, [30, 70]);
  assert.deepEqual(deep.workspace.tabs[0].root.sizes, [50, 50], "the outer split is untouched");
});

test("resize rejects the wrong number of sizes, non-positive sizes, and unknown splits", () => {
  const start = ws(tab("A", split("sp", "row", [pane("p1"), pane("p2")], [50, 50])));
  throwsCode(() => apply(start, { op: "resize", splitId: "sp", sizes: [100] }), "invalid");
  throwsCode(() => apply(start, { op: "resize", splitId: "sp", sizes: [0, 100] }), "invalid");
  throwsCode(() => apply(start, { op: "resize", splitId: "sp", sizes: [-5, 105] }), "invalid");
  throwsCode(() => apply(start, { op: "resize", splitId: "p1", sizes: [50, 50] }), "not_found");
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

test("panesOf, tabPanes, allPanes, locate*, findTab, depthOf", () => {
  const root = split("r", "row", [pane("p1", "s1"), split("c", "column", [pane("p2", null), pane("p3", "s3")])]);
  const workspace = ws(tab("A", pane("p0", "s0")), tab("B", root));
  assert.deepEqual(panesOf(root).map((p) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(tabPanes(workspace.tabs[1]).map((p) => p.id), ["p1", "p2", "p3"]);
  assert.deepEqual(allPanes(workspace).map(({ tabId, pane: p }) => `${tabId}/${p.id}`), ["A/p0", "B/p1", "B/p2", "B/p3"]);
  assert.deepEqual(locateSession(workspace, "s3"), { tabId: "B", paneId: "p3" });
  assert.equal(locateSession(workspace, "zz"), null);
  assert.deepEqual(locatePane(workspace, "p2"), { tabId: "B", pane: pane("p2", null) });
  assert.equal(locatePane(workspace, "zz"), null);
  assert.equal(findTab(workspace, "B"), workspace.tabs[1]);
  assert.equal(findTab(workspace, "Q"), null);
  assert.equal(depthOf(pane("x")), 0);
  assert.equal(depthOf(split("s", "row", [pane("a"), pane("b")])), 1);
  assert.equal(depthOf(root), 2);
});

test("buildPreset makes the six shapes with equal sizes, drawing ids parent first", () => {
  assert.deepEqual(buildPreset("single", ["s1"], counter()), pane("n1", "s1"));
  assert.deepEqual(buildPreset("columns-2", ["s1"], counter()), split("n1", "row", [pane("n2", "s1"), pane("n3", null)], [50, 50]));
  assert.deepEqual(buildPreset("columns-3", [], counter()), split("n1", "row", [pane("n2"), pane("n3"), pane("n4")], [33.34, 33.33, 33.33]));
  assert.deepEqual(buildPreset("rows-2", ["a", "b"], counter()), split("n1", "column", [pane("n2", "a"), pane("n3", "b")], [50, 50]));
  assert.deepEqual(
    buildPreset("grid-2x2", ["a", "b", "c", "d"], counter()),
    split("n1", "column", [split("n2", "row", [pane("n3", "a"), pane("n4", "b")], [50, 50]), split("n5", "row", [pane("n6", "c"), pane("n7", "d")], [50, 50])], [50, 50]),
  );
  assert.deepEqual(
    buildPreset("one-beside-two", ["a", "b", "c"], counter()),
    split("n1", "row", [pane("n2", "a"), split("n3", "column", [pane("n4", "b"), pane("n5", "c")], [50, 50])], [50, 50]),
  );
  throwsCode(() => buildPreset("single", ["a", "b"], counter()), "invalid");
  assert.deepEqual(PRESETS.map(presetSlotCount), [1, 2, 3, 2, 4, 3]);
});

test("presetOf recognises each built preset and nothing else", () => {
  for (const preset of PRESETS) assert.equal(presetOf(buildPreset(preset, [], counter())), preset);
  // Sizes do not matter.
  assert.equal(presetOf(split("r", "row", [pane("a"), pane("b")], [30, 70])), "columns-2");
  assert.equal(presetOf(split("r", "row", [pane("a"), pane("b"), pane("c"), pane("d")])), null);
  assert.equal(presetOf(split("r", "column", [pane("a"), pane("b"), pane("c")])), null);
  assert.equal(presetOf(split("r", "column", [split("x", "row", [pane("a"), pane("b")]), pane("c")])), null);
  assert.equal(presetOf(split("r", "row", [split("x", "column", [pane("a"), pane("b")]), pane("c")])), null, "two-beside-one is not a preset");
  assert.equal(presetOf(split("r", "row", [pane("a"), split("x", "row", [pane("b"), pane("c")])])), null);
});

test("defaultTabTitle follows decision 25", () => {
  const titles = { s1: "Fix login", s2: "Write docs", s3: "Triage" };
  const titleOf = (id) => titles[id] ?? null;
  assert.equal(defaultTabTitle(tab("A", pane("p", null)), titleOf), "New session");
  assert.equal(defaultTabTitle(tab("A", split("s", "row", [pane("p"), pane("q")])), titleOf), "New session");
  assert.equal(defaultTabTitle(tab("A", pane("p", "s1")), titleOf), "Fix login");
  assert.equal(defaultTabTitle(tab("A", split("s", "row", [pane("p", "s1"), pane("q", null)])), titleOf), "Fix login");
  assert.equal(defaultTabTitle(tab("A", split("s", "row", [pane("p", "s1"), pane("q", "s2")])), titleOf), "Fix login + Write docs");
  assert.equal(defaultTabTitle(tab("A", buildPreset("columns-3", ["s1", "s2", "s3"], counter("b"))), titleOf), "3 sessions");
  assert.equal(defaultTabTitle(tab("A", buildPreset("grid-2x2", ["s1", "s2", "s3", "s9"], counter())), titleOf), "4 sessions");
  assert.equal(defaultTabTitle(tab("A", pane("p", "s9")), titleOf), "Untitled");
  assert.equal(defaultTabTitle(tab("A", pane("p", "s1"), { title: "Mine", titleSource: "user" }), titleOf), "Mine");
  assert.equal(defaultTabTitle(tab("A", pane("p", "s1"), { title: "Bot", titleSource: "portal" }), titleOf), "Bot");
});

test("normalizeSizes scales to 100, pins small entries at 10, and falls back to an equal split", () => {
  assert.deepEqual(normalizeSizes([1, 1], 2), [50, 50]);
  assert.deepEqual(normalizeSizes([1, 3], 2), [25, 75]);
  assert.deepEqual(normalizeSizes([1, 99], 2), [10, 90]);
  assert.deepEqual(normalizeSizes([1, 1, 98], 3), [10, 10, 80]);
  assert.deepEqual(normalizeSizes([5, 15, 80], 3), [10, 14.21, 75.79], "the rest share what is left in proportion");
  assert.deepEqual(normalizeSizes([], 3), [33.34, 33.33, 33.33]);
  assert.deepEqual(normalizeSizes([50, 50], 3), [33.34, 33.33, 33.33]);
  assert.deepEqual(normalizeSizes([NaN, 1], 2), [50, 50]);
  assert.deepEqual(normalizeSizes([0, 1], 2), [50, 50]);
  assert.deepEqual(normalizeSizes([-1, 1], 2), [50, 50]);
  assert.deepEqual(normalizeSizes([], 0), []);
  for (const input of [[1, 2, 3, 4], [97, 1, 1, 1], [0.001, 50, 50]]) {
    const out = normalizeSizes(input, input.length);
    assert.equal(Math.round(out.reduce((a, b) => a + b, 0) * 100) / 100, 100, String(input));
    assert.ok(out.every((s) => s >= 10), String(input));
  }
});

// ---------------------------------------------------------------------------------------------
// validateWorkspace
// ---------------------------------------------------------------------------------------------

test("validateWorkspace accepts what the reducer makes", () => {
  let workspace = EMPTY_WORKSPACE;
  const ids = counter();
  const step = (op) => (workspace = applyWorkspaceOp(workspace, op, ids, NOW).workspace);
  step({ op: "open", sessionId: "s1" });
  step({ op: "open", sessionId: "s2", target: { tabId: workspace.tabs[0].id, paneId: tabPanes(workspace.tabs[0])[0].id, edge: "right" } });
  step({ op: "open", sessionId: "s3", target: { tabId: workspace.tabs[0].id, paneId: tabPanes(workspace.tabs[0])[1].id, edge: "bottom" } });
  step({ op: "arrange", sessionIds: ["s4", "s5", "s6", "s3"], preset: "grid-2x2", title: "Grid" });
  step({ op: "open", sessionId: null });
  assert.doesNotThrow(() => validateWorkspace(workspace));
  assert.doesNotThrow(() => validateWorkspace(EMPTY_WORKSPACE));
  assert.doesNotThrow(() => validateWorkspace(JSON.parse(JSON.stringify(workspace))));
});

test("validateWorkspace throws invalid on every invariant violation", () => {
  const bad = (workspace, label) => throwsCode(() => validateWorkspace(workspace), "invalid", label);
  bad(null);
  bad({ tabs: {} });
  bad({ tabs: [], version: -1 });
  bad({ tabs: [], version: 1.5 });
  bad(ws(tab("A", pane("p1", "s1")), tab("B", pane("p2", "s1"))), "duplicate session");
  bad(ws(tab("A", split("r", "row", [pane("a"), pane("b"), pane("c"), pane("d"), pane("e")], [20, 20, 20, 20, 20]))), "5 panes");
  bad(ws(tab("A", split("r", "row", [pane("a"), split("c", "column", [pane("b"), split("d", "row", [pane("e"), pane("f")])])]))), "depth 3");
  bad(ws(tab("A", split("r", "row", [pane("a")], [100]))), "split with one child");
  bad(ws(tab("A", split("r", "row", [pane("a"), pane("b")], [100]))), "sizes count");
  bad(ws(tab("A", split("r", "row", [pane("a"), pane("b")], [5, 95]))), "size under 10");
  bad(ws(tab("A", split("r", "row", [pane("a"), pane("b")], [50, 60]))), "sizes sum");
  bad(ws(tab("A", split("r", "diagonal", [pane("a"), pane("b")]))), "direction");
  bad(ws(tab("A", pane("p")), tab("A", pane("q"))), "duplicate tab id");
  bad(ws(tab("A", split("r", "row", [pane("p"), pane("p")]))), "duplicate pane id");
  bad(ws(tab("A", split("A", "row", [pane("p"), pane("q")]))), "split id equal to a tab id");
  bad(ws(tab("A", pane("p"), { title: "Named", titleSource: null })), "title without source");
  bad(ws(tab("A", pane("p"), { title: null, titleSource: "user" })), "source without title");
  bad(ws(tab("A", pane("p"), { title: "x".repeat(61), titleSource: "user" })), "title too long");
  bad(ws(tab("A", pane("p"), { title: "  ", titleSource: "user" })), "blank title");
  bad(ws(tab("A", pane("p"), { createdAt: "yesterday" })), "createdAt");
  bad(ws(tab("A", { kind: "blob", id: "x" })), "node kind");
  bad(ws(tab("A", pane("", "s1"))), "empty id");
  bad(ws(tab("A", pane("p", 7))), "sessionId type");
});

// ---------------------------------------------------------------------------------------------
// parseWorkspaceOp
// ---------------------------------------------------------------------------------------------

test("parseWorkspaceOp accepts each op and answers a fresh object with only the known fields", () => {
  const cases = [
    [{ op: "open", sessionId: "s1", extra: 1 }, { op: "open", sessionId: "s1" }],
    [{ op: "open", sessionId: null, target: null }, { op: "open", sessionId: null }],
    [{ op: "open" }, { op: "open", sessionId: null }],
    [
      { op: "open", sessionId: "s1", target: { tabId: "A", paneId: "p", edge: "left", junk: true } },
      { op: "open", sessionId: "s1", target: { tabId: "A", paneId: "p", edge: "left" } },
    ],
    [{ op: "replace_pane", paneId: "p", sessionId: "s" }, { op: "replace_pane", paneId: "p", sessionId: "s" }],
    [{ op: "arrange", sessionIds: ["a", null], preset: "columns-2", tabId: null, title: null }, { op: "arrange", sessionIds: ["a", null], preset: "columns-2" }],
    [
      { op: "arrange", sessionIds: [], preset: "single", tabId: "T", title: "Hi", titleSource: "portal" },
      { op: "arrange", sessionIds: [], preset: "single", tabId: "T", title: "Hi", titleSource: "portal" },
    ],
    [{ op: "close_tab", tabId: "T" }, { op: "close_tab", tabId: "T" }],
    [{ op: "close_pane", paneId: "p" }, { op: "close_pane", paneId: "p" }],
    [{ op: "move_tab", tabId: "T", index: 0 }, { op: "move_tab", tabId: "T", index: 0 }],
    [{ op: "rename_tab", tabId: "T", title: "x", source: "user" }, { op: "rename_tab", tabId: "T", title: "x", source: "user" }],
    [{ op: "rename_tab", tabId: "T", source: "portal" }, { op: "rename_tab", tabId: "T", title: null, source: "portal" }],
    [{ op: "resize", splitId: "s", sizes: [30, 70] }, { op: "resize", splitId: "s", sizes: [30, 70] }],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseWorkspaceOp(freeze(structuredClone(input)));
    assert.deepEqual(parsed, expected, JSON.stringify(input));
    assert.notEqual(parsed, input);
  }
  const input = { op: "resize", splitId: "s", sizes: [30, 70] };
  assert.notEqual(parseWorkspaceOp(input).sizes, input.sizes, "arrays are copied");
});

test("parseWorkspaceOp rejects malformed input with invalid", () => {
  const rejects = [
    undefined,
    null,
    "open",
    [],
    {},
    { op: "explode" },
    { op: "open", sessionId: 5 },
    { op: "open", sessionId: "" },
    { op: "open", sessionId: "s", target: "right" },
    { op: "open", sessionId: "s", target: { tabId: "A", paneId: "p", edge: "diagonal" } },
    { op: "open", sessionId: "s", target: { tabId: "A", edge: "left" } },
    { op: "replace_pane", paneId: "p" },
    { op: "replace_pane", paneId: "p", sessionId: null },
    { op: "arrange", sessionIds: ["a"], preset: "hex" },
    { op: "arrange", sessionIds: "a", preset: "single" },
    { op: "arrange", sessionIds: ["a", "b", "c", "d", "e"], preset: "grid-2x2" },
    { op: "arrange", sessionIds: [1], preset: "single" },
    { op: "arrange", sessionIds: [], preset: "single", title: 9 },
    { op: "arrange", sessionIds: [], preset: "single", titleSource: "system" },
    { op: "arrange", sessionIds: [], preset: "single", tabId: 3 },
    { op: "close_tab" },
    { op: "close_pane", paneId: 1 },
    { op: "move_tab", tabId: "T", index: -1 },
    { op: "move_tab", tabId: "T", index: 1.5 },
    { op: "move_tab", tabId: "T", index: "2" },
    { op: "rename_tab", tabId: "T", title: "x" },
    { op: "rename_tab", tabId: "T", title: 4, source: "user" },
    { op: "rename_tab", tabId: "T", title: "x", source: "agent" },
    { op: "resize", splitId: "s", sizes: [] },
    { op: "resize", splitId: "s", sizes: [50, "50"] },
    { op: "resize", splitId: "s", sizes: [50, Infinity] },
    { op: "resize", sizes: [50, 50] },
  ];
  for (const input of rejects) throwsCode(() => parseWorkspaceOp(input), "invalid", JSON.stringify(input));
});

// ---------------------------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------------------------

test("the reducer never mutates its input, shares untouched tabs, and leaves version alone", () => {
  const start = ws(tab("A", split("sa", "row", [pane("p1", "s1"), pane("p2", "s2")], [40, 60])), tab("B", pane("p3", "s3")));
  const snapshot = structuredClone(start);
  const ids = counter();
  const ops = [
    { op: "open", sessionId: "s4" },
    { op: "open", sessionId: "s5", target: { tabId: "A", paneId: "p2", edge: "bottom" } },
    { op: "replace_pane", paneId: "p3", sessionId: "s1" },
    { op: "arrange", sessionIds: ["s3", "s2"], preset: "columns-2", tabId: "A", title: "Pair" },
    { op: "rename_tab", tabId: "B", title: "Solo", source: "portal" },
    { op: "resize", splitId: "sa", sizes: [70, 30] },
    { op: "move_tab", tabId: "B", index: 0 },
    { op: "close_pane", paneId: "p1" },
    { op: "close_tab", tabId: "B" },
  ];
  for (const op of ops) {
    const result = applyWorkspaceOp(start, op, ids, NOW);
    assert.deepEqual(start, snapshot, op.op);
    assert.equal(result.workspace.version, 3, op.op);
    if (result.changed) assert.notEqual(result.workspace, start, op.op);
    validateWorkspace(result.workspace);
  }
  const opened = applyWorkspaceOp(start, { op: "open", sessionId: "s9" }, ids, NOW).workspace;
  assert.equal(opened.tabs[0], start.tabs[0], "untouched tabs are shared, not copied");
  assert.equal(opened.tabs[1], start.tabs[1]);
});
