"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import IconButton from "../IconButton";
import { sessionStateLabels, type SessionState } from "@/lib/session-state";
import { paneCounter, swipeOutcome, viewportAfterResize, type ViewportSample } from "@/lib/workspace-mobile";

export type PaneBarProps = {
  /** The current pane's name. */
  title: string;
  /** Its session's state for the dot; null for a start page (drawn hollow). */
  state: SessionState | null;
  /** The pane's position in the switcher's list (0-based) and the list's length: "2 of 7". */
  index: number;
  count: number;
  /** Go to the neighbour; null at the ends (the chevron is disabled, the swipe does nothing). */
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  /** A tap on the bar (or Enter on its button): the panes sheet. */
  onOpenSheet: () => void;
};

/**
 * The slim bar under the composer on a phone (decision 18), and under a tablet's pane when its tab
 * is too big for a split (decision 20): the current pane's state dot and title, "2 of 7", chevrons
 * to the neighbours. A horizontal swipe on the bar switches panes (threshold 40 px, vertical drift
 * cancels); a tap opens the sheet. Hidden while the on-screen keyboard is up (`visualViewport`
 * shrank by more than 150 px), the way the composer's hint hides on touch. Nothing outside the
 * bar listens to gestures: swiping the transcript does nothing.
 */
export default function PaneBar({ title, state, index, count, onPrevious, onNext, onOpenSheet }: PaneBarProps) {
  const keyboardUp = useKeyboardUp();
  /** The gesture in flight: where it started and how far it has drifted vertically. */
  const gesture = useRef<{ pointerId: number; x: number; y: number; drift: number } | null>(null);
  /** Set when a pointer gesture already acted, so the click the browser sends after it does not open the sheet twice. */
  const consumed = useRef(false);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The chevrons act on their own click; a press on them is not a swipe.
    if (!event.isPrimary || (event.target as Element).closest("[data-pane-chevron]")) return;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, drift: 0 };
    consumed.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    g.drift = Math.max(g.drift, Math.abs(event.clientY - g.y));
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    const outcome = swipeOutcome(event.clientX - g.x, Math.max(g.drift, Math.abs(event.clientY - g.y)));
    // The browser's click follows in this same task; past it, the flag must not swallow a keyboard press.
    consumed.current = true;
    setTimeout(() => {
      consumed.current = false;
    }, 0);
    if (outcome === "next") onNext?.();
    else if (outcome === "previous") onPrevious?.();
    else if (outcome === "tap") onOpenSheet();
  };
  const pointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  };

  return (
    <div
      role="group"
      aria-label="Panes"
      data-pane-bar
      hidden={keyboardUp}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      className="flex shrink-0 select-none items-center gap-1 border-t border-white/5 bg-background/70 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm [touch-action:none]"
    >
      <IconButton label="Previous pane" data-pane-chevron size="icon-sm" disabled={!onPrevious} onClick={() => onPrevious?.()} className="text-muted-foreground">
        <ChevronLeft />
      </IconButton>
      <button
        type="button"
        data-pane-bar-title
        aria-haspopup="dialog"
        onClick={() => {
          // A pointer tap was handled on pointer up; this is the keyboard's (or a browser that sends the click here anyway).
          if (consumed.current) return;
          onOpenSheet();
        }}
        className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {state !== null ? (
          <span data-state={state} className="inline-flex shrink-0" aria-label={sessionStateLabels[state]}>
            <span className="status-dot" />
          </span>
        ) : (
          <span className="size-1.5 shrink-0 rounded-full border border-current opacity-50" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate text-foreground/90">{title}</span>
        <span data-pane-counter className="shrink-0 tabular-nums text-muted-foreground">
          {paneCounter(index, count)}
        </span>
      </button>
      <IconButton label="Next pane" data-pane-chevron size="icon-sm" disabled={!onNext} onClick={() => onNext?.()} className="text-muted-foreground">
        <ChevronRight />
      </IconButton>
    </div>
  );
}

/**
 * Whether the on-screen keyboard is up, from `visualViewport` resizes: true once the height has
 * dropped more than `KEYBOARD_DROP_PX` below the largest seen at this width, false when it comes
 * back. False where there is no `visualViewport` (server rendering, old browsers).
 */
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let sample: ViewportSample = viewportAfterResize(null, viewport.width, viewport.height);
    const resized = () => {
      sample = viewportAfterResize(sample, viewport.width, viewport.height);
      setUp(sample.keyboardUp);
    };
    viewport.addEventListener("resize", resized);
    return () => viewport.removeEventListener("resize", resized);
  }, []);
  return up;
}
