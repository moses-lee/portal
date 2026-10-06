"use client";

import type { IconCellState } from "@/lib/workspace";

/**
 * A tab's miniature (decision 10): one cell per pane in the layout's shape, each a status dot in the
 * state colours the sidebar uses (`.status-dot` under `data-state`, one vocabulary), a hollow dot
 * for a start page, and a ring around the whole icon when the tab has unread news. Takes the cells
 * resolved (`tabCells`), so the tab item around it can compare them by value and skip renders.
 */
export default function TabIcon({ cells, unread }: { cells: readonly IconCellState[]; unread: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-unread={unread || undefined}
      className={`relative block h-3.5 w-5 shrink-0 rounded-[3px] ${unread ? "outline outline-1 outline-offset-2 outline-amber-300/80" : ""}`}
    >
      {cells.map((cell) => (
        <span
          key={cell.paneId}
          style={{ left: `${cell.x}%`, top: `${cell.y}%`, width: `${cell.width}%`, height: `${cell.height}%` }}
          className="absolute flex items-center justify-center border border-white/15"
        >
          {cell.sessionId !== null ? (
            // A session the list does not have is drawn as finished.
            <span data-state={cell.state ?? "finished"} className="inline-flex scale-[.66]">
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
