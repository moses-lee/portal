"use client";

import { useEffect, useMemo, useRef } from "react";
import { PanelLeft, X } from "lucide-react";
import IconButton from "./IconButton";
import PortalChat from "./portal/PortalChat";
import PortalStatusLine from "./portal/PortalStatusLine";
import { usePortalLive } from "./portal/PortalLive";

/** Kept mounted behind other surfaces so drafts, streams and scroll positions survive dismissal. */
export default function AgentPage({ open, onClose, onNavigate, onOpenSidebar }: {
  open: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onOpenSidebar: (opener?: HTMLElement | null) => void;
}) {
  const { error } = usePortalLive();
  const page = useRef<HTMLElement>(null);
  const positions = useRef(new Map<HTMLElement, { top: number; atEnd: boolean }>());
  const handlers = useMemo(() => ({ onOpenCurationRun: (runId: string) => onNavigate(`/memory/curation/${encodeURIComponent(runId)}`) }), [onNavigate]);

  useEffect(() => {
    if (!open) return;
    const focus = () => {
      const textarea = page.current?.querySelector<HTMLTextAreaElement>("[data-agent-chat] textarea:not(:disabled)");
      if (!textarea) return false;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return true;
    };
    for (const [viewport, position] of positions.current) {
      if (viewport.clientHeight > 0) viewport.scrollTop = position.atEnd ? viewport.scrollHeight : position.top;
    }
    if (focus()) return;
    const observer = new MutationObserver(() => focus() && observer.disconnect());
    if (page.current) observer.observe(page.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    return () => observer.disconnect();
  }, [open]);

  return (
    <main
      ref={page}
      hidden={!open}
      data-page-overlay={open ? "" : undefined}
      data-agent-page=""
      aria-label="Agent"
      className="page-overlay flex-col text-sm"
      onScrollCapture={(event) => {
        const viewport = event.target;
        if (!open || !(viewport instanceof HTMLElement) || !viewport.matches('[data-slot="message-scroller-viewport"]')) return;
        positions.current.set(viewport, { top: viewport.scrollTop, atEnd: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 80 });
      }}
    >
      <header className="workspace-header !h-auto min-h-14">
        <IconButton label="Toggle sidebar" onClick={(event) => onOpenSidebar(event.currentTarget)} className="text-muted-foreground"><PanelLeft className="size-4" /></IconButton>
        <div className="min-w-0 flex-1 py-2">
          <h1 className="text-[13px] font-medium">Agent</h1>
          <PortalStatusLine />
        </div>
        <IconButton label="Close Agent" onClick={onClose} className="text-muted-foreground"><X className="size-4" /></IconButton>
      </header>
      {error && <p role="alert" className="shrink-0 border-b border-white/5 px-5 py-2 text-xs text-destructive">{error}</p>}
      <PortalChat visible={open} handlers={handlers} onNavigate={onNavigate} />
    </main>
  );
}
