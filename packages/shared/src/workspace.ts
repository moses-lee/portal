/**
 * The workspace reducer (docs/WORKSPACE.md): applies one `WorkspaceOp` to a `Workspace` and answers
 * the new one, never touching the input. The server runs it before saving; the web app runs it
 * optimistically. Pure and dependency-free: ids come from the caller, so tests are deterministic, and
 * `version` is the store's business, not the reducer's.
 */
import type {
  FilePaneNode,
  LayoutNode,
  LeafNode,
  LayoutPreset,
  PaneNode,
  SplitEdge,
  SplitNode,
  Tab,
  Workspace,
  WorkspaceLocation,
  WorkspaceOp,
} from "@portal/contracts/workspace";
import { LAYOUT_PRESETS, WORKSPACE_TAB_TITLE_MAX } from "@portal/contracts/workspace";

export const EMPTY_WORKSPACE: Workspace = Object.freeze({ tabs: Object.freeze([]) as unknown as Tab[], version: 0 });

export const MAX_PANES_PER_TAB = 4;
export const MAX_SPLIT_DEPTH = 2;
export const MIN_PANE_SIZE = 10;

export type ApplyResult = { workspace: Workspace; location?: WorkspaceLocation; changed: boolean };

/**
 * `not_found`: an unknown tab, pane or split id. `invalid`: malformed input (bad sizes, a title too
 * long, an index out of range, more sessions than a preset holds). `refused`: the workspace's rules
 * (a cap reached, a session listed twice, a `portal` rename over a `user` one).
 */
export type WorkspaceErrorCode = "not_found" | "invalid" | "refused";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------------------------

/**
 * Vocabulary: a **leaf** is anything a pane shows (a session or start page, `PaneNode`, or a file,
 * `FilePaneNode`, docs/FILES.md); the `*Leaves` helpers walk them all, and the pane caps, ids and
 * focus are about leaves. The `*Panes` helpers answer only session and start-page panes, the ones
 * that carry a `sessionId`.
 */
export function isLeaf(node: LayoutNode): node is LeafNode {
  return node.kind !== "split";
}

/** Every leaf of a layout, in reading order (left to right, top to bottom). */
export function leavesOf(node: LayoutNode): LeafNode[] {
  return node.kind === "split" ? node.children.flatMap(leavesOf) : [node];
}

export function tabLeaves(tab: Tab): LeafNode[] {
  return leavesOf(tab.root);
}

export function allLeaves(ws: Workspace): { tabId: string; pane: LeafNode }[] {
  return ws.tabs.flatMap((tab) => tabLeaves(tab).map((pane) => ({ tabId: tab.id, pane })));
}

/** The session and start-page panes of a layout (file panes left out), in reading order. */
export function panesOf(node: LayoutNode): PaneNode[] {
  return leavesOf(node).filter((leaf): leaf is PaneNode => leaf.kind === "pane");
}

export function tabPanes(tab: Tab): PaneNode[] {
  return panesOf(tab.root);
}

export function allPanes(ws: Workspace): { tabId: string; pane: PaneNode }[] {
  return ws.tabs.flatMap((tab) => tabPanes(tab).map((pane) => ({ tabId: tab.id, pane })));
}

export function findTab(ws: Workspace, tabId: string): Tab | null {
  return ws.tabs.find((tab) => tab.id === tabId) ?? null;
}

/** The leaf with id `paneId` (a session, start-page or file pane) and its tab. */
export function locatePane(ws: Workspace, paneId: string): { tabId: string; pane: LeafNode } | null {
  return allLeaves(ws).find(({ pane }) => pane.id === paneId) ?? null;
}

export function locateSession(ws: Workspace, sessionId: string): WorkspaceLocation | null {
  const hit = allPanes(ws).find(({ pane }) => pane.sessionId === sessionId);
  return hit ? { tabId: hit.tabId, paneId: hit.pane.id } : null;
}

/**
 * An absolute path in the one form a file pane holds, like Node's `path.posix.normalize` (this
 * module also runs in the browser): `//` and `/./` collapse, `..` is resolved (never above the
 * root), and a trailing slash goes, except on the root. So `/a//b`, `/a/./b` and `/a/b/` are one
 * file (decision 16 of docs/FILES.md). Lexical only: symlinks are the files API's to resolve.
 */
