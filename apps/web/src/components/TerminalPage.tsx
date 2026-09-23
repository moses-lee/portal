"use client";

import dynamic from "next/dynamic";
import { PanelLeft } from "lucide-react";
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
}: {
  onOpenSidebar: () => void;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="workspace-header">
        <IconButton
          id="sidebar-toggle"
          label="Toggle sidebar"
          onClick={onOpenSidebar}
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
      </header>
      <div className="min-h-0 flex-1">
        <TerminalPanel endpoint="/api/terminals" />
      </div>
    </main>
  );
}
