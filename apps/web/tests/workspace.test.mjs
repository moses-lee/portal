import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkspaceOp, EMPTY_WORKSPACE } from "@portal/shared/workspace";
import {
  advancedSessions,
  arrangeOp,
  canSplitPane,
  flatPanes,
  iconCells,
  idAliases,
  layoutOf,
  mountedTabIds,
  neighbourTab,
  paneInPath,
  paneTitle,
  rememberFocused,
  resolveFocus,
  resolveRoute,
  sameSizes,
  signalsOf,
  sizesFromLayout,
  startPaneLocation,
  tabTitle,
  unreadAfter,
  unreadTabIds,
  visiblePaneIds,
  withoutUnread,
} from "../src/lib/workspace.ts";

/** Deterministic ids: t1, t2, ... */
function ids() {
  let n = 0;
  return () => `n${++n}`;
}

/** A workspace from a list of ops, applied in order with deterministic ids. */
function build(ops) {
  const next = ids();
  return ops.reduce((ws, op) => applyWorkspaceOp(ws, op, next, 1000).workspace, EMPTY_WORKSPACE);
}

const sessions = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
  { id: "c", title: "" },
];

test("tab names: the session title, A + B, N sessions, New session, and a rename on top", () => {
  const ws = build([
    { op: "open", sessionId: "a" },
    { op: "arrange", sessionIds: ["b", "c"], preset: "columns-2" },
    { op: "arrange", sessionIds: ["a", "b", "c"], preset: "columns-3" },
    { op: "open", sessionId: null },
  ]);
  // The columns-3 arrange moved a, b and c out of their earlier tabs, which went away.
  assert.deepEqual(ws.tabs.map((tab) => tabTitle(tab, sessions)), ["3 sessions", "New session"]);
  const two = build([{ op: "arrange", sessionIds: ["b", "c"], preset: "columns-2" }]);
  assert.equal(tabTitle(two.tabs[0], sessions), "Beta + Untitled");
  const renamed = applyWorkspaceOp(two, { op: "rename_tab", tabId: two.tabs[0].id, title: "Review", source: "user" }, ids()).workspace;
  assert.equal(tabTitle(renamed.tabs[0], sessions), "Review");
  // A pane's own name: its session's title, Untitled, or New session; a tab's rename does not reach it.
  assert.deepEqual(flatPanes(renamed).map(({ pane }) => paneTitle(pane, sessions)), ["Beta", "Untitled"]);
  assert.equal(paneTitle(ws.tabs[1].root, sessions), "New session");
});

test("icon cells divide the box equally by the tree's shape, in reading order", () => {
  const ws = build([{ op: "arrange", sessionIds: ["a", "b", null], preset: "one-beside-two" }]);
  const cells = iconCells(ws.tabs[0].root);
  assert.deepEqual(
    cells.map(({ sessionId, x, y, width, height }) => ({ sessionId, x, y, width, height })),
    [
      { sessionId: "a", x: 0, y: 0, width: 50, height: 100 },
      { sessionId: "b", x: 50, y: 0, width: 50, height: 50 },
      { sessionId: null, x: 50, y: 50, width: 50, height: 50 },
    ],
  );
  const single = build([{ op: "open", sessionId: "a" }]);
  assert.deepEqual(iconCells(single.tabs[0].root).map((c) => [c.x, c.y, c.width, c.height]), [[0, 0, 100, 100]]);
  const grid = build([{ op: "arrange", sessionIds: ["a", "b", "c"], preset: "grid-2x2" }]);
  assert.deepEqual(iconCells(grid.tabs[0].root).map((c) => [c.x, c.y]), [[0, 0], [50, 0], [0, 50], [50, 50]]);
});

test("the flat pane list is tab order then tree order", () => {
  const ws = build([
    { op: "arrange", sessionIds: ["a", "b"], preset: "rows-2" },
    { op: "open", sessionId: "c" },
  ]);
  assert.deepEqual(flatPanes(ws).map(({ pane }) => pane.sessionId), ["a", "b", "c"]);
  assert.deepEqual(flatPanes(ws).map(({ tabId }) => tabId), [ws.tabs[0].id, ws.tabs[0].id, ws.tabs[1].id]);
});

