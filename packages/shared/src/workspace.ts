/**
 * The workspace reducer (docs/WORKSPACE.md): applies one `WorkspaceOp` to a `Workspace` and answers
 * the new one, never touching the input. The server runs it before saving; the web app runs it
 * optimistically. Pure and dependency-free: ids come from the caller, so tests are deterministic, and
 * `version` is the store's business, not the reducer's.
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

/** The leaves of a layout, in reading order (left to right, top to bottom). */
export function panesOf(node: LayoutNode): PaneNode[] {
  return node.kind === "pane" ? [node] : node.children.flatMap(panesOf);
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

export function locatePane(ws: Workspace, paneId: string): { tabId: string; pane: PaneNode } | null {
  return allPanes(ws).find(({ pane }) => pane.id === paneId) ?? null;
}

export function locateSession(ws: Workspace, sessionId: string): WorkspaceLocation | null {
  const hit = allPanes(ws).find(({ pane }) => pane.sessionId === sessionId);
  return hit ? { tabId: hit.tabId, paneId: hit.pane.id } : null;
}

/** A pane is depth 0; a split is one more than its deepest child. */
export function depthOf(node: LayoutNode): number {
  return node.kind === "pane" ? 0 : 1 + Math.max(...node.children.map(depthOf));
}

function findSplit(node: LayoutNode, splitId: string): SplitNode | null {
  if (node.kind === "pane") return null;
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
  if (root.kind === "pane") return "single";
  const kids = root.children;
  const allPanesFlat = kids.every((c) => c.kind === "pane");
  if (root.direction === "row" && allPanesFlat) return kids.length === 2 ? "columns-2" : kids.length === 3 ? "columns-3" : null;
  if (root.direction === "column" && allPanesFlat) return kids.length === 2 ? "rows-2" : null;
  const isRowOfTwoPanes = (n: LayoutNode) => n.kind === "split" && n.direction === "row" && n.children.length === 2 && n.children.every((c) => c.kind === "pane");
  if (root.direction === "column" && kids.length === 2 && kids.every(isRowOfTwoPanes)) return "grid-2x2";
  const isColumnOfTwoPanes = (n: LayoutNode) => n.kind === "split" && n.direction === "column" && n.children.length === 2 && n.children.every((c) => c.kind === "pane");
  if (root.direction === "row" && kids.length === 2 && kids[0].kind === "pane" && isColumnOfTwoPanes(kids[1])) return "one-beside-two";
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

/**
 * The name a tab shows (decision 25): its own `title` if set; else the session's title, "A + B" for
 * two, "N sessions" past that, and "New session" when it holds only start pages. A session with no
 * title reads "Untitled".
 */
export function defaultTabTitle(tab: Tab, titleOf: (sessionId: string) => string | null): string {
  if (tab.title !== null) return tab.title;
  const sessions = tabPanes(tab).flatMap((pane) => (pane.sessionId === null ? [] : [pane.sessionId]));
  if (sessions.length === 0) return "New session";
  if (sessions.length > 2) return `${sessions.length} sessions`;
  return sessions.map((id) => titleOf(id) ?? "Untitled").join(" + ");
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
  if (node.kind === "pane") return node.id === paneId ? null : node;
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
function insertBeside(node: LayoutNode, paneId: string, pane: PaneNode, edge: SplitEdge, ids: () => string): LayoutNode {
  const direction = edge === "left" || edge === "right" ? "row" : "column";
  const before = edge === "left" || edge === "top";
  if (node.kind === "pane") {
    if (node.id !== paneId) return node;
    return { kind: "split", id: ids(), direction, children: before ? [pane, node] : [node, pane], sizes: [50, 50] };
  }
  const index = node.children.findIndex((child) => child.kind === "pane" && child.id === paneId);
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

function setPaneSession(node: LayoutNode, paneId: string, sessionId: string | null): LayoutNode {
  if (node.kind === "pane") return node.id === paneId ? { ...node, sessionId } : node;
  return { ...node, children: node.children.map((child) => setPaneSession(child, paneId, sessionId)) };
}

function setSplitSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((child) => setSplitSizes(child, splitId, sizes)) };
}

function assertCaps(root: LayoutNode): void {
  const count = panesOf(root).length;
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
  const pane: PaneNode = { kind: "pane", id: ids(), sessionId: op.sessionId };
  if (!op.target) {
    const tab = newTab(pane, ids, now);
    return { workspace: { ...ws, tabs: [...ws.tabs, tab] }, location: { tabId: tab.id, paneId: pane.id }, changed: true };
  }
  const { tabId, paneId, edge } = op.target;
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
  if (hit.pane.sessionId === op.sessionId) return { workspace: ws, location, changed: false };
  // Decision 22: the session moves here; its old pane closes first.
  const tabs = withoutSession(ws.tabs, op.sessionId).map((tab) =>
    tab.id === hit.tabId ? { ...tab, root: setPaneSession(tab.root, op.paneId, op.sessionId) } : tab,
  );
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
    // Sessions the old tab held that found no slot each get a tab of their own, right after it.
    const overflow = tabPanes(existing)
      .flatMap((pane) => (pane.sessionId === null || listed.includes(pane.sessionId) ? [] : [pane.sessionId]))
      .map((sessionId) => newTab({ kind: "pane", id: ids(), sessionId }, ids, now));
    const index = tabs.findIndex((t) => t.id === existing.id);
    tabs = [...tabs.slice(0, index), tab, ...overflow, ...tabs.slice(index + 1)];
  } else {
    tab = { ...newTab(root, ids, now), ...named };
    tabs = [...tabs, tab];
  }
  return { workspace: { ...ws, tabs }, location: { tabId: tab.id, paneId: panesOf(root)[0].id }, changed: true };
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

/**
 * Checks a stored or received workspace against every invariant (shape, unique ids, one pane per
 * session, the caps, sizes) and throws `WorkspaceError("invalid")` on the first violation. The server
 * guards loaded rows with it.
 */
export function validateWorkspace(ws: unknown): asserts ws is Workspace {
  if (!isRecord(ws) || !Array.isArray(ws.tabs)) throw invalid("A workspace is { tabs, version }.");
  if (!Number.isInteger(ws.version) || (ws.version as number) < 0) throw invalid("version must be a non-negative integer.");
  const ids = new Set<string>();
  const sessions = new Set<string>();
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
    if (node.kind !== "split") throw invalid("A layout node is a pane or a split.");
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

const OPS = new Set(["open", "replace_pane", "arrange", "close_tab", "close_pane", "move_tab", "rename_tab", "resize"]);
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
