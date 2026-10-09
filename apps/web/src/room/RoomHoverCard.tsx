"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import type { RoomCard, RoomTarget } from "./live";
import { hideCard, readCard, subscribeCard } from "./pointer";

const GAP = 16;
const EDGE = 8;
const serverCard = () => null;

/**
 * The room's hover card (docs/PALACE.md, Hover and click): beside the pointer, kept inside the
 * viewport, naming the object, what it stands for, its numbers, and where a click goes. Hovering it
 * follows the pointer and lets every event through; pinned (a tap on a phone, the window, a robot
 * that waved on the Palace page) it takes clicks, and carries the button that navigates. It is
 * `.frost-subtle`, so the canvas blurs the room under it like any panel.
 */
export default function RoomHoverCard({
  describe,
  open,
}: {
  describe: (target: RoomTarget) => RoomCard | null;
  open: (target: RoomTarget) => void;
}) {
  const state = useSyncExternalStore(subscribeCard, readCard, serverCard);
  const card = state ? describe(state.target) : null;
  const element = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !state) return;
    const { width, height } = node.getBoundingClientRect();
    // Below and to the right of the pointer, flipped to the other side where the viewport ends.
    let left = state.x + GAP;
    let top = state.y + GAP;
    if (left + width > window.innerWidth - EDGE) left = state.x - GAP - width;
    if (top + height > window.innerHeight - EDGE) top = state.y - GAP - height;
    node.style.left = `${Math.max(EDGE, left)}px`;
    node.style.top = `${Math.max(EDGE, top)}px`;
  });

  if (!state || !card) return null;
  const pinned = state.pinned;
  return createPortal(
    <div
      ref={element}
      data-room-card={state.target.kind}
      role={pinned ? "dialog" : "tooltip"}
      aria-label={card.title}
      className="frost-subtle fixed z-50 w-64 rounded-xl px-3.5 py-3 text-xs leading-relaxed shadow-lg"
      style={{ pointerEvents: pinned ? "auto" : "none", left: state.x + GAP, top: state.y + GAP }}
    >
      <p className="truncate text-[13px] font-medium text-foreground">{card.title}</p>
      <p className="text-muted-foreground">{card.about}</p>
      <ul className="mt-1.5 space-y-0.5 text-foreground/90">
        {card.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {card.credit && (
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="mt-1.5 block text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Weather data by Open-Meteo.com
        </a>
      )}
      {pinned
        ? card.action && (
            <Button
              size="sm"
              className="mt-2.5 w-full"
              onClick={() => {
                hideCard();
                open(state.target);
              }}
            >
              {card.action}
            </Button>
          )
        : card.hint && <p className="mt-1.5 text-muted-foreground">{card.hint}</p>}
    </div>,
    document.body,
  );
}
