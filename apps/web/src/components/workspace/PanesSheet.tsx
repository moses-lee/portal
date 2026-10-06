"use client";

import { Plus, X } from "lucide-react";
import type { PaneNode } from "@portal/contracts/workspace";
import IconButton from "../IconButton";
import ResponsiveDialog from "../ResponsiveDialog";
import { TrackedStateBadge } from "../tracked/parts";
import { Button } from "@/components/ui/button";
import { sessionStateLabels, type SessionState } from "@/lib/session-state";
import type { SessionSummary } from "@/lib/types";
import type { PaneRef } from "@/lib/workspace-mobile";

export type PanesSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The panes in the switcher's order (the whole workspace flat on a phone; one tab's on a tablet). */
  panes: readonly PaneRef[];
  focusedPaneId: string | null;
  /** Panes with news since the device last showed them: an unread marker on their row. */
  unreadPanes: ReadonlySet<string>;
  titleOf: (pane: PaneNode) => string;
  stateOf: (sessionId: string) => SessionState | null;
  sessionOf: (sessionId: string) => SessionSummary | undefined;
  /** A row was tapped: show that pane (the sheet closes). */
  onFocus: (tabId: string, paneId: string) => void;
  /** The row's close button: `close_pane`, shared with every device (decision 19). */
  onClose: (paneId: string) => void;
  /** The "New session" button: a start-page tab, focused (the sheet closes). */
  onNewSession: () => void;
  /** What the list is, under the title: the workspace, or one tab. */
  description?: string;
};

/**
 * The bottom sheet the pane bar opens (decision 18): every pane in order, each with its state dot,
 * title, state badge, project and a close button; tapping a row shows it. "New session" at the
 * bottom opens a start-page tab. A dialog on wider screens, where `ResponsiveDialog` draws the line.
 */
export default function PanesSheet({
  open,
  onOpenChange,
  panes,
  focusedPaneId,
  unreadPanes,
  titleOf,
  stateOf,
  sessionOf,
  onFocus,
  onClose,
  onNewSession,
  description = "Every pane in your workspace, in order.",
}: PanesSheetProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Panes" description={description}>
      <ul data-panes-sheet className="-mx-2 flex flex-col pb-2">
        {panes.map(({ tabId, pane }) => {
          const title = titleOf(pane);
          const session = pane.sessionId !== null ? sessionOf(pane.sessionId) : undefined;
          const state = pane.sessionId !== null ? stateOf(pane.sessionId) : null;
          const current = pane.id === focusedPaneId;
          const unread = unreadPanes.has(pane.id);
          return (
            <li key={pane.id} data-pane-row={pane.id} data-current={current || undefined} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  onFocus(tabId, pane.id);
                  onOpenChange(false);
                }}
                className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left text-sm ${
                  current ? "bg-white/8" : "hover:bg-white/4"
                }`}
              >
                {state !== null ? (
                  <span data-state={state} className="inline-flex shrink-0" aria-label={sessionStateLabels[state]}>
                    <span className="status-dot" />
                  </span>
                ) : (
                  <span className="size-1.5 shrink-0 rounded-full border border-current opacity-50" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-foreground/90">{title}</span>
                    {unread && (
                      <span data-unread className="size-1.5 shrink-0 rounded-full bg-amber-300/90" aria-hidden="true" />
                    )}
                    {unread && <span className="sr-only">, unread</span>}
                  </span>
                  {(session?.project || state === null) && (
                    <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                      {session?.project ? session.project.name : "Start page"}
                    </span>
                  )}
                </span>
                {state !== null && <TrackedStateBadge state={state} />}
              </button>
              <IconButton label={`Close pane ${title}`} size="icon-sm" onClick={() => onClose(pane.id)} className="shrink-0 text-muted-foreground">
                <X />
              </IconButton>
            </li>
          );
        })}
      </ul>
      <div className="pb-2">
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => {
            onNewSession();
            onOpenChange(false);
          }}
        >
          <Plus />
          New session
        </Button>
      </div>
    </ResponsiveDialog>
  );
}