test("focus resolution: the named pane when the tab holds it, else the first pane; nothing for a missing tab", () => {
  const ws = build([{ op: "arrange", sessionIds: ["a", "b"], preset: "columns-2" }]);
  const tab = ws.tabs[0];
  const [first, second] = tab.root.children;
  assert.equal(resolveFocus(ws, tab.id, second.id).pane, second);
  assert.equal(resolveFocus(ws, tab.id, "nope").pane, first);
  assert.equal(resolveFocus(ws, tab.id, null).pane, first);
  assert.deepEqual(resolveFocus(ws, "gone", null), { tab: null, pane: null });
  assert.deepEqual(resolveFocus(ws, null, null), { tab: null, pane: null });
  assert.equal(paneInPath(ws, { tabId: tab.id, paneId: first.id }), true);
  const single = build([{ op: "open", sessionId: "a" }]);
  assert.equal(paneInPath(single, { tabId: single.tabs[0].id, paneId: single.tabs[0].root.id }), false);
});

test("resolvers: a session focuses its pane or opens a tab; /new focuses a start page, opens one, or stays while empty", () => {
  assert.deepEqual(resolveRoute(EMPTY_WORKSPACE, { kind: "start" }), { kind: "stay" });
  assert.deepEqual(resolveRoute(EMPTY_WORKSPACE, { kind: "session", sessionId: "a" }), { kind: "open", op: { op: "open", sessionId: "a" } });
  const ws = build([{ op: "open", sessionId: "a" }, { op: "open", sessionId: null }]);
  assert.deepEqual(resolveRoute(ws, { kind: "session", sessionId: "a" }), {
    kind: "focus",
    location: { tabId: ws.tabs[0].id, paneId: ws.tabs[0].root.id },
  });
  assert.deepEqual(resolveRoute(ws, { kind: "session", sessionId: "zzz" }), { kind: "open", op: { op: "open", sessionId: "zzz" } });
  assert.deepEqual(resolveRoute(ws, { kind: "start" }), { kind: "focus", location: startPaneLocation(ws) });
  assert.deepEqual(startPaneLocation(ws), { tabId: ws.tabs[1].id, paneId: ws.tabs[1].root.id });
  const noStart = build([{ op: "open", sessionId: "a" }]);
  assert.deepEqual(resolveRoute(noStart, { kind: "start" }), { kind: "open", op: { op: "open", sessionId: null } });
});

test("arrange from a tab lists only as many sessions as the preset holds, so the rest overflow to new tabs", () => {
  const ws = build([{ op: "arrange", sessionIds: ["a", "b", "c"], preset: "columns-3" }]);
  const tab = ws.tabs[0];
  assert.deepEqual(arrangeOp(tab, "columns-2"), { op: "arrange", tabId: tab.id, preset: "columns-2", sessionIds: ["a", "b"] });
  assert.deepEqual(arrangeOp(tab, "grid-2x2").sessionIds, ["a", "b", "c"]);
  const after = applyWorkspaceOp(ws, arrangeOp(tab, "single"), ids()).workspace;
  assert.deepEqual(after.tabs.map((t) => flatPanes({ tabs: [t], version: 0 }).map(({ pane }) => pane.sessionId)), [["a"], ["b"], ["c"]]);
});

test("canSplitPane says no where the reducer would refuse: a full tab, or a third level of nesting", () => {
  const grid = build([{ op: "arrange", sessionIds: ["a", "b"], preset: "grid-2x2" }]);
  const [g] = grid.tabs;
  for (const { pane } of flatPanes(grid)) {
    assert.equal(canSplitPane(grid, g.id, pane.id, "right"), false);
    assert.equal(canSplitPane(grid, g.id, pane.id, "bottom"), false);
  }
  const beside = build([{ op: "arrange", sessionIds: ["a", "b", "c"], preset: "one-beside-two" }]);
  const [t] = beside.tabs;
  const [p1, p2] = flatPanes(beside).map(({ pane }) => pane);
  // p1 under the root row: a sibling to its right, or a column in its place, both fit.
  assert.equal(canSplitPane(beside, t.id, p1.id, "right"), true);
  assert.equal(canSplitPane(beside, t.id, p1.id, "bottom"), true);
  // p2 in the column under the row: another row inside would be three deep; a sibling below fits.
  assert.equal(canSplitPane(beside, t.id, p2.id, "right"), false);
  assert.equal(canSplitPane(beside, t.id, p2.id, "bottom"), true);
  // Unknown ids are a refusal too, not a throw.
  assert.equal(canSplitPane(beside, t.id, "gone", "right"), false);
});

