"use client";

import Link from "next/link";
import { navigateTo } from "@/lib/navigation";
import { roomCover } from "./layout";

/**
 * The phone's window onto the room (docs/PALACE.md, decision 6): a 72 px see-through strip above
 * the pane header that the room centres itself in. Tapping it opens the Palace page.
 */
export default function RoomStrip() {
  return (
    <Link
      ref={roomCover("focus")}
      href="/palace"
      prefetch={false}
      data-room-strip
      aria-label="Open the Palace"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        // In-app navigation, as everywhere in the shell: the routes render nothing of their own.
        event.preventDefault();
        navigateTo("/palace");
      }}
      className="block h-[72px] shrink-0 border-b border-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    />
  );
}
