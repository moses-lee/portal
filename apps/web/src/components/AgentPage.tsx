"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, X } from "lucide-react";
import IconButton from "./IconButton";
import PortalThread from "./portal/PortalThread";
import PortalStatusLine from "./portal/PortalStatusLine";
import ThreadSwitcher from "./portal/ThreadSwitcher";
import { usePortalLive } from "./portal/PortalLive";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";

/** Kept mounted behind other surfaces so drafts, streams and scroll positions survive dismissal. */
export default function AgentPage({ open, onClose, threadId, onThreadChange, onNavigate, onOpenSidebar, unread }: {
  open: boolean;
  onClose: () => void;
  threadId: string;
  onThreadChange: (threadId: string) => void;
  onNavigate: (path: string) => void;
  onOpenSidebar: (opener?: HTMLElement | null) => void;
  unread: ReadonlySet<string>;
}) {
  const { error, threads } = usePortalLive();
  const [visited, setVisited] = useState([threadId]);
  if (!visited.includes(threadId)) setVisited([...visited, threadId]);
  const page = useRef<HTMLElement>(null);
  const positions = useRef(new Map<HTMLElement, { top: number; atEnd: boolean }>());
  const handlers = useMemo(() => ({ onOpenCurationRun: (runId: string) => onNavigate(`/memory/curation/${encodeURIComponent(runId)}`) }), [onNavigate]);
  const openWatches = useCallback(() => onNavigate("/watches"), [onNavigate]);

  useEffect(() => {
    if (!open) return;
    const focus = () => {
      const textarea = page.current?.querySelector<HTMLTextAreaElement>(`[data-thread="${CSS.escape(threadId)}"] textarea:not(:disabled)`);
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
  }, [open, threadId]);

  const exists = threadId === MAIN_THREAD_ID || threads.some((thread) => thread.id === threadId);
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
          <PortalStatusLine onOpenThread={onThreadChange} />
        </div>
        <IconButton label="Close Agent" onClick={onClose} className="text-muted-foreground"><X className="size-4" /></IconButton>
      </header>
      {error && <p role="alert" className="shrink-0 border-b border-white/5 px-5 py-2 text-xs text-destructive">{error}</p>}
      <ThreadSwitcher current={threadId} unread={unread} onSelect={onThreadChange} />
      {!exists && threads.length > 0 && <p role="alert" className="px-6 pt-4 text-sm text-destructive">Portal has no thread with the id “{threadId}”.</p>}
      {visited.map((id) => <PortalThread key={id} threadId={id} thread={threads.find((thread) => thread.id === id) ?? null} visible={open && id === threadId} handlers={handlers} onOpenWatches={openWatches} onNavigate={onNavigate} />)}
    </main>
  );
}
