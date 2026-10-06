/**
 * The web app's pure workspace helpers (docs/WORKSPACE.md), on top of the shared reducer in
 * `@portal/shared/workspace`: tab and pane names, the tab icon's cells, the resolver's decisions,
 * unread derivation from session-list patches (per pane, so a pane a phone hides counts), the
 * mounting policy, split sizes for the panel library, and the key aliases that keep panes mounted
 * when the server replaces optimistic ids. No React, no `@/` imports: the node test runner loads
 * this file directly.
 */
import type {
  LayoutNode,
  LayoutPreset,
  PaneNode,
  SplitEdge,
  SplitNode,
  Tab,
  Workspace,
  WorkspaceLocation,
  WorkspaceOp,
} from "@portal/contracts/workspace";
import {
  allPanes,
  applyWorkspaceOp,
  defaultTabTitle,
  findTab,
  locateSession,
  presetSlotCount,
  tabPanes,
  WorkspaceError,
} from "@portal/shared/workspace";
import { tabPath } from "./session-routes.ts";
import { sessionDisplayTitle } from "./session-title.ts";

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** A session's display title from the list: the sidebar's vocabulary ("New conversation" for an untitled one). */
export function sessionTitleIn(sessions: readonly { id: string; title: string | null }[], sessionId: string): string {
  return sessionDisplayTitle(sessions.find((s) => s.id === sessionId)?.title);
}

/** The name a tab shows, from its sessions' display titles (decision 25); the shared fallback "Untitled" never shows. */
export function tabTitle(tab: Tab, sessions: readonly { id: string; title: string | null }[]): string {
  return defaultTabTitle(tab, (sessionId) => sessionTitleIn(sessions, sessionId));
}

/** One pane's name: its session's display title, or "New session" for a start page. */
export function paneTitle(pane: PaneNode, sessions: readonly { id: string; title: string | null }[]): string {
  return pane.sessionId === null ? "New session" : sessionTitleIn(sessions, pane.sessionId);
}

/** The preset's label in menus. */
export const presetLabels: Record<LayoutPreset, string> = {
  single: "Single",
  "columns-2": "Two columns",
  "columns-3": "Three columns",
  "rows-2": "Two rows",
  "grid-2x2": "2 × 2 grid",
  "one-beside-two": "One beside two",
};

// ---------------------------------------------------------------------------------------------
// The tab icon
// ---------------------------------------------------------------------------------------------

/** One cell of a tab's miniature: its pane and its box in percent of the icon (equal division, sizes do not matter). */
export type IconCell = { paneId: string; sessionId: string | null; x: number; y: number; width: number; height: number };

/** The icon's cells from a layout tree, in reading order. */
export function iconCells(root: LayoutNode): IconCell[] {
  const out: IconCell[] = [];
  const walk = (node: LayoutNode, x: number, y: number, width: number, height: number) => {
    if (node.kind === "pane") {
      out.push({ paneId: node.id, sessionId: node.sessionId, x, y, width, height });
      return;
    }
    const count = node.children.length;
    node.children.forEach((child, i) => {
      if (node.direction === "row") walk(child, x + (width / count) * i, y, width / count, height);
      else walk(child, x, y + (height / count) * i, width, height / count);
    });
  };
  walk(root, 0, 0, 100, 100);
  return out;
}

/** An icon cell with its session's state drawn in (null for a start page, or a session the list lacks). */
export type IconCellState = IconCell & { state: string | null };

/** The cells with their states: what a tab item needs to draw its icon, as plain values so it can skip renders. */
export function tabCells(root: LayoutNode, stateOf: (sessionId: string) => string | null): IconCellState[] {
  return iconCells(root).map((cell) => ({ ...cell, state: cell.sessionId === null ? null : stateOf(cell.sessionId) }));
}

/** Whether two cell lists draw the same icon (a memoised tab item skips a render on a session-list patch that changed nothing of its own). */
export function sameCells(a: readonly IconCellState[], b: readonly IconCellState[]): boolean {
  return (
    a.length === b.length &&
    a.every((cell, i) => {
      const other = b[i];
      return (
        cell.paneId === other.paneId &&
        cell.sessionId === other.sessionId &&
        cell.state === other.state &&
        cell.x === other.x &&
        cell.y === other.y &&
        cell.width === other.width &&
        cell.height === other.height
      );
    })
  );
}

