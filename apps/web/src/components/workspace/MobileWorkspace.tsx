"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { PaneNode } from "@portal/contracts/workspace";
import AgentReplyToast from "./AgentReplyToast";
import PaneBar from "./PaneBar";
import PanesSheet from "./PanesSheet";
import type { SessionState } from "@/lib/session-state";
import type { SessionSummary } from "@/lib/types";
import { paneNeighbours, type PaneRef } from "@/lib/workspace-mobile";

export type MobileWorkspaceProps = {
  /** The panes to switch between, in order: the whole workspace flat on a phone, one tab's on a tablet. */
  panes: readonly PaneRef[];
  /** The pane the URL focuses; null while a resolver settles (nothing shows until it does), or with `empty`. */
  focused: PaneRef | null;
  /** A phone's empty workspace: the start page, shown with the bar (for Agent) and no panes. */
  empty?: ReactNode;
  /** The pane's content (the session pane with its menu wired to its tab). */
  renderPane: (tabId: string, pane: PaneNode) => ReactNode;
  titleOf: (pane: PaneNode) => string;
  stateOf: (sessionId: string) => SessionState | null;
  sessionOf: (sessionId: string) => SessionSummary | undefined;
  unreadPanes: ReadonlySet<string>;
  /** Show another pane: the URL changes the way a desktop focus change does. */
  onFocus: (tabId: string, paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onNewSession: () => void;
  /** The sheet's line under its title; the default names the workspace. */
  sheetDescription?: string;
};

/**
 * The flat workspace (decision 18): one pane at a time from `panes`, the bar under it to move to the
 * neighbours, open the sheet or open Agent, and Agent's reply preview over it. No strip, no splits.
 * Only the shown pane is mounted (the history cache makes switching cheap; a phone has no room for
 * background streams). The same component serves a tablet's tabs of 3 or 4 panes, scoped to that
 * tab (decision 20).
 */
export default function MobileWorkspace({
  panes,
  focused,
  empty,
  renderPane,
  titleOf,
  stateOf,
  sessionOf,
  unreadPanes,
  onFocus,
  onClosePane,
  onNewSession,
  sheetDescription,
}: MobileWorkspaceProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { index, previous, next } = useMemo(() => paneNeighbours(panes, focused?.pane.id ?? null), [panes, focused]);
  const root = useRef<HTMLDivElement>(null);
  return (
    <div ref={root} data-mobile-workspace data-pane-bar-host className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {focused ? renderPane(focused.tabId, focused.pane) : empty}
      {focused ? (
        <PaneBar
          title={titleOf(focused.pane)}
          state={focused.pane.sessionId !== null ? stateOf(focused.pane.sessionId) : null}
          index={index}
          count={panes.length}
          onPrevious={previous ? () => onFocus(previous.tabId, previous.pane.id) : null}
          onNext={next ? () => onFocus(next.tabId, next.pane.id) : null}
          onOpenSheet={() => setSheetOpen(true)}
        />
      ) : empty ? (
        <PaneBar title="Start page" state={null} index={0} count={0} onPrevious={null} onNext={null} onOpenSheet={() => {}} />
      ) : null}
      <AgentReplyToast host={root} />
      <PanesSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        panes={panes}
        focusedPaneId={focused?.pane.id ?? null}
        unreadPanes={unreadPanes}
        titleOf={titleOf}
        stateOf={stateOf}
        sessionOf={sessionOf}
        onFocus={onFocus}
        onClose={onClosePane}
        onNewSession={onNewSession}
        description={sheetDescription}
      />
    </div>
  );
}