test("the neighbour of a closing tab is the one to its right, else its left", () => {
  const ws = build([{ op: "open", sessionId: "a" }, { op: "open", sessionId: "b" }, { op: "open", sessionId: "c" }]);
  const [t1, t2, t3] = ws.tabs;
  assert.equal(neighbourTab(ws, t1.id), t2);
  assert.equal(neighbourTab(ws, t2.id), t3);
  assert.equal(neighbourTab(ws, t3.id), t2);
  assert.equal(neighbourTab(ws, "gone"), null);
  assert.equal(neighbourTab(build([{ op: "open", sessionId: "a" }]), build([{ op: "open", sessionId: "a" }]).tabs[0].id), null);
});

test("unread: a turn ending or a permission request in a session whose pane the device does not show marks the pane; showing it clears it", () => {
  const ws = build([
    { op: "open", sessionId: "a" },
    { op: "arrange", sessionIds: ["b", "d"], preset: "columns-2" },
    { op: "open", sessionId: null },
  ]);
  const [tabA, tabBD] = ws.tabs;
  const paneA = tabA.root.id;
  const [paneB, paneD] = tabBD.root.children.map((child) => child.id);
  const before = signalsOf([
    { id: "a", turnEndedAt: null, awaitingPermission: false },
    { id: "b", turnEndedAt: 100, awaitingPermission: false },
    { id: "d", turnEndedAt: 100, awaitingPermission: false },
  ]);
  // The first load is not news.
  assert.deepEqual(advancedSessions(new Map(), before), []);
  // Nothing changed.
  assert.deepEqual(advancedSessions(before, before), []);
  const after = signalsOf([
    { id: "a", turnEndedAt: 200, awaitingPermission: false },
    { id: "b", turnEndedAt: 100, awaitingPermission: true },
    { id: "c", turnEndedAt: 300, awaitingPermission: false },
    { id: "d", turnEndedAt: 100, awaitingPermission: false },
  ]);
  assert.deepEqual(advancedSessions(before, after), ["a", "b"]);
  // A later turn end counts again; an older or equal time does not.
  assert.deepEqual(advancedSessions(after, signalsOf([{ id: "a", turnEndedAt: 250, awaitingPermission: false }])), ["a"]);
  assert.deepEqual(advancedSessions(after, signalsOf([{ id: "a", turnEndedAt: 200, awaitingPermission: false }])), []);
  // Permission answered: not news.
  assert.deepEqual(advancedSessions(after, signalsOf([{ id: "b", turnEndedAt: 100, awaitingPermission: false }])), []);

  // What a device shows: a whole tab (desktop), one pane (phone, or a tablet tab too big for a split), nothing off the workspace.
  assert.deepEqual([...visiblePaneIds(ws, tabBD.id, null)], [paneB, paneD]);
  assert.deepEqual([...visiblePaneIds(ws, tabBD.id, paneD)], [paneD]);
  assert.deepEqual([...visiblePaneIds(ws, null, null)], []);
  assert.deepEqual([...visiblePaneIds(ws, "gone", null)], []);

  const none = new Set();
  // Looking at tab A: b's pane is marked, a's is shown, c is not open.
  const marked = unreadAfter(none, ws, ["a", "b", "c"], visiblePaneIds(ws, tabA.id, null));
  assert.deepEqual([...marked], [paneB]);
  // Same set back when nothing changes.
  assert.equal(unreadAfter(marked, ws, ["a", "b", "c"], visiblePaneIds(ws, tabA.id, null)), marked);
  assert.equal(unreadAfter(none, ws, [], new Set()), none);
  // Off the workspace (a Portal page): every open session's pane counts.
  assert.deepEqual([...unreadAfter(none, ws, ["a", "b"], new Set())].sort(), [paneA, paneB].sort());
  // On a phone showing d: b is in the same tab but hidden, so it is marked; d is not.
  assert.deepEqual([...unreadAfter(none, ws, ["b", "d"], visiblePaneIds(ws, tabBD.id, paneD))], [paneB]);
  // On a desktop showing the whole tab, neither is.
  assert.equal(unreadAfter(none, ws, ["b", "d"], visiblePaneIds(ws, tabBD.id, null)), none);

  // The strip's ring: a tab with any unread pane.
  assert.deepEqual([...unreadTabIds(ws, marked)], [tabBD.id]);
  assert.deepEqual([...unreadTabIds(ws, none)], []);
  // Showing panes reads them; the same set when none was marked.
  assert.deepEqual([...withoutUnread(marked, visiblePaneIds(ws, tabBD.id, null))], []);
  assert.deepEqual([...withoutUnread(marked, [paneD])], [paneB]);
  assert.equal(withoutUnread(marked, visiblePaneIds(ws, tabA.id, null)), marked);
  assert.equal(withoutUnread(marked, []), marked);
});

