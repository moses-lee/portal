import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkspaceOp, EMPTY_WORKSPACE } from "@portal/shared/workspace";
import {
  advancedSessions,
  arrangeOp,
  canSplitPane,
  closeSizes,
  flatPanes,
  iconCells,
  idAliases,
  layoutOf,
  mountedTabIds,
  neighbourTab,
  opIds,
  paneInPath,
  paneTitle,
  rememberFocused,
  replayIds,
  resolveFocus,
  rewriteOpIds,
  resolveRoute,
  sameCells,
  signalsOf,
  sizesFromLayout,
  startPaneIn,
  staysInTab,
  tabCells,
  tabTitle,
  unreadAfter,
  unreadTabIds,
  visiblePaneIds,
  withoutUnread,
} from "../src/lib/workspace.ts";
import { startKey } from "../src/lib/drafts.ts";

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

test("tab names: the session title, A + B, N sessions, New session, and a rename on top; untitled reads as the sidebar does", () => {
  const ws = build([
    { op: "open", sessionId: "a" },
    { op: "arrange", sessionIds: ["b", "c"], preset: "columns-2" },
    { op: "arrange", sessionIds: ["a", "b", "c"], preset: "columns-3" },
    { op: "open", sessionId: null },
  ]);
  // The columns-3 arrange moved a, b and c out of their earlier tabs, which went away.
  assert.deepEqual(ws.tabs.map((tab) => tabTitle(tab, sessions)), ["3 sessions", "New session"]);
  const two = build([{ op: "arrange", sessionIds: ["b", "c"], preset: "columns-2" }]);
  // An untitled session is "New conversation" everywhere (the sidebar's word), never the shared fallback "Untitled".
  assert.equal(tabTitle(two.tabs[0], sessions), "Beta + New conversation");
  assert.equal(tabTitle(build([{ op: "open", sessionId: "unknown" }]).tabs[0], sessions), "New conversation");
  const renamed = applyWorkspaceOp(two, { op: "rename_tab", tabId: two.tabs[0].id, title: "Review", source: "user" }, ids()).workspace;
  assert.equal(tabTitle(renamed.tabs[0], sessions), "Review");
  // A pane's own name: its session's title, New conversation, or New session; a tab's rename does not reach it.
  assert.deepEqual(flatPanes(renamed).map(({ pane }) => paneTitle(pane, sessions)), ["Beta", "New conversation"]);
  assert.equal(paneTitle(ws.tabs[1].root, sessions), "New session");
});

test("tab cells carry each pane's state, and compare by value so a memoised tab item can skip renders", () => {
  const ws = build([{ op: "arrange", sessionIds: ["a", null], preset: "columns-2" }]);
  const stateOf = (id) => (id === "a" ? "busy" : null);
  const cells = tabCells(ws.tabs[0].root, stateOf);
  assert.deepEqual(cells.map(({ sessionId, state }) => ({ sessionId, state })), [{ sessionId: "a", state: "busy" }, { sessionId: null, state: null }]);
  assert.equal(sameCells(cells, tabCells(ws.tabs[0].root, stateOf)), true);
  assert.equal(sameCells(cells, tabCells(ws.tabs[0].root, () => "finished")), false);
  assert.equal(sameCells(cells, cells.slice(0, 1)), false);
  assert.equal(sameCells([], []), true);
});

