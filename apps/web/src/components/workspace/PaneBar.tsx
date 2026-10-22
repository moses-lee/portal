"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Bot, FileText, Layers } from "lucide-react";
import IconButton from "../IconButton";
import { useAgentInbox, type AgentInbox } from "../portal/AgentInbox";
import { sessionStateLabels, type SessionState } from "@/lib/session-state";
import { paneCounter, swipeOutcome, viewportAfterResize, type ViewportSample } from "@/lib/workspace-mobile";

export type PaneBarProps = {
  /** The current pane's name. */
  title: string;
  /** Its session's state for the dot; null for a start page (drawn hollow) or a file pane. */
  state: SessionState | null;
  /** A file pane (docs/FILES.md): a file glyph instead of the dot. */
  file?: boolean;
  /** The pane's position in the switcher's list (0-based) and the list's length: "2 of 7". */
  index: number;
  /** 0 on a phone's empty start page: no counter, no sheet, no swipe; the bar is there for Agent. */
  count: number;
  /** Go to the neighbour; null at the ends (the swipe does nothing). */
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  /** A tap on the bar, or its panes button: the panes sheet. */
  onOpenSheet: () => void;
};

/**
 * The slim bar under the composer on a phone (decision 18), and under a tablet's pane when its tab
 * is too big for a split (decision 20): Agent's button (its activity and unread news on it), the
 * current pane's state dot and title with "2 of 7", and the panes button. A horizontal swipe on the
 * bar switches panes (threshold 40 px, vertical drift cancels); a tap on the title opens the sheet.
 * Hidden while the on-screen keyboard is up (`visualViewport` shrank by more than 150 px), the way
 * the composer's hint hides on touch. Nothing outside the bar listens to gestures: swiping the
 * transcript does nothing.
 */
export default function PaneBar({ title, state, file = false, index, count, onPrevious, onNext, onOpenSheet }: PaneBarProps) {
  const keyboardUp = useKeyboardUp();
  const agent = useAgentInbox();
  /** The gesture in flight: where it started and how far it has drifted vertically. */
  const gesture = useRef<{ pointerId: number; x: number; y: number; drift: number } | null>(null);
  /** Set when a pointer gesture already acted, so the click the browser sends after it does not open the sheet twice. */
  const consumed = useRef(false);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The buttons either side act on their own click; a press on them is not a swipe.
    if (!event.isPrimary || count === 0 || (event.target as Element).closest("[data-pane-bar-button]")) return;
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
      {agent ? <AgentButton agent={agent} /> : <span className="size-8 shrink-0" />}
      <button
        type="button"
        data-pane-bar-title
        aria-haspopup="dialog"
        disabled={count === 0}
        onClick={() => {
          // A pointer tap was handled on pointer up; this is the keyboard's (or a browser that sends the click here anyway).
          if (consumed.current) return;
          onOpenSheet();
        }}
        className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        {file ? (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : state !== null ? (
          <span data-state={state} className="inline-flex shrink-0" aria-label={sessionStateLabels[state]}>
            <span className="status-dot" />
          </span>
        ) : (
          <span className="size-1.5 shrink-0 rounded-full border border-current opacity-50" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate text-foreground/90">{title}</span>
        {count > 0 && (
          <span data-pane-counter className="shrink-0 tabular-nums text-muted-foreground">
            {paneCounter(index, count)}
          </span>
        )}
      </button>
      {count > 0 ? (
        <IconButton label="Panes" data-pane-bar-button aria-haspopup="dialog" size="icon-sm" onClick={onOpenSheet} className="text-muted-foreground">
          <Layers />
        </IconButton>
      ) : (
        <span className="size-8 shrink-0" />
      )}
    </div>
  );
}

const agentActivityLabels = { working: "working", waiting: "waiting for your approval" } as const;

/**
 * Agent from the bar: one tap opens its sheet. The badge says what it is doing (an approval
 * waiting, then a reply being written) and otherwise whether the chat has news.
 */
function AgentButton({ agent }: { agent: AgentInbox }) {
  const busy = agent.activity === "working" || agent.activity === "waiting" ? agent.activity : null;
  const { unread } = agent;
  const label = ["Agent", busy && agentActivityLabels[busy], unread && "new messages"].filter(Boolean).join(", ");
  return (
    <IconButton
      label={label}
      data-pane-bar-button
      data-agent-button
      data-agent-activity={busy ?? undefined}
      data-unread={unread || undefined}
      aria-haspopup="dialog"
      size="icon-sm"
      onClick={() => agent.openAgent()}
      className="relative text-foreground/85"
    >
      <Bot />
      {busy ? (
        <span data-activity={busy} className="absolute top-1 right-1 inline-flex" aria-hidden="true">
          <span className="status-dot" />
        </span>
      ) : unread ? (
        <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-300/90" aria-hidden="true" />
      ) : null}
    </IconButton>
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