// ---------------------------------------------------------------------------------------------
// Flat order (mobile) and focus
// ---------------------------------------------------------------------------------------------

/** Every pane of every tab, tab order then tree order: the phone's flat list (decision 18). */
export function flatPanes(ws: Workspace): { tabId: string; pane: PaneNode }[] {
  return allPanes(ws);
}

/**
 * What the URL's tab and pane name in this workspace: the tab (null when gone), and its focused pane,
 * the named one when the tab holds it, else the tab's first pane.
 */
export function resolveFocus(ws: Workspace, tabId: string | null, paneId: string | null): { tab: Tab | null; pane: PaneNode | null } {
  const tab = tabId ? findTab(ws, tabId) : null;
  if (!tab) return { tab: null, pane: null };
  const panes = tabPanes(tab);
  return { tab, pane: panes.find((pane) => pane.id === paneId) ?? panes[0] ?? null };
}

/** The first start-page pane of `tab`, if any: the one a "new session" entry point reuses (see `resolveRoute`). */
export function startPaneIn(tab: Tab): WorkspaceLocation | null {
  const pane = tabPanes(tab).find((candidate) => candidate.sessionId === null);
  return pane ? { tabId: tab.id, paneId: pane.id } : null;
}

/** Whether a location's path should carry `?pane=`: only in a split (decision 7). */
export function paneInPath(ws: Workspace, location: WorkspaceLocation): boolean {
  const tab = findTab(ws, location.tabId);
  return !!tab && tabPanes(tab).length > 1;
}

/** The URL for a location: `/tabs/<tabId>`, with `?pane=` when the tab is a split. */
export function locationPath(ws: Workspace, location: WorkspaceLocation): string {
  return tabPath(location.tabId, paneInPath(ws, location) ? location.paneId : null);
}

/**
 * What the shell does with a resolver path (decision 7 and 9): focus the tab holding the session, else
 * open it in a new tab. For `/new`: stay on the bare start page while the workspace is empty; else the
 * one rule every "new session" entry point follows (`+`, a project's `+`, a drafted prompt, `/new`): a
 * start-page pane is reused only when it is in the focused tab (`focusedTabId`; `/new` itself names
 * none), otherwise a new start-page tab opens.
 */
export type RouteResolution = { kind: "focus"; location: WorkspaceLocation } | { kind: "open"; op: WorkspaceOp } | { kind: "stay" };

export function resolveRoute(
  ws: Workspace,
  route: { kind: "start" } | { kind: "session"; sessionId: string },
  focusedTabId: string | null = null,
): RouteResolution {
  if (route.kind === "session") {
    const location = locateSession(ws, route.sessionId);
    return location ? { kind: "focus", location } : { kind: "open", op: { op: "open", sessionId: route.sessionId } };
  }
  if (ws.tabs.length === 0) return { kind: "stay" };
  const focused = focusedTabId ? findTab(ws, focusedTabId) : null;
  const start = focused ? startPaneIn(focused) : null;
  return start ? { kind: "focus", location: start } : { kind: "open", op: { op: "open", sessionId: null } };
}

// ---------------------------------------------------------------------------------------------
// Ops the UI builds
// ---------------------------------------------------------------------------------------------

/** The tab's sessions in reading order (start pages left out). */
export function sessionIdsOf(tab: Tab): string[] {
  return tabPanes(tab).flatMap((pane) => (pane.sessionId === null ? [] : [pane.sessionId]));
}

/**
 * Rebuild `tab` as `preset` with its sessions in order. Only as many as the preset holds are listed:
 * the rest, which the tab still holds, each move to a new tab after it (the reducer's overflow rule).
 */
export function arrangeOp(tab: Tab, preset: LayoutPreset): WorkspaceOp {
  return { op: "arrange", tabId: tab.id, preset, sessionIds: sessionIdsOf(tab).slice(0, presetSlotCount(preset)) };
}

/**
 * Whether the reducer would let a start page split `paneId` on `edge`: false once the tab holds 4
 * panes or the split would nest 3 deep (a pane in a column under a row, split sideways). The menus
 * disable what it refuses rather than offer it and report the refusal.
 */
export function canSplitPane(ws: Workspace, tabId: string, paneId: string, edge: SplitEdge): boolean {
  let n = 0;
  try {
    applyWorkspaceOp(ws, { op: "open", sessionId: null, target: { tabId, paneId, edge } }, () => `probe-${n++}`);
    return true;
  } catch (error) {
    if (error instanceof WorkspaceError) return false;
    throw error;
  }
}

