/**
 * The phone and tablet rules of the workspace (docs/WORKSPACE.md, decisions 18 to 20): which
 * viewport class a device is, which tabs render as splits there, the pane switcher's list and
 * neighbours, the bar's swipe decision from pointer deltas, and keyboard-up detection from
 * `visualViewport` samples. No React, no DOM: the node test runner loads this file directly.
 */
import type { PaneNode, Tab, Workspace } from "@portal/contracts/workspace";
import { panesOf, tabPanes } from "@portal/shared/workspace";
import { flatPanes } from "./workspace.ts";

// ---------------------------------------------------------------------------------------------
// Viewport classes
// ---------------------------------------------------------------------------------------------

/** Below this width the workspace is the flat pane list (decision 18). */
export const MOBILE_MAX_WIDTH = 767;
/** Up to this width tabs of 3 or 4 panes show one pane with the switcher (decision 20). */
export const TABLET_MAX_WIDTH = 1100;

/** The media queries the view subscribes to; `viewportKind` combines their answers. */
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
export const NARROW_QUERY = `(max-width: ${TABLET_MAX_WIDTH}px)`;

export type ViewportKind = "mobile" | "tablet" | "desktop";

/** From the two media queries: `mobile` is `MOBILE_QUERY`, `narrow` is `NARROW_QUERY` (true on phones too). */
export function viewportKind(mobile: boolean, narrow: boolean): ViewportKind {
  if (mobile) return "mobile";
  return narrow ? "tablet" : "desktop";
}

/** The class of a viewport `width` pixels wide; the same rule as the media queries, for tests and reasoning. */
export function viewportKindOf(width: number): ViewportKind {
  return viewportKind(width <= MOBILE_MAX_WIDTH, width <= TABLET_MAX_WIDTH);
}

/** The most panes a tablet renders side by side; bigger tabs show one pane with the switcher. */
export const TABLET_SPLIT_MAX_PANES = 2;

/** Whether the tab renders as a split tree on this viewport: always on desktop, up to 2 panes on a tablet, never on a phone. */
export function tabRendersSplit(tab: Pick<Tab, "root">, kind: ViewportKind): boolean {
  if (kind === "desktop") return true;
  if (kind === "mobile") return false;
  return panesOf(tab.root).length <= TABLET_SPLIT_MAX_PANES;
}

/**
 * Which panes the device shows of the focused tab: all of them (`tab`) or only the focused one
 * (`pane`). Drives unread (a pane the device does not show counts as hidden, decision 30) and the
 * pane switcher.
 */
export type FocusScope = "tab" | "pane";

export function focusScope(tab: Pick<Tab, "root"> | null, kind: ViewportKind): FocusScope {
  if (!tab) return "tab";
  return tabRendersSplit(tab, kind) ? "tab" : "pane";
}

// ---------------------------------------------------------------------------------------------
// The pane switcher's list
// ---------------------------------------------------------------------------------------------

export type PaneRef = { tabId: string; pane: PaneNode };

/**
 * The panes the switcher moves between: on a phone every pane of every tab in flat order; on a
 * tablet the panes of `tab` when it is too big for a split; null when there is no switcher (desktop,
 * or a tab the tablet renders as a split).
 */
export function switcherPanes(ws: Workspace, tab: Tab | null, kind: ViewportKind): PaneRef[] | null {
  if (kind === "mobile") return flatPanes(ws);
  if (kind === "tablet" && tab && !tabRendersSplit(tab, kind)) return tabPanes(tab).map((pane) => ({ tabId: tab.id, pane }));
  return null;
}

export type PaneNeighbours<T> = {
  /** The pane's position in the list (0-based), or -1 when it is not there. */
  index: number;
  previous: T | null;
  next: T | null;
};

/** Where `paneId` stands in the list and the panes either side of it; no wrapping (the ends have none). */
export function paneNeighbours<T extends { pane: PaneNode }>(panes: readonly T[], paneId: string | null): PaneNeighbours<T> {
  const index = paneId === null ? -1 : panes.findIndex(({ pane }) => pane.id === paneId);
  if (index < 0) return { index, previous: null, next: null };
  return { index, previous: panes[index - 1] ?? null, next: panes[index + 1] ?? null };
}

/** The bar's counter: "2 of 7" (1-based). */
export function paneCounter(index: number, count: number): string {
  return `${index + 1} of ${count}`;
}

// ---------------------------------------------------------------------------------------------
// The swipe
// ---------------------------------------------------------------------------------------------

/** How far the pointer must travel sideways on the bar to switch panes. */
export const SWIPE_THRESHOLD_PX = 40;
/** Vertical travel past this, at any point of the gesture, cancels it (the user meant something else). */
export const SWIPE_DRIFT_PX = 30;
/** Travel within this in both directions is a tap. */
export const TAP_SLOP_PX = 8;

/**
 * What a finished gesture on the bar means. `dx` is the pointer's horizontal travel from where it
 * went down (positive to the right); `drift` the largest vertical distance it reached during the
 * gesture. Swiping left (`dx` negative) pulls the next pane in; swiping right the previous one.
 */
export type SwipeOutcome = "previous" | "next" | "tap" | "none";

export function swipeOutcome(dx: number, drift: number): SwipeOutcome {
  if (drift > SWIPE_DRIFT_PX) return "none";
  if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) return dx < 0 ? "next" : "previous";
  if (Math.abs(dx) <= TAP_SLOP_PX && drift <= TAP_SLOP_PX) return "tap";
  return "none";
}

// ---------------------------------------------------------------------------------------------
// Keyboard up
// ---------------------------------------------------------------------------------------------

/** A `visualViewport` height this much below its largest means the on-screen keyboard is up. */
export const KEYBOARD_DROP_PX = 150;

export type ViewportSample = {
  width: number;
  /** The tallest the viewport has been at this width. */
  largestHeight: number;
  keyboardUp: boolean;
};

/**
 * The tracker's state after a `visualViewport` resize. The keyboard is up when the height has dropped
 * more than `drop` below the largest seen; a width change (rotation, a pinch zoom) starts over, since
 * a landscape viewport is legitimately shorter than a portrait one.
 */
export function viewportAfterResize(previous: ViewportSample | null, width: number, height: number, drop = KEYBOARD_DROP_PX): ViewportSample {
  if (!previous || previous.width !== width) return { width, largestHeight: height, keyboardUp: false };
  const largestHeight = Math.max(previous.largestHeight, height);
  return { width, largestHeight, keyboardUp: largestHeight - height > drop };
}
