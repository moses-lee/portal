"use client";

import dynamic from "next/dynamic";
import { PanelLeft, X } from "lucide-react";
import IconButton from "./IconButton";

const TerminalPanel = dynamic(() => import("./TerminalPanel"), {
  ssr: false,
  loading: () => (
    <p className="p-4 text-xs text-muted-foreground">Opening terminal…</p>
  ),
});

/** The standalone terminal page: shells owned by no session fill the main column, tabs and all. */
export default function TerminalPage({
  onOpenSidebar,
  onClose,
}: {
  onOpenSidebar: (opener?: HTMLElement | null) => void;
  onClose: () => void;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="workspace-header">
        <IconButton
          id="sidebar-toggle"
          label="Toggle sidebar"
          onClick={(event) => onOpenSidebar(event.currentTarget)}
          className="text-muted-foreground"
        >
          <PanelLeft className="size-4" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="text-[13px] font-medium leading-snug tracking-[-.01em]">
            Terminal
          </h1>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Not tied to a conversation. Shells keep running while you work
            elsewhere.
          </p>
        </div>
        <IconButton label="Close page" onClick={onClose}><X className="size-4" /></IconButton>
      </header>
      <div className="min-h-0 flex-1">
        <TerminalPanel endpoint="/api/terminals" autoCreate />
      </div>
    </main>
  );
}