export function normalizeFilePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The file pane showing `path` (the same file once normalized, decision 16 of docs/FILES.md), or null. */
export function locateFile(ws: Workspace, path: string): WorkspaceLocation | null {
  const wanted = normalizeFilePath(path);
  const hit = allLeaves(ws).find(({ pane }) => pane.kind === "file" && normalizeFilePath(pane.path) === wanted);
  return hit ? { tabId: hit.tabId, paneId: hit.pane.id } : null;
}

/** A leaf is depth 0; a split is one more than its deepest child. */
export function depthOf(node: LayoutNode): number {
  return node.kind === "split" ? 1 + Math.max(...node.children.map(depthOf)) : 0;
}

function findSplit(node: LayoutNode, splitId: string): SplitNode | null {
  if (node.kind !== "split") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const hit = findSplit(child, splitId);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------------------------

function equalSizes(count: number): number[] {
  return roundSizes(Array.from({ length: count }, () => 100 / count));
}

/** Two decimals each, the rounding remainder on the largest, so they sum to exactly 100. */
function roundSizes(sizes: number[]): number[] {
  const out = sizes.map((s) => Math.round(s * 100) / 100);
  const remainder = Math.round((100 - out.reduce((sum, s) => sum + s, 0)) * 100) / 100;
  if (remainder !== 0) {
    const largest = out.indexOf(Math.max(...out));
    out[largest] = Math.round((out[largest] + remainder) * 100) / 100;
  }
  return out;
}

/**
 * Sizes for `count` children: scaled to sum 100 with each at least 10 (a child squeezed below the
 * minimum is pinned there and the rest share what is left). Unusable input (wrong length, a
 * non-finite or negative entry, all zeros) gives an equal split; a zero entry (a panel dragged
 * shut) is pinned at the minimum.
 */
export function normalizeSizes(sizes: readonly number[], count: number): number[] {
  if (count < 1) return [];
  if (sizes.length !== count || !sizes.every((s) => Number.isFinite(s) && s >= 0)) return equalSizes(count);
  const total = sizes.reduce((sum, s) => sum + s, 0);
  if (total <= 0) return equalSizes(count);
  let out = sizes.map((s) => (s / total) * 100);
  for (let pass = 0; pass < count; pass++) {
    const pinned = out.map((s) => s <= MIN_PANE_SIZE);
    if (!pinned.some(Boolean)) break;
    const room = 100 - pinned.filter(Boolean).length * MIN_PANE_SIZE;
    const free = out.reduce((sum, s, i) => (pinned[i] ? sum : sum + s), 0);
    out = out.map((s, i) => (pinned[i] ? MIN_PANE_SIZE : free > 0 ? (s / free) * room : MIN_PANE_SIZE));
  }
  return roundSizes(out);
}

function sameSizes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

// ---------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------

const PRESET_SLOTS: Record<LayoutPreset, number> = {
  single: 1,
  "columns-2": 2,
  "columns-3": 3,
  "rows-2": 2,
  "grid-2x2": 4,
  "one-beside-two": 3,
};

export function presetSlotCount(preset: LayoutPreset): number {
  return PRESET_SLOTS[preset];
}

/** Which preset a tree is, by shape alone (sizes do not matter); null for anything else. */
export function presetOf(root: LayoutNode): LayoutPreset | null {
  if (root.kind !== "split") return "single";
  const kids = root.children;
  const allPanesFlat = kids.every(isLeaf);
  if (root.direction === "row" && allPanesFlat) return kids.length === 2 ? "columns-2" : kids.length === 3 ? "columns-3" : null;
  if (root.direction === "column" && allPanesFlat) return kids.length === 2 ? "rows-2" : null;
  const isRowOfTwoPanes = (n: LayoutNode) => n.kind === "split" && n.direction === "row" && n.children.length === 2 && n.children.every(isLeaf);
  if (root.direction === "column" && kids.length === 2 && kids.every(isRowOfTwoPanes)) return "grid-2x2";
  const isColumnOfTwoPanes = (n: LayoutNode) => n.kind === "split" && n.direction === "column" && n.children.length === 2 && n.children.every(isLeaf);
  if (root.direction === "row" && kids.length === 2 && isLeaf(kids[0]) && isColumnOfTwoPanes(kids[1])) return "one-beside-two";
  return null;
}

/**
 * A fresh tree for `preset`, its slots filled from `sessionIds` in reading order; slots past the
 * list are start pages. More ids than slots is `invalid`. Ids are drawn parent first, then children.
 */
export function buildPreset(preset: LayoutPreset, sessionIds: readonly (string | null)[], ids: () => string): LayoutNode {
  const slots = presetSlotCount(preset);
  if (sessionIds.length > slots) throw new WorkspaceError("invalid", `The ${preset} layout holds ${slots} panes, not ${sessionIds.length}.`);
  let slot = 0;
  const pane = (): PaneNode => ({ kind: "pane", id: ids(), sessionId: sessionIds[slot++] ?? null });
  const split = (direction: SplitNode["direction"], build: (() => LayoutNode)[]): SplitNode => {
    const id = ids();
    const children = build.map((b) => b());
    return { kind: "split", id, direction, children, sizes: equalSizes(children.length) };
  };
  switch (preset) {
    case "single":
      return pane();
    case "columns-2":
      return split("row", [pane, pane]);
    case "columns-3":
      return split("row", [pane, pane, pane]);
    case "rows-2":
      return split("column", [pane, pane]);
    case "grid-2x2":
      return split("column", [() => split("row", [pane, pane]), () => split("row", [pane, pane])]);
    case "one-beside-two":
      return split("row", [pane, () => split("column", [pane, pane])]);
  }
}

// ---------------------------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------------------------

/** The last segment of a path: what a file pane is called ("/" for the root). */
export function fileName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The name a tab shows (decision 25): its own `title` if set; else the names of what it shows, a
 * session's title or a file's name, "A + B" for two, "N sessions" past that ("N panes" when files are
 * among them), and "New session" when it holds only start pages. A session with no title reads "Untitled".
 */
export function defaultTabTitle(tab: Tab, titleOf: (sessionId: string) => string | null): string {
  if (tab.title !== null) return tab.title;
  const shown = tabLeaves(tab).filter((leaf) => leaf.kind === "file" || leaf.sessionId !== null);
  if (shown.length === 0) return "New session";
  if (shown.length > 2) return shown.every((leaf) => leaf.kind === "pane") ? `${shown.length} sessions` : `${shown.length} panes`;
  return shown.map((leaf) => (leaf.kind === "file" ? fileName(leaf.path) : (titleOf(leaf.sessionId!) ?? "Untitled"))).join(" + ");
}

/** Trimmed title, or null when cleared; too long is `invalid`. */
function cleanTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? "";
  if (trimmed === "") return null;
  if (trimmed.length > WORKSPACE_TAB_TITLE_MAX) throw new WorkspaceError("invalid", `A tab title has at most ${WORKSPACE_TAB_TITLE_MAX} characters.`);
  return trimmed;
}