/** The tab to show (and to focus in the strip) once `tabId` closes: its right neighbour, else its left one, else none. */
export function neighbourTab(tabs: readonly Tab[], tabId: string): Tab | null {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

/**
 * History for a focus move to `location`: a pane change inside the focused tab replaces the entry,
 * a move to another tab pushes one. True means replace.
 */
export function staysInTab(focusedTabId: string | null, location: WorkspaceLocation): boolean {
  return focusedTabId !== null && location.tabId === focusedTabId;
}

// ---------------------------------------------------------------------------------------------
// Unread (decision 30)
// ---------------------------------------------------------------------------------------------

/** What the session list says about a session's turns: enough to notice a turn ending or a permission request. */
export type SessionSignal = { turnEndedAt: number | null; awaitingPermission: boolean };

export function signalsOf(sessions: readonly ({ id: string } & SessionSignal)[]): Map<string, SessionSignal> {
  return new Map(sessions.map((s) => [s.id, { turnEndedAt: s.turnEndedAt, awaitingPermission: s.awaitingPermission }]));
}

/**
 * Sessions whose signal advanced from `prev` to `next`: a turn ended (`turnEndedAt` grew, or went
 * from null to a time) or a permission request appeared. Sessions unseen before do not count: the
 * first list load is not news.
 */
export function advancedSessions(prev: ReadonlyMap<string, SessionSignal>, next: ReadonlyMap<string, SessionSignal>): string[] {
  const out: string[] = [];
  for (const [id, signal] of next) {
    const before = prev.get(id);
    if (!before) continue;
    const turnEnded = signal.turnEndedAt !== null && (before.turnEndedAt === null || signal.turnEndedAt > before.turnEndedAt);
    const asked = signal.awaitingPermission && !before.awaitingPermission;
    if (turnEnded || asked) out.push(id);
  }
  return out;
}

/**
 * The panes a device shows, for unread: every pane of `tabId` (a desktop tab, a tablet split), or
 * only `onlyPaneId` when the device shows one pane at a time (a phone, a tablet tab too big for a
 * split; `FocusScope` "pane" in `workspace-mobile.ts`). Empty off the workspace.
 */
export function visiblePaneIds(ws: Workspace, tabId: string | null, onlyPaneId: string | null): ReadonlySet<string> {
  if (onlyPaneId !== null) return new Set([onlyPaneId]);
  const tab = tabId ? findTab(ws, tabId) : null;
  return new Set(tab ? tabPanes(tab).map((pane) => pane.id) : []);
}

/**
 * The unread pane set after `advanced` sessions' news: the pane of each is marked unless the device
 * shows it (`visible`). Answers the same set when nothing changes, so React state stays put.
 */
export function unreadAfter(
  unread: ReadonlySet<string>,
  ws: Workspace,
  advanced: readonly string[],
  visible: ReadonlySet<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const sessionId of advanced) {
    const location = locateSession(ws, sessionId);
    if (!location || visible.has(location.paneId) || unread.has(location.paneId) || next?.has(location.paneId)) continue;
    (next ??= new Set(unread)).add(location.paneId);
  }
  return next ?? unread;
}

/** The unread set without `paneIds` (showing them reads them); the same set when none was marked. */
export function withoutUnread(unread: ReadonlySet<string>, paneIds: Iterable<string>): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const paneId of paneIds) {
    if (!unread.has(paneId)) continue;
    (next ??= new Set(unread)).delete(paneId);
  }
  return next ?? unread;
}

