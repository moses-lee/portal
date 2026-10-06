"use client";

import type { LayoutNode } from "@portal/contracts/workspace";
import type { SessionState } from "@/lib/session-state";
import { iconCells } from "@/lib/workspace";

/**
 * A tab's miniature (decision 10): one cell per pane in the layout's shape, each a status dot in the
 * state colours the sidebar uses (`.status-dot` under `data-state`, one vocabulary), a hollow dot
 * for a start page, and a ring around the whole icon when the tab has unread news.
 */
export default function TabIcon({
  root,
  stateOf,
  unread,
}: {
  root: LayoutNode;
  /** The session's state, or null when the list does not have it (drawn as finished). */
  stateOf: (sessionId: string) => SessionState | null;
  unread: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-unread={unread || undefined}
      className={`relative block h-3.5 w-5 shrink-0 rounded-[3px] ${unread ? "outline outline-1 outline-offset-2 outline-amber-300/80" : ""}`}
    >
      {iconCells(root).map((cell) => (
        <span
          key={cell.paneId}
          style={{ left: `${cell.x}%`, top: `${cell.y}%`, width: `${cell.width}%`, height: `${cell.height}%` }}
          className="absolute flex items-center justify-center border border-white/15"
        >
          {cell.sessionId !== null ? (
            <span data-state={stateOf(cell.sessionId) ?? "finished"} className="inline-flex scale-[.66]">
              <span className="status-dot" />
            </span>
          ) : (
            <span className="size-1 rounded-full border border-current opacity-50" />
          )}
        </span>
      ))}
    </span>
  );
}
