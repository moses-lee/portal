/**
 * The workspace: the ordered strip of tabs every device shows, each tab a session or a split of up
 * to four panes (docs/WORKSPACE.md). Stored server-side in one `settings` row, pushed over the portal
 * stream as `{ type: "workspace", workspace }`, and edited through operations that the pure reducer in
 * `@portal/shared/workspace` applies on the server and optimistically in the web app.
 *
 * HTTP surface:
 *   GET  /api/workspace       { workspace }
 *   POST /api/workspace/ops   body WorkspaceOp -> { workspace, location? }; 400 malformed, 404 unknown session, 409 refused
 *
 * Invariants (the reducer enforces them, `validateWorkspace` checks loaded data): a session id is in
 * at most one pane; at most 4 panes per tab; split depth at most 2; a split has 2 or more children;
 * `sizes` has one entry per child, each at least 10, summing to 100.
 */

/** One view: a session, or the start page (`sessionId: null`) that becomes a session once one is created. */
export type PaneNode = { kind: "pane"; id: string; sessionId: string | null };

/** Divides its space among `children`, side by side (`row`) or stacked (`column`); `sizes` are percents summing to 100. */
export type SplitNode = { kind: "split"; id: string; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] };

export type LayoutNode = PaneNode | SplitNode;

/** `title` null: the UI derives one from the panes' sessions. `titleSource` says who named it; `user` outranks `portal`. */
export type Tab = { id: string; title: string | null; titleSource: "user" | "portal" | null; root: LayoutNode; createdAt: number };

/** `version` increments on every server write; the reducer leaves it alone. */
export type Workspace = { tabs: Tab[]; version: number };

/** The six shapes the UI and the orchestrator arrange with. */
export type LayoutPreset = "single" | "columns-2" | "columns-3" | "rows-2" | "grid-2x2" | "one-beside-two";

export const LAYOUT_PRESETS: readonly LayoutPreset[] = ["single", "columns-2", "columns-3", "rows-2", "grid-2x2", "one-beside-two"];

/** Longest tab title a rename accepts (after trimming). */
export const WORKSPACE_TAB_TITLE_MAX = 60;

/** Which side of a pane a new pane opens on: left/right split it as a row, top/bottom as a column. */
export type SplitEdge = "left" | "right" | "top" | "bottom";

/** Where a pane lives, so a caller can navigate to it (`/tabs/<tabId>?pane=<paneId>`). */
export type WorkspaceLocation = { tabId: string; paneId: string };

/** What the sending device is looking at, sent beside an orchestrator chat message; every field null on a Portal page. */
export type WorkspaceView = { sessionId: string | null; tabId: string | null; paneId: string | null };

/**
 * One edit, applied whole. `op` is the discriminant.
 * - `open`: a session (or null, a start page). Already open: no change, its location. No `target`: a new
 *   tab at the end. With `target`: a new pane on that `edge` of the pane.
 * - `replace_pane`: the pane shows `sessionId` (a start page becoming its session, or "open here"). A
 *   session open elsewhere moves: its old pane closes.
 * - `arrange`: build `preset` from `sessionIds` (slots past the list are start pages) in a new tab, or
 *   rebuild `tabId` in place. Sessions open elsewhere move; sessions the rebuilt tab held that the preset
 *   has no room for each go to a new tab right after it. `title` names the tab, as `titleSource` (default `user`).
 * - `close_tab`, `close_pane`: remove; a split left with one child collapses into it; an empty tab is removed.
 * - `move_tab`: to `index` (0-based, within the strip).
 * - `rename_tab`: `title` 1 to 60 characters after trimming, or null to clear; a `portal` rename never overwrites a `user` one.
 * - `resize`: new `sizes` for a split, normalised and clamped. Not logged to Activity.
 */
export type WorkspaceOp =
  | { op: "open"; sessionId: string | null; target?: { tabId: string; paneId: string; edge: SplitEdge } | null }
  | { op: "replace_pane"; paneId: string; sessionId: string }
  | {
      op: "arrange";
      sessionIds: (string | null)[];
      preset: LayoutPreset;
      tabId?: string | null;
      title?: string | null;
      titleSource?: "user" | "portal" | null;
    }
  | { op: "close_tab"; tabId: string }
  | { op: "close_pane"; paneId: string }
  | { op: "move_tab"; tabId: string; index: number }
  | { op: "rename_tab"; tabId: string; title: string | null; source: "user" | "portal" }
  | { op: "resize"; splitId: string; sizes: number[] };