test("a start page's draft key is per pane, and `new` for the bare start page", () => {
  assert.equal(startKey(null), "new");
  assert.equal(startKey("p1"), "new:p1");
  assert.notEqual(startKey("p1"), startKey("p2"));
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

test("resolvers: a session focuses its pane or opens a tab; /new reuses a start page only in the focused tab, else opens one, or stays while empty", () => {
  assert.deepEqual(resolveRoute(EMPTY_WORKSPACE, { kind: "start" }), { kind: "stay" });
  assert.deepEqual(resolveRoute(EMPTY_WORKSPACE, { kind: "session", sessionId: "a" }), { kind: "open", op: { op: "open", sessionId: "a" } });
  const ws = build([{ op: "open", sessionId: "a" }, { op: "open", sessionId: null }]);
  assert.deepEqual(resolveRoute(ws, { kind: "session", sessionId: "a" }), {
    kind: "focus",
    location: { tabId: ws.tabs[0].id, paneId: ws.tabs[0].root.id },
  });
  assert.deepEqual(resolveRoute(ws, { kind: "session", sessionId: "zzz" }), { kind: "open", op: { op: "open", sessionId: "zzz" } });
  const [sessionTab, startTab] = ws.tabs;
  assert.deepEqual(startPaneIn(startTab), { tabId: startTab.id, paneId: startTab.root.id });
  assert.equal(startPaneIn(sessionTab), null);
  // `/new` focuses an existing start pane: the focused tab's first, else the first anywhere (decision 7).
  assert.deepEqual(resolveRoute(ws, { kind: "start" }, startTab.id), { kind: "focus", location: startPaneIn(startTab) });
  assert.deepEqual(resolveRoute(ws, { kind: "start" }, sessionTab.id), { kind: "focus", location: startPaneIn(startTab) });
  assert.deepEqual(resolveRoute(ws, { kind: "start" }), { kind: "focus", location: startPaneIn(startTab) });
  assert.deepEqual(resolveRoute(ws, { kind: "start" }, "gone"), { kind: "focus", location: startPaneIn(startTab) });
  // A split with a start pane in the focused tab: that pane.
  const split = build([{ op: "arrange", sessionIds: ["a", null], preset: "columns-2" }]);
  assert.deepEqual(resolveRoute(split, { kind: "start" }, split.tabs[0].id), {
    kind: "focus",
    location: { tabId: split.tabs[0].id, paneId: split.tabs[0].root.children[1].id },
  });
  const noStart = build([{ op: "open", sessionId: "a" }]);
  assert.deepEqual(resolveRoute(noStart, { kind: "start" }, noStart.tabs[0].id), { kind: "open", op: { op: "open", sessionId: null } });
});

test("history: a move inside the focused tab replaces the entry, a move to another tab pushes one", () => {
  assert.equal(staysInTab("t1", { tabId: "t1", paneId: "p1" }), true);
  assert.equal(staysInTab("t1", { tabId: "t2", paneId: "p1" }), false);
  assert.equal(staysInTab(null, { tabId: "t1", paneId: "p1" }), false);
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
  assert.equal(neighbourTab(ws.tabs, t1.id), t2);
  assert.equal(neighbourTab(ws.tabs, t2.id), t3);
  assert.equal(neighbourTab(ws.tabs, t3.id), t2);
  assert.equal(neighbourTab(ws.tabs, "gone"), null);
  assert.equal(neighbourTab([t1], t1.id), null);
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
  assert.equal(closeSizes([33.33, 33.33, 33.34], [33.333, 33.333, 33.334]), true);
  assert.equal(closeSizes([50, 50], [60, 40]), false);
  assert.equal(closeSizes([50, 50], [100]), false);
});

/** Ids with a prefix, for telling an op's optimistic ids from the server's. */
function prefixed(prefix) {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

/** The provider's `keyOf` over an alias map: the key a node was first rendered under. */
const keyOfWith = (aliases) => (id) => aliases.get(id) ?? id;

/** An op applied as the provider does: the outcome (workspace and location, null when the op places nothing) and the ids drawn, in order. */
function outcome(ws, op, prefix) {
  const made = [];
  const next = prefixed(prefix);
  const result = applyWorkspaceOp(ws, op, () => {
    const id = next();
    made.push(id);
    return id;
  }, 1000);
  return { workspace: result.workspace, location: result.location ?? null, made };
}

/** A copy from the stream: a workspace and no location, since it answers no op. */
const streamed = (workspace) => ({ workspace, location: null });

test("id aliases pair an op's temporary ids with the server's from the op's answer: the new tab, pane and split, never an existing id", () => {
  const base = build([{ op: "open", sessionId: "a" }]);
  const split = { op: "open", sessionId: "b", target: { tabId: base.tabs[0].id, paneId: base.tabs[0].root.id, edge: "right" } };
  const mine = outcome(base, split, "tmp");
  const theirs = outcome(base, split, "real");
  const aliases = idAliases(base, mine, theirs);
  const realSplit = theirs.workspace.tabs[0].root;
  const tmpSplit = mine.workspace.tabs[0].root;
  // Split beside: the answer's tab is the existing one; only the new pane and the new split pair.
  assert.deepEqual([...aliases.entries()], [
    [realSplit.children[1].id, tmpSplit.children[1].id],
    [realSplit.id, tmpSplit.id],
  ]);
  assert.equal(aliases.has(base.tabs[0].id), false);
  assert.equal(aliases.has(realSplit.children[0].id), false);
  // Keys survive adoption: the server's id renders under the optimistic key, and the optimistic id is its own key.
  const keyOf = keyOfWith(aliases);
  assert.equal(keyOf(realSplit.children[1].id), tmpSplit.children[1].id);
  assert.equal(keyOf(tmpSplit.children[1].id), tmpSplit.children[1].id);
  // A new tab: the tab and its pane, from the answer's location.
  const opened = outcome(base, { op: "open", sessionId: "c" }, "tmp");
  const openedServer = outcome(base, { op: "open", sessionId: "c" }, "real");
  const tabAliases = idAliases(base, opened, openedServer);
  assert.deepEqual([...tabAliases.entries()], [
    [openedServer.location.tabId, opened.location.tabId],
    [openedServer.location.paneId, opened.location.paneId],
  ]);
  // The tab's tree pairs by position even when the strip was reordered meanwhile (the location names the tab, not its index).
  const moved = applyWorkspaceOp(openedServer.workspace, { op: "move_tab", tabId: openedServer.location.tabId, index: 0 }, prefixed("x"), 1000).workspace;
  assert.deepEqual([...idAliases(base, opened, { workspace: moved, location: openedServer.location }).entries()], [...tabAliases.entries()]);
  // Ops that place nothing (close, move, rename, resize) have no location on either side: no aliases.
  const close = { op: "close_tab", tabId: base.tabs[0].id };
  assert.equal(idAliases(base, outcome(base, close, "tmp"), outcome(base, close, "real")).size, 0);
});

test("two quick opens on one device: each answer pairs its own tab, the stream copy between them pairs nothing", () => {
  const base = build([{ op: "open", sessionId: "a" }]);
  const op1 = { op: "open", sessionId: "b" };
  const op2 = { op: "open", sessionId: "c" };
  const guess1 = outcome(base, op1, "tmp1");
  // Op 2's base is op 1's guess, temporary ids and all.
  const guess2 = outcome(guess1.workspace, op2, "tmp2");
  const server1 = outcome(base, op1, "real1");
  const server2 = outcome(server1.workspace, op2, "real2");
  // The stream's copy of op 1 lands first: it answers no op, so it introduces no alias, whichever op it is checked against.
  assert.equal(idAliases(base, streamed(guess1.workspace), streamed(server1.workspace)).size, 0);
  assert.equal(idAliases(guess1.workspace, streamed(guess2.workspace), streamed(server1.workspace)).size, 0);
  // Answer 1: b's tab and pane, and nothing of c's.
  const first = idAliases(base, guess1, server1);
  assert.deepEqual([...first.entries()], [
    [server1.location.tabId, guess1.location.tabId],
    [server1.location.paneId, guess1.location.paneId],
  ]);
  // Answer 2: c's tab and pane. b's real ids look new against op 2's base (which holds b's temporary ids) but the location names c, so they are not paired with c's temporary ids.
  const known = (id) => first.has(id) || [...first.values()].includes(id);
  const second = idAliases(guess1.workspace, guess2, server2, known);
  assert.deepEqual([...second.entries()], [
    [server2.location.tabId, guess2.location.tabId],
    [server2.location.paneId, guess2.location.paneId],
  ]);
  const keyOf = keyOfWith(new Map([...first, ...second]));
  assert.deepEqual(server2.workspace.tabs.map((tab) => keyOf(tab.id)), [base.tabs[0].id, guess1.location.tabId, guess2.location.tabId]);
});

test("another device's open landing first: our answer pairs only our tab, theirs keeps its id", () => {
  const base = build([{ op: "open", sessionId: "a" }]);
  const ours = outcome(base, { op: "open", sessionId: "y" }, "tmp");
  const theirs = outcome(base, { op: "open", sessionId: "x" }, "other");
  // Their stream copy lands before our answer: no alias (their x tab is not ours, though it sits where our y tab sat in the guess).
  assert.equal(idAliases(base, streamed(ours.workspace), streamed(theirs.workspace)).size, 0);
  const answer = outcome(theirs.workspace, { op: "open", sessionId: "y" }, "real");
  assert.deepEqual(answer.workspace.tabs.map((tab) => tab.root.sessionId), ["a", "x", "y"]);
  const aliases = idAliases(base, ours, answer);
  assert.deepEqual([...aliases.entries()], [
    [answer.location.tabId, ours.location.tabId],
    [answer.location.paneId, ours.location.paneId],
  ]);
  assert.equal(aliases.has(theirs.location.tabId), false);
  assert.equal(aliases.has(theirs.location.paneId), false);
  // A concurrent close of the tab before ours: still only ours pairs.
  const closed = applyWorkspaceOp(base, { op: "close_tab", tabId: base.tabs[0].id }, prefixed("x"), 1000).workspace;
  const afterClose = outcome(closed, { op: "open", sessionId: "y" }, "real");
  assert.deepEqual([...idAliases(base, ours, afterClose).entries()], [
    [afterClose.location.tabId, ours.location.tabId],
    [afterClose.location.paneId, ours.location.paneId],
  ]);
});

test("an arrange rebuild while an open is in flight pairs the rebuilt tree and its overflow tabs, not the open's ids", () => {
  const base = build([{ op: "arrange", sessionIds: ["a", "b"], preset: "columns-2" }]);
  const tabId = base.tabs[0].id;
  const open = { op: "open", sessionId: "c" };
  const guess1 = outcome(base, open, "tmp1");
  const rebuild = { op: "arrange", tabId, sessionIds: ["a", "b"], preset: "rows-2" };
  const guess2 = outcome(guess1.workspace, rebuild, "tmp2");
  const server1 = outcome(base, open, "real1");
  const server2 = outcome(server1.workspace, rebuild, "real2");
  const known = (id) => id.startsWith("real1") || id.startsWith("tmp1");
  const aliases = idAliases(guess1.workspace, guess2, server2, known);
  const tmpRoot = guess2.workspace.tabs[0].root;
  const realRoot = server2.workspace.tabs[0].root;
  // The tab existed: not aliased. Its new split and both new panes are.
  assert.deepEqual([...aliases.entries()], [
    [realRoot.children[0].id, tmpRoot.children[0].id],
    [realRoot.id, tmpRoot.id],
    [realRoot.children[1].id, tmpRoot.children[1].id],
  ]);
  assert.equal(aliases.has(tabId), false);
  assert.equal(aliases.has(server1.location.tabId), false);
  // A rebuild to a smaller preset: the session left over moves to a tab of its own, paired by session.
  const shrink = { op: "arrange", tabId, sessionIds: ["a"], preset: "single" };
  const shrunk = outcome(guess1.workspace, shrink, "tmp3");
  const shrunkServer = outcome(server1.workspace, shrink, "real3");
  assert.deepEqual(shrunkServer.workspace.tabs.map((tab) => tab.root.sessionId), ["a", "b", "c"]);
  const overflow = idAliases(guess1.workspace, shrunk, shrunkServer, known);
  assert.deepEqual([...overflow.entries()], [
    [shrunkServer.location.paneId, shrunk.location.paneId],
    [shrunkServer.workspace.tabs[1].id, shrunk.workspace.tabs[1].id],
    [shrunkServer.workspace.tabs[1].root.id, shrunk.workspace.tabs[1].root.id],
  ]);
});

test("split beside, then split the new pane within one round trip: the second op names the first's temporary pane and posts the real one", () => {
  const base = build([{ op: "open", sessionId: "a" }]);
  const tabId = base.tabs[0].id;
  const op1 = { op: "open", sessionId: null, target: { tabId, paneId: base.tabs[0].root.id, edge: "right" } };
  const guess1 = outcome(base, op1, "tmp1");
  const tmpPane1 = guess1.location.paneId;
  const op2 = { op: "open", sessionId: null, target: { tabId, paneId: tmpPane1, edge: "bottom" } };
  const guess2 = outcome(guess1.workspace, op2, "tmp2");
  // The provider knows which ids op 2 names, so it can wait for the op that made them.
  assert.deepEqual(opIds(op2), [tabId, tmpPane1]);
  assert.deepEqual(opIds({ op: "resize", splitId: "s", sizes: [50, 50] }), ["s"]);
  assert.deepEqual(opIds({ op: "arrange", sessionIds: [], preset: "single" }), []);
  // Answer 1 pairs op 1's split and pane; from then on the real id of each temporary one is known.
  const server1 = outcome(base, op1, "real1");
  const first = idAliases(base, guess1, server1);
  const realOf = new Map([...first.entries()].map(([real, tmp]) => [tmp, real]));
  const posted = rewriteOpIds(op2, (id) => realOf.get(id) ?? id);
  assert.equal(posted.target.paneId, server1.location.paneId);
  assert.equal(posted.target.tabId, tabId);
  assert.notEqual(posted, op2);
  // An op naming only real ids is posted as is (the same object).
  assert.equal(rewriteOpIds(op1, (id) => realOf.get(id) ?? id), op1);
  // Answer 2 (to the posted op) pairs only op 2's split and pane: op 1's temporary ids sit in op 2's base, its real ones are known.
  const server2 = outcome(server1.workspace, posted, "real2");
  const known = (id) => first.has(id) || realOf.has(id);
  const second = idAliases(guess1.workspace, guess2, server2, known);
  const realSplit2 = server2.workspace.tabs[0].root.children[1];
  const tmpSplit2 = guess2.workspace.tabs[0].root.children[1];
  assert.deepEqual([...second.entries()], [
    [realSplit2.children[1].id, tmpSplit2.children[1].id],
    [realSplit2.id, tmpSplit2.id],
  ]);
  // Op 2 replayed on answer 1 (the provider keeps showing it until its own answer) draws the ids it was first rendered under.
  const replayed = applyWorkspaceOp(server1.workspace, posted, replayIds(guess2.made, prefixed("fresh")), 1000);
  assert.equal(replayed.workspace.tabs[0].root.children[1].id, tmpSplit2.id);
  assert.equal(replayed.location.paneId, guess2.location.paneId);
  const keyOf = keyOfWith(new Map([...first, ...second]));
  assert.equal(keyOf(realSplit2.children[1].id), tmpSplit2.children[1].id);
  assert.equal(keyOf(server1.location.paneId), tmpPane1);
});