function assertMayRename(tab: Tab, source: "user" | "portal"): void {
  if (source === "portal" && tab.titleSource === "user") {
    throw new WorkspaceError("refused", `The user named this tab "${tab.title}"; Portal does not rename it.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Tree edits (each returns a new tree, sharing untouched subtrees)
// ---------------------------------------------------------------------------------------------

/** The tree without `paneId`; a split left with one child collapses into it; null when nothing is left. */
function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind !== "split") return node.id === paneId ? null : node;
  const kept: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = removePane(child, paneId);
    if (next === null) return;
    kept.push(next);
    sizes.push(node.sizes[i]);
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  if (kept.length === node.children.length && kept.every((c, i) => c === node.children[i])) return node;
  return { ...node, children: kept, sizes: normalizeSizes(sizes, kept.length) };
}

/**
 * `pane` on `edge` of `paneId`: a sibling when the pane's parent already runs that way (taking half
 * of the target's share), else a new two-way split in the target's place.
 */
function insertBeside(node: LayoutNode, paneId: string, pane: LeafNode, edge: SplitEdge, ids: () => string): LayoutNode {
  const direction = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  if (node.kind !== "split") {
    if (node.id !== paneId) return node;
    return { kind: "split", id: ids(), direction, children: before ? [pane, node] : [node, pane], sizes: [50, 50] };
  }
  const index = node.children.findIndex((child) => isLeaf(child) && child.id === paneId);
  if (index >= 0 && node.direction === direction) {
    const children = [...node.children];
    const sizes = [...node.sizes];
    const share = sizes[index] / 2;
    sizes[index] = share;
    const at = before ? index : index + 1;
    children.splice(at, 0, pane);
    sizes.splice(at, 0, share);
    return { ...node, children, sizes: normalizeSizes(sizes, children.length) };
  }
  return { ...node, children: node.children.map((child) => insertBeside(child, paneId, pane, edge, ids)) };
}

/** The tree with leaf `paneId` swapped for `leaf` (same id), e.g. a start page becoming its session. */
function setLeaf(node: LayoutNode, paneId: string, leaf: LeafNode): LayoutNode {
  if (node.kind !== "split") return node.id === paneId ? leaf : node;
  return { ...node, children: node.children.map((child) => setLeaf(child, paneId, leaf)) };
}

function setSplitSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.kind !== "split") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((child) => setSplitSizes(child, splitId, sizes)) };
}

function assertCaps(root: LayoutNode): void {
  const count = leavesOf(root).length;
  if (count > MAX_PANES_PER_TAB) throw new WorkspaceError("refused", `A tab holds at most ${MAX_PANES_PER_TAB} panes.`);
  if (depthOf(root) > MAX_SPLIT_DEPTH) throw new WorkspaceError("refused", `Splits nest at most ${MAX_SPLIT_DEPTH} deep.`);
}

/** `tabs` with the pane removed from whichever tab holds it; a tab left empty goes away. */
function withoutPane(tabs: Tab[], paneId: string): Tab[] {
  return tabs.flatMap((tab) => {
    const root = removePane(tab.root, paneId);
    if (root === tab.root) return [tab];
    return root === null ? [] : [{ ...tab, root }];
  });
}

function withoutSession(tabs: Tab[], sessionId: string): Tab[] {
  const hit = locateSession({ tabs, version: 0 }, sessionId);
  return hit ? withoutPane(tabs, hit.paneId) : tabs;
}

function newTab(root: LayoutNode, ids: () => string, now: number): Tab {
  return { id: ids(), title: null, titleSource: null, root, createdAt: now };
}

// ---------------------------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------------------------

/**
 * Applies `op` and answers the new workspace (the input is never mutated; `version` is unchanged),
 * the location of what was opened or arranged, and whether anything changed. Throws `WorkspaceError`.
 */
export function applyWorkspaceOp(ws: Workspace, op: WorkspaceOp, ids: () => string, now: number = Date.now()): ApplyResult {
  switch (op.op) {
    case "open":
      return open(ws, op, ids, now);
    case "open_file":
      return openFile(ws, op, ids, now);
    case "replace_file":
      return replaceFile(ws, op);
    case "replace_pane":
      return replacePane(ws, op);
    case "arrange":
      return arrange(ws, op, ids, now);
    case "close_tab": {
      if (!findTab(ws, op.tabId)) throw notFound("tab", op.tabId);
      return { workspace: { ...ws, tabs: ws.tabs.filter((tab) => tab.id !== op.tabId) }, changed: true };
    }
    case "close_pane": {
      if (!locatePane(ws, op.paneId)) throw notFound("pane", op.paneId);
      return { workspace: { ...ws, tabs: withoutPane(ws.tabs, op.paneId) }, changed: true };
    }
    case "move_tab":
      return moveTab(ws, op);
    case "rename_tab":
      return renameTab(ws, op);
    case "resize":
      return resize(ws, op);
  }
}

function notFound(what: "tab" | "pane" | "split", id: string): WorkspaceError {
  return new WorkspaceError("not_found", `No ${what} ${id} in the workspace.`);
}

function open(ws: Workspace, op: Extract<WorkspaceOp, { op: "open" }>, ids: () => string, now: number): ApplyResult {
  if (op.sessionId !== null) {
    const location = locateSession(ws, op.sessionId);
    if (location) return { workspace: ws, location, changed: false };
  }
  return openLeaf(ws, { kind: "pane", id: ids(), sessionId: op.sessionId }, op.target, ids, now);
}

/** `open` for a file (docs/FILES.md, decision 16): a path already open anywhere is focused, not opened twice. */
function openFile(ws: Workspace, op: Extract<WorkspaceOp, { op: "open_file" }>, ids: () => string, now: number): ApplyResult {
  const location = locateFile(ws, op.path);
  if (location) return { workspace: ws, location, changed: false };
  return openLeaf(ws, { kind: "file", id: ids(), path: normalizeFilePath(op.path) }, op.target, ids, now);
}

/** A new leaf in a tab of its own at the end, or on `target`'s edge (within the caps). */
function openLeaf(ws: Workspace, pane: LeafNode, target: Extract<WorkspaceOp, { op: "open" }>["target"], ids: () => string, now: number): ApplyResult {
  if (!target) {
    const tab = newTab(pane, ids, now);
    return { workspace: { ...ws, tabs: [...ws.tabs, tab] }, location: { tabId: tab.id, paneId: pane.id }, changed: true };
  }
  const { tabId, paneId, edge } = target;
  const hit = locatePane(ws, paneId);
  if (!hit || hit.tabId !== tabId) throw notFound("pane", paneId);
  const tabs = ws.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    const root = insertBeside(tab.root, paneId, pane, edge, ids);
    assertCaps(root);
    return { ...tab, root };
  });
  return { workspace: { ...ws, tabs }, location: { tabId, paneId: pane.id }, changed: true };
}

function replacePane(ws: Workspace, op: Extract<WorkspaceOp, { op: "replace_pane" }>): ApplyResult {
  const hit = locatePane(ws, op.paneId);
  if (!hit) throw notFound("pane", op.paneId);
  const location = { tabId: hit.tabId, paneId: op.paneId };
  if (hit.pane.kind === "pane" && hit.pane.sessionId === op.sessionId) return { workspace: ws, location, changed: false };
  // Decision 22: the session moves here; its old pane closes first. A file pane becomes a session pane.
  const leaf: PaneNode = { kind: "pane", id: op.paneId, sessionId: op.sessionId };
  const tabs = withoutSession(ws.tabs, op.sessionId).map((tab) => (tab.id === hit.tabId ? { ...tab, root: setLeaf(tab.root, op.paneId, leaf) } : tab));
  return { workspace: { ...ws, tabs }, location, changed: true };
}

/**
 * A file pane moves to another path in place (a listing's entry, "Reveal folder"). A path open in
 * another file pane is not opened twice: no change, and that pane's location (decision 16 of
 * docs/FILES.md), so the caller focuses it. Only a file pane navigates; a session pane is `invalid`.
 */
function replaceFile(ws: Workspace, op: Extract<WorkspaceOp, { op: "replace_file" }>): ApplyResult {
  const hit = locatePane(ws, op.paneId);
  if (!hit) throw notFound("pane", op.paneId);
  if (hit.pane.kind !== "file") throw new WorkspaceError("invalid", `Pane ${op.paneId} is not a file pane.`);
  const location = { tabId: hit.tabId, paneId: op.paneId };
  const path = normalizeFilePath(op.path);
  if (normalizeFilePath(hit.pane.path) === path) return { workspace: ws, location, changed: false };
  const elsewhere = locateFile(ws, path);
  if (elsewhere) return { workspace: ws, location: elsewhere, changed: false };
  const leaf: FilePaneNode = { kind: "file", id: op.paneId, path };
  const tabs = ws.tabs.map((tab) => (tab.id === hit.tabId ? { ...tab, root: setLeaf(tab.root, op.paneId, leaf) } : tab));
  return { workspace: { ...ws, tabs }, location, changed: true };
}

function arrange(ws: Workspace, op: Extract<WorkspaceOp, { op: "arrange" }>, ids: () => string, now: number): ApplyResult {
  const slots = presetSlotCount(op.preset);
  if (op.sessionIds.length > slots) {
    throw new WorkspaceError("invalid", `The ${op.preset} layout holds ${slots} panes, not ${op.sessionIds.length}.`);
  }
  const listed = op.sessionIds.filter((id): id is string => id !== null);
  if (new Set(listed).size !== listed.length) throw new WorkspaceError("refused", "A session can be open in only one pane.");
  const existing = op.tabId ? findTab(ws, op.tabId) : null;
  if (op.tabId && !existing) throw notFound("tab", op.tabId);
  const title = op.title === undefined ? undefined : cleanTitle(op.title);
  const titleSource = op.titleSource ?? "user";
  if (existing && title !== undefined) assertMayRename(existing, titleSource);

  // Listed sessions open in other tabs move here: their old panes close.
  let tabs = ws.tabs;
  for (const sessionId of listed) {
    const at = locateSession({ tabs, version: 0 }, sessionId);
    if (at && at.tabId !== existing?.id) tabs = withoutPane(tabs, at.paneId);
  }
  const root = buildPreset(op.preset, op.sessionIds, ids);
  const named = title === undefined ? {} : { title, titleSource: title === null ? null : titleSource };
  let tab: Tab;
  if (existing) {
    tab = { ...existing, ...named, root };
    // Sessions the old tab held that found no slot, and its file panes (a preset is built from
    // sessions), each get a tab of their own, right after it, in the order the tab held them.
    const overflow = tabLeaves(existing).flatMap((leaf): Tab[] => {
      if (leaf.kind === "file") return [newTab({ kind: "file", id: ids(), path: leaf.path }, ids, now)];
      if (leaf.sessionId === null || listed.includes(leaf.sessionId)) return [];
      return [newTab({ kind: "pane", id: ids(), sessionId: leaf.sessionId }, ids, now)];
    });
    const index = tabs.findIndex((t) => t.id === existing.id);
    tabs = [...tabs.slice(0, index), tab, ...overflow, ...tabs.slice(index + 1)];
  } else {
    tab = { ...newTab(root, ids, now), ...named };
    tabs = [...tabs, tab];
  }
  return { workspace: { ...ws, tabs }, location: { tabId: tab.id, paneId: leavesOf(root)[0].id }, changed: true };
}

function moveTab(ws: Workspace, op: Extract<WorkspaceOp, { op: "move_tab" }>): ApplyResult {
  const from = ws.tabs.findIndex((tab) => tab.id === op.tabId);
  if (from < 0) throw notFound("tab", op.tabId);
  if (!Number.isInteger(op.index) || op.index < 0 || op.index >= ws.tabs.length) {
    throw new WorkspaceError("invalid", `Tab index ${op.index} is out of range (0 to ${ws.tabs.length - 1}).`);
  }
  if (from === op.index) return { workspace: ws, changed: false };
  const tabs = ws.tabs.filter((tab) => tab.id !== op.tabId);
  tabs.splice(op.index, 0, ws.tabs[from]);
  return { workspace: { ...ws, tabs }, changed: true };
}

function renameTab(ws: Workspace, op: Extract<WorkspaceOp, { op: "rename_tab" }>): ApplyResult {
  const tab = findTab(ws, op.tabId);
  if (!tab) throw notFound("tab", op.tabId);
  assertMayRename(tab, op.source);
  const title = cleanTitle(op.title);
  const titleSource = title === null ? null : op.source;
  if (tab.title === title && tab.titleSource === titleSource) return { workspace: ws, changed: false };
  const tabs = ws.tabs.map((t) => (t.id === tab.id ? { ...t, title, titleSource } : t));
  return { workspace: { ...ws, tabs }, changed: true };
}

function resize(ws: Workspace, op: Extract<WorkspaceOp, { op: "resize" }>): ApplyResult {
  const tab = ws.tabs.find((t) => findSplit(t.root, op.splitId) !== null);
  const split = tab ? findSplit(tab.root, op.splitId) : null;
  if (!tab || !split) throw notFound("split", op.splitId);
  // A panel dragged shut reports 0; clamping lifts it to the minimum like any other small size.
  if (op.sizes.length !== split.children.length || !op.sizes.every((s) => Number.isFinite(s) && s >= 0)) {
    throw new WorkspaceError("invalid", `Expected ${split.children.length} non-negative sizes for split ${op.splitId}.`);
  }
  const sizes = normalizeSizes(op.sizes, split.children.length);
  if (sameSizes(sizes, split.sizes)) return { workspace: ws, changed: false };
  const tabs = ws.tabs.map((t) => (t.id === tab.id ? { ...t, root: setSplitSizes(t.root, op.splitId, sizes) } : t));
  return { workspace: { ...ws, tabs }, changed: true };
}

// ---------------------------------------------------------------------------------------------
// Validation of untrusted data
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function invalid(message: string): WorkspaceError {
  return new WorkspaceError("invalid", message);
}

/** Longest path a file pane takes (Linux's PATH_MAX). */
export const MAX_FILE_PATH = 4096;

/** An absolute path, no NUL, within `MAX_FILE_PATH`: what a file pane holds (resolving `~` and relative paths is the client's, through the files API). */
export function isFilePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= MAX_FILE_PATH && !value.includes("\0");
}

/**
 * Checks a stored or received workspace against every invariant (shape, unique ids, one pane per
 * session and per file path, the caps, sizes) and throws `WorkspaceError("invalid")` on the first violation. The server
 * guards loaded rows with it.
 */
export function validateWorkspace(ws: unknown): asserts ws is Workspace {
  if (!isRecord(ws) || !Array.isArray(ws.tabs)) throw invalid("A workspace is { tabs, version }.");
  if (!Number.isInteger(ws.version) || (ws.version as number) < 0) throw invalid("version must be a non-negative integer.");
  const ids = new Set<string>();
  const sessions = new Set<string>();
  const paths = new Set<string>();
  const claim = (id: unknown, what: string): void => {
    if (!isId(id)) throw invalid(`A ${what} needs an id.`);
    if (ids.has(id)) throw invalid(`Duplicate id ${id}.`);
    ids.add(id);
  };
  const checkNode = (node: unknown, depth: number): number => {
    if (!isRecord(node)) throw invalid("A layout node is a pane or a split.");
    if (node.kind === "pane") {
      claim(node.id, "pane");
      if (node.sessionId !== null) {
        if (!isId(node.sessionId)) throw invalid(`Pane ${node.id} has a bad sessionId.`);
        if (sessions.has(node.sessionId)) throw invalid(`Session ${node.sessionId} is open in two panes.`);
        sessions.add(node.sessionId);
      }
      return 1;
    }
    if (node.kind === "file") {
      claim(node.id, "pane");
      if (!isFilePath(node.path)) throw invalid(`File pane ${node.id} needs an absolute path.`);
      if (paths.has(node.path)) throw invalid(`${node.path} is open in two panes.`);
      paths.add(node.path);
      return 1;
    }
    if (node.kind !== "split") throw invalid("A layout node is a pane, a file pane or a split.");
    claim(node.id, "split");
    if (depth >= MAX_SPLIT_DEPTH) throw invalid(`Split ${node.id} nests deeper than ${MAX_SPLIT_DEPTH}.`);
    if (node.direction !== "row" && node.direction !== "column") throw invalid(`Split ${node.id} has a bad direction.`);
    if (!Array.isArray(node.children) || node.children.length < 2) throw invalid(`Split ${node.id} needs at least 2 children.`);
    if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) throw invalid(`Split ${node.id} needs one size per child.`);
    const sizes = node.sizes as unknown[];
    if (!sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s >= MIN_PANE_SIZE - 1e-6)) {
      throw invalid(`Split ${node.id} has a size under ${MIN_PANE_SIZE}.`);
    }
    const total = (sizes as number[]).reduce((sum, s) => sum + s, 0);
    if (Math.abs(total - 100) > 0.01) throw invalid(`Split ${node.id} sizes sum to ${total}, not 100.`);
    return node.children.reduce((count: number, child) => count + checkNode(child, depth + 1), 0);
  };
  for (const tab of ws.tabs as unknown[]) {
    if (!isRecord(tab)) throw invalid("A tab is an object.");
    claim(tab.id, "tab");
    if (tab.title !== null && (typeof tab.title !== "string" || tab.title.trim() === "" || tab.title.length > WORKSPACE_TAB_TITLE_MAX)) {
      throw invalid(`Tab ${tab.id} has a bad title.`);
    }
    if (tab.title === null ? tab.titleSource !== null : tab.titleSource !== "user" && tab.titleSource !== "portal") {
      throw invalid(`Tab ${tab.id} has a bad titleSource.`);
    }
    if (typeof tab.createdAt !== "number" || !Number.isFinite(tab.createdAt)) throw invalid(`Tab ${tab.id} has a bad createdAt.`);
    const panes = checkNode(tab.root, 0);
    if (panes > MAX_PANES_PER_TAB) throw invalid(`Tab ${tab.id} has ${panes} panes; the cap is ${MAX_PANES_PER_TAB}.`);
  }
}

const OPS = new Set(["open", "open_file", "replace_file", "replace_pane", "arrange", "close_tab", "close_pane", "move_tab", "rename_tab", "resize"]);
const EDGES = new Set<SplitEdge>(["left", "right", "top", "bottom"]);

/** Structural check of an op from JSON; answers a fresh object with only the known fields, or throws `invalid`. */
export function parseWorkspaceOp(input: unknown): WorkspaceOp {
  if (!isRecord(input) || typeof input.op !== "string" || !OPS.has(input.op)) throw invalid("Unknown workspace op.");
  const id = (key: string): string => {
    if (!isId(input[key])) throw invalid(`${input.op} needs a ${key}.`);
    return input[key] as string;
  };
  const optionalId = (key: string): string | undefined => {
    if (input[key] === undefined || input[key] === null) return undefined;
    return id(key);
  };
  const source = (key: string): "user" | "portal" => {
    if (input[key] !== "user" && input[key] !== "portal") throw invalid(`${input.op} needs ${key} "user" or "portal".`);
    return input[key] as "user" | "portal";
  };
  switch (input.op) {
    case "open": {
      if (!("sessionId" in input)) throw invalid("open needs a sessionId or null.");
      const sessionId = input.sessionId;
      if (sessionId !== null && !isId(sessionId)) throw invalid("open needs a sessionId or null.");
      const target = input.target ?? null;
      if (target === null) return { op: "open", sessionId };
      if (!isRecord(target) || !isId(target.tabId) || !isId(target.paneId) || !EDGES.has(target.edge as SplitEdge)) {
        throw invalid("open target needs tabId, paneId and an edge (left, right, top, bottom).");
      }
      return { op: "open", sessionId, target: { tabId: target.tabId, paneId: target.paneId, edge: target.edge as SplitEdge } };
    }
    case "open_file": {
      if (!isFilePath(input.path)) throw invalid(`open_file needs an absolute path (at most ${MAX_FILE_PATH} characters).`);
      const target = input.target ?? null;
      const path = normalizeFilePath(input.path);
      if (target === null) return { op: "open_file", path };
      if (!isRecord(target) || !isId(target.tabId) || !isId(target.paneId) || !EDGES.has(target.edge as SplitEdge)) {
        throw invalid("open_file target needs tabId, paneId and an edge (left, right, top, bottom).");
      }
      return { op: "open_file", path, target: { tabId: target.tabId, paneId: target.paneId, edge: target.edge as SplitEdge } };
    }
    case "replace_file": {
      if (!isFilePath(input.path)) throw invalid(`replace_file needs an absolute path (at most ${MAX_FILE_PATH} characters).`);
      return { op: "replace_file", paneId: id("paneId"), path: normalizeFilePath(input.path) };
    }
    case "replace_pane":
      return { op: "replace_pane", paneId: id("paneId"), sessionId: id("sessionId") };
    case "arrange": {
      if (!LAYOUT_PRESETS.includes(input.preset as LayoutPreset)) throw invalid(`arrange needs a preset: ${LAYOUT_PRESETS.join(", ")}.`);
      const list = input.sessionIds;
      if (!Array.isArray(list) || list.length > MAX_PANES_PER_TAB || !list.every((s) => s === null || isId(s))) {
        throw invalid(`arrange needs sessionIds: up to ${MAX_PANES_PER_TAB} session ids or nulls.`);
      }
      const op: WorkspaceOp = { op: "arrange", sessionIds: [...(list as (string | null)[])], preset: input.preset as LayoutPreset };
      const tabId = optionalId("tabId");
      if (tabId !== undefined) op.tabId = tabId;
      if (input.title !== undefined) {
        if (input.title !== null && typeof input.title !== "string") throw invalid("arrange title must be a string or null.");
        op.title = input.title;
      }
      if (input.titleSource !== undefined && input.titleSource !== null) op.titleSource = source("titleSource");
      return op;
    }
    case "close_tab":
      return { op: "close_tab", tabId: id("tabId") };
    case "close_pane":
      return { op: "close_pane", paneId: id("paneId") };
    case "move_tab": {
      if (!Number.isInteger(input.index) || (input.index as number) < 0) throw invalid("move_tab needs a non-negative integer index.");
      return { op: "move_tab", tabId: id("tabId"), index: input.index as number };
    }
    case "rename_tab": {
      const title = input.title ?? null;
      if (title !== null && typeof title !== "string") throw invalid("rename_tab title must be a string or null.");
      return { op: "rename_tab", tabId: id("tabId"), title, source: source("source") };
    }
    case "resize": {
      const sizes = input.sizes;
      if (!Array.isArray(sizes) || sizes.length === 0 || !sizes.every((s) => typeof s === "number" && Number.isFinite(s))) {
        throw invalid("resize needs an array of numbers.");
      }
      return { op: "resize", splitId: id("splitId"), sizes: [...(sizes as number[])] };
    }
  }
  throw invalid("Unknown workspace op.");
}