/** The tabs with an unread pane, for the strip's ring (decision 10). */
export function unreadTabIds(ws: Workspace, unreadPanes: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  if (unreadPanes.size === 0) return out;
  for (const tab of ws.tabs) if (tabPanes(tab).some((pane) => unreadPanes.has(pane.id))) out.add(tab.id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mounting policy (decision 30)
// ---------------------------------------------------------------------------------------------

/** How many hidden tabs stay mounted besides the focused one. */
export const MOUNTED_HIDDEN_TABS = 3;

/** `recent` with `tabId` moved to the front; capped so it does not grow for the life of the page. */
export function rememberFocused(recent: readonly string[], tabId: string | null, max = 8): string[] {
  if (tabId === null) return [...recent];
  return [tabId, ...recent.filter((id) => id !== tabId)].slice(0, max);
}

/** The tabs to keep mounted: the focused one plus the `keep` most recently focused others that still exist, in strip order. */
export function mountedTabIds(ws: Workspace, focusedTabId: string | null, recent: readonly string[], keep = MOUNTED_HIDDEN_TABS): string[] {
  const existing = new Set(ws.tabs.map((tab) => tab.id));
  const kept = new Set<string>();
  if (focusedTabId !== null && existing.has(focusedTabId)) kept.add(focusedTabId);
  const limit = kept.size + keep;
  for (const id of recent) {
    if (kept.size >= limit) break;
    if (existing.has(id)) kept.add(id);
  }
  return ws.tabs.filter((tab) => kept.has(tab.id)).map((tab) => tab.id);
}

// ---------------------------------------------------------------------------------------------
// Split sizes and the panel library
// ---------------------------------------------------------------------------------------------

/** The split's sizes as the panel library's layout: a map of child key (`keyOf` its id) to percent. */
export function layoutOf(split: SplitNode, keyOf: (id: string) => string = (id) => id): Record<string, number> {
  return Object.fromEntries(split.children.map((child, i) => [keyOf(child.id), split.sizes[i]]));
}

/** Sizes in child order from a layout the panel library reported; a child it lacks keeps its stored size. */
export function sizesFromLayout(split: SplitNode, layout: Readonly<Record<string, number>>, keyOf: (id: string) => string = (id) => id): number[] {
  return split.children.map((child, i) => layout[keyOf(child.id)] ?? split.sizes[i]);
}

/** Equal within the rounding the reducer applies (two decimals); the shared reducer's own `sameSizes` is exact. */
export function closeSizes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((size, i) => Math.abs(size - b[i]) < 0.01);
}

// ---------------------------------------------------------------------------------------------
// Optimistic ids
// ---------------------------------------------------------------------------------------------

/** Every tab, split and pane id in the workspace. */
function idsOf(ws: Workspace): Set<string> {
  const out = new Set<string>();
  const walk = (node: LayoutNode) => {
    out.add(node.id);
    if (node.kind === "split") node.children.forEach(walk);
  };
  for (const tab of ws.tabs) {
    out.add(tab.id);
    walk(tab.root);
  }
  return out;
}

/**
 * Which of the server's ids stand for which optimistic ones, for one op: `optimistic` is the guess
 * made from `base`, `server` a copy that includes the op's outcome. Only the ids the guess made up
 * (absent from `base`) are paired, and only with ids the server introduced (also absent from `base`):
 * tabs already in `base` match by id and their trees walk by position where the shape agrees; the
 * new tabs pair up in order. A real id is never aliased to another real id, so a concurrent
 * `move_tab` or `close_tab` from another device (or the orchestrator) that shifts positions cannot
 * cross-alias live tabs and remount them. A pane keyed by the optimistic id keeps its key when the
 * server's copy lands, so it does not remount.
 */
export function idAliases(base: Workspace, optimistic: Workspace, server: Workspace): Map<string, string> {
  const known = idsOf(base);
  const aliases = new Map<string, string>();
  const pair = (mine: string, theirs: string) => {
    if (mine !== theirs && !known.has(mine) && !known.has(theirs)) aliases.set(theirs, mine);
  };
  const walk = (a: LayoutNode, b: LayoutNode) => {
    if (a.kind === "pane" && b.kind === "pane") {
      if (a.sessionId === b.sessionId) pair(a.id, b.id);
      return;
    }
    if (a.kind === "split" && b.kind === "split") {
      if (a.direction !== b.direction || a.children.length !== b.children.length) return;
      pair(a.id, b.id);
      a.children.forEach((child, i) => walk(child, b.children[i]));
    }
  };
  for (const tab of server.tabs) {
    if (!known.has(tab.id)) continue;
    const mine = findTab(optimistic, tab.id);
    if (mine) walk(mine.root, tab.root);
  }
  const newMine = optimistic.tabs.filter((tab) => !known.has(tab.id));
  server.tabs
    .filter((tab) => !known.has(tab.id))
    .forEach((tab, i) => {
      const mine = newMine[i];
      if (!mine) return;
      pair(mine.id, tab.id);
      walk(mine.root, tab.root);
    });
  return aliases;
}

/** The ids an optimistic op generates; the server's replace them when it answers. */
export function temporaryIds(): () => string {
  let n = 0;
  return () => `tmp-${Date.now().toString(36)}-${(n++).toString(36)}`;
}