test("mounting: the focused tab plus the 3 most recently focused that still exist, in strip order", () => {
  const ws = build([
    { op: "open", sessionId: "a" },
    { op: "open", sessionId: "b" },
    { op: "open", sessionId: "c" },
    { op: "open", sessionId: null },
    { op: "open", sessionId: "e" },
    { op: "open", sessionId: "f" },
  ]);
  const [t1, t2, t3, t4, t5, t6] = ws.tabs.map((tab) => tab.id);
  let recent = [];
  for (const id of [t1, t2, t3, t4, t5, t6]) recent = rememberFocused(recent, id);
  assert.deepEqual(recent, [t6, t5, t4, t3, t2, t1]);
  assert.deepEqual(mountedTabIds(ws, t6, recent), [t3, t4, t5, t6]);
  // Focusing t1 again: t1 first, and the oldest hidden one (t3) drops out.
  recent = rememberFocused(recent, t1);
  assert.deepEqual(mountedTabIds(ws, t1, recent), [t1, t4, t5, t6]);
  // A closed tab in the history is skipped; the cap counts existing tabs.
  const without = { ...ws, tabs: ws.tabs.filter((tab) => tab.id !== t6) };
  assert.deepEqual(mountedTabIds(without, t1, recent), [t1, t3, t4, t5]);
  assert.deepEqual(mountedTabIds(ws, null, recent), [t1, t5, t6]);
  assert.deepEqual(mountedTabIds(ws, "gone", []), []);
  assert.deepEqual(rememberFocused(recent, null), recent);
  assert.equal(rememberFocused([], "x", 2).length, 1);
  assert.deepEqual(rememberFocused(["b", "c"], "a", 2), ["a", "b"]);
});

test("split sizes round-trip through the panel library's layout", () => {
  const ws = build([{ op: "arrange", sessionIds: ["a", "b", "c"], preset: "columns-3" }]);
  const split = ws.tabs[0].root;
  const [p1, p2, p3] = split.children.map((child) => child.id);
  assert.deepEqual(layoutOf(split), { [p1]: 33.34, [p2]: 33.33, [p3]: 33.33 });
  assert.deepEqual(sizesFromLayout(split, { [p1]: 50, [p2]: 25, [p3]: 25 }), [50, 25, 25]);
  // A child the layout lacks keeps its stored size.
  assert.deepEqual(sizesFromLayout(split, { [p1]: 50 }), [50, 33.33, 33.33]);
  assert.equal(sameSizes([33.33, 33.33, 33.34], [33.333, 33.333, 33.334]), true);
  assert.equal(sameSizes([50, 50], [60, 40]), false);
  assert.equal(sameSizes([50, 50], [100]), false);
});

test("id aliases pair the server's ids with the optimistic ones by position, so keys survive adoption", () => {
  const base = build([{ op: "open", sessionId: "a" }]);
  const op = { op: "open", sessionId: "b", target: { tabId: base.tabs[0].id, paneId: base.tabs[0].root.id, edge: "right" } };
  let n = 0;
  const optimistic = applyWorkspaceOp(base, op, () => `tmp-${n++}`, 1000).workspace;
  const server = { ...applyWorkspaceOp(base, op, () => `real-${n++}`, 1000).workspace, version: 1 };
  const aliases = idAliases(optimistic, server);
  const serverSplit = server.tabs[0].root;
  const optimisticSplit = optimistic.tabs[0].root;
  assert.equal(aliases.get(serverSplit.id), optimisticSplit.id);
  assert.equal(aliases.get(serverSplit.children[1].id), optimisticSplit.children[1].id);
  // The pane that existed before keeps its id on both sides: no alias.
  assert.equal(aliases.has(serverSplit.children[0].id), false);
  // A new tab too.
  const opened = applyWorkspaceOp(base, { op: "open", sessionId: "c" }, () => `tmp-${n++}`, 1000).workspace;
  const openedServer = applyWorkspaceOp(base, { op: "open", sessionId: "c" }, () => `real-${n++}`, 1000).workspace;
  const tabAliases = idAliases(opened, openedServer);
  assert.equal(tabAliases.get(openedServer.tabs[1].id), opened.tabs[1].id);
  assert.equal(tabAliases.get(openedServer.tabs[1].root.id), opened.tabs[1].root.id);
  // Shapes that disagree (another device changed things meanwhile) alias nothing below the disagreement.
  const other = build([{ op: "arrange", sessionIds: ["a", "b", "c"], preset: "columns-3" }]);
  assert.equal(idAliases(optimistic, other).size, 1);
});
