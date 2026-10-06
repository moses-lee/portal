import type { LayoutNode, PaneNode, SplitNode, Tab, Workspace } from "@portal/contracts/workspace";

/**
 * Builders for the workspace `setupPortal({ workspace })` seeds and `pushWorkspace` delivers. Ids are
 * the test's own (`t1`, `p1`, `x1`); ids the fixture's op handler generates are `w1`, `w2`, ... in
 * the order the reducer draws them (an `open` draws the pane first, then its tab or split; an
 * `arrange` draws each split before its children).
 */

export function pane(id: string, sessionId: string | null): PaneNode {
  return { kind: "pane", id, sessionId };
}

/** A split with equal sizes unless given. */
export function split(id: string, direction: SplitNode["direction"], children: LayoutNode[], sizes?: number[]): SplitNode {
  return { kind: "split", id, direction, children, sizes: sizes ?? children.map(() => 100 / children.length) };
}

export function tab(id: string, root: LayoutNode, named?: { title: string; titleSource: "user" | "portal" }): Tab {
  return { id, title: named?.title ?? null, titleSource: named?.titleSource ?? null, root, createdAt: 1_700_000_000_000 };
}

export function workspaceOf(tabs: Tab[], version = 1): Workspace {
  return { tabs, version };
}
