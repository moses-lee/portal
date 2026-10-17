"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type UIEventHandler } from "react";
import { createPortal } from "react-dom";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Bot, X } from "lucide-react";
import IconButton from "./IconButton";
import PortalThread from "./portal/PortalThread";
import PortalStatusLine from "./portal/PortalStatusLine";
import ThreadSwitcher from "./portal/ThreadSwitcher";
import { usePortalLive } from "./portal/PortalLive";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";
import { sheetDragCloses, TAP_SLOP_PX } from "@/lib/workspace-mobile";

export type AgentDialogProps = {
  open: boolean;
  onClose: () => void;
  threadId: string;
  onThreadChange: (threadId: string) => void;
  /** The shell decides whether a link opens another surface or leaves the conversation open. */
  onNavigate: (path: string) => void;
  /** Threads with news, from the shell's inbox (`useAgentInboxState`), for the switcher's dots. */
  unread: ReadonlySet<string>;
};

/**
 * Agent has its own conversation surface; dismissing it leaves its threads and streams alive. A
 * centred panel from 640 px up; below, a bottom sheet under a strip of the page, closed by dragging
 * its grip or header down (`useSheetDrag`), tapping the strip, or its close button.
 */
export default function AgentDialog({ open, onClose, threadId, onThreadChange, onNavigate, unread }: AgentDialogProps) {
  const { error } = usePortalLive();
  const returnTo = useRef<HTMLElement | null>(null);
  const navigating = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    navigating.current = false;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  const closeAutoFocus = (event: Event) => {
    event.preventDefault();
    const target = returnTo.current;
    if (!navigating.current && target) (target.isConnected ? target : document.getElementById("sidebar-toggle"))?.focus();
    returnTo.current = null;
  };
  const navigate = useCallback((path: string) => {
    // Thread links keep this dialog open; other destinations receive focus from the shell.
    navigating.current = !/^\/(?:threads\/[^/?#]+)?(?:[?#].*)?$/.test(path);
    onNavigate(path);
  }, [onNavigate]);
  const onOpenChange = useCallback((next: boolean) => !next && onClose(), [onClose]);
  const { sheet, dragHandlers } = useSheetDrag(onClose);

  /**
   * A stable portal target keeps the React conversation mounted while Radix's dialog shell
   * unmounts. The detached host preserves streams and scroll without retaining a focus trap,
   * scroll lock, or aria-hidden attributes on the rest of the app after dismissal.
   */
  const bodyHost = useRef<HTMLDivElement | null>(null);
  const scrollPositions = useRef(new Map<HTMLElement, { top: number; atEnd: boolean }>());
  const rememberScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    const viewport = event.target;
    if (!open || !(viewport instanceof HTMLElement) || !viewport.isConnected || !viewport.matches('[data-slot="message-scroller-viewport"]')) return;
    scrollPositions.current.set(viewport, { top: viewport.scrollTop, atEnd: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 80 });
  }, [open]);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const attachBody = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    if (!bodyHost.current) {
      bodyHost.current = document.createElement("div");
      bodyHost.current.className = "flex min-h-0 flex-1 flex-col";
      setHost(bodyHost.current);
    }
    element.appendChild(bodyHost.current);
  }, []);

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay data-room-slow="" className="fixed inset-0 isolate z-50 bg-black/45 duration-100 supports-backdrop-filter:backdrop-blur-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <DialogPrimitive.Content
            ref={sheet}
            data-agent-dialog="" data-palette-dialog=""
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              // On reopening, the retained composer has already mounted in a detached host.
              // Focus it after Radix reattaches the host, rather than in its earlier effect.
              const textarea = bodyHost.current?.querySelector<HTMLTextAreaElement>(`[data-thread="${CSS.escape(threadId)}"] textarea:not([disabled])`);
              if (textarea) {
                textarea.focus();
                textarea.setSelectionRange(textarea.value.length, textarea.value.length);
              } else {
                document.querySelector<HTMLButtonElement>('[data-agent-dialog] [aria-label="Close Agent"]')?.focus();
              }
              // Browsers reset a detached scroll container's offset. Restore it after
              // focus, which can itself scroll the retained content into view.
              for (const [viewport, position] of scrollPositions.current) {
                if (viewport.clientHeight > 0) viewport.scrollTo({ top: position.atEnd ? viewport.scrollHeight - viewport.clientHeight : position.top });
              }
            }}
            onCloseAutoFocus={closeAutoFocus}
            onPointerDownOutside={(event) => {
              // The retained body is a React portal; its DOM belongs to the dialog even
              // though its React ancestry survives independently of the dismissable shell.
              const target = event.detail.originalEvent.target;
              if (target instanceof Node && bodyHost.current?.contains(target)) event.preventDefault();
            }}
            className="glass fixed inset-x-0 top-[calc(env(safe-area-inset-top)+2.5rem)] bottom-0 z-50 flex flex-col overflow-hidden rounded-t-2xl text-sm text-popover-foreground outline-none duration-200 ease-out data-open:animate-in data-closed:animate-out max-sm:data-open:slide-in-from-bottom max-sm:data-closed:slide-out-to-bottom sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[85dvh] sm:w-[60vw] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:duration-100 sm:data-open:fade-in-0 sm:data-closed:fade-out-0"
          >
            {/* The grip: the sheet's drag handle on a phone (the header drags too). */}
            <div data-agent-grip aria-hidden="true" {...dragHandlers} className="flex shrink-0 cursor-grab justify-center pt-2 pb-1 [touch-action:none] sm:hidden">
              <span className="h-1 w-9 rounded-full bg-white/25" />
            </div>
            <header {...dragHandlers} className="flex shrink-0 items-start gap-3 border-b border-white/[0.07] px-5 py-3 max-sm:pt-1 max-sm:[touch-action:none]">
              <Bot className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-[13px] font-medium">Agent</DialogPrimitive.Title>
                <DialogPrimitive.Description className="sr-only">Talk to Portal and read its conversations.</DialogPrimitive.Description>
                <PortalStatusLine onOpenThread={onThreadChange} />
              </div>
              <IconButton label="Close Agent" className="size-7 shrink-0 text-muted-foreground" onClick={onClose}>
                <X className="size-4" />
              </IconButton>
            </header>
            {error && <p role="alert" className="shrink-0 border-b border-white/5 px-5 py-2 text-xs text-destructive">{error}</p>}
            <div ref={attachBody} className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]" />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      {host && createPortal(<AgentConversations open={open} unread={unread} threadId={threadId} onThreadChange={onThreadChange} onNavigate={navigate} host={host} onScrollCapture={rememberScroll} />, host)}
    </>
  );
}

function AgentConversations({ open, threadId, onThreadChange, onNavigate, unread, host, onScrollCapture }: Pick<AgentDialogProps, "open" | "threadId" | "onThreadChange" | "onNavigate" | "unread"> & { host: HTMLDivElement; onScrollCapture: UIEventHandler<HTMLDivElement> }) {
  const { threads } = usePortalLive();
  const [visited, setVisited] = useState([threadId]);
  if (!visited.includes(threadId)) setVisited([...visited, threadId]);
  const handlers = useMemo(() => ({ onOpenCurationRun: (runId: string) => onNavigate(`/memory/curation/${encodeURIComponent(runId)}`) }), [onNavigate]);
  const openWatches = useCallback(() => onNavigate("/watches"), [onNavigate]);

  useEffect(() => {
    if (!open) return;
    const focus = () => {
      const textarea = host.querySelector<HTMLTextAreaElement>(`[data-thread="${CSS.escape(threadId)}"] textarea`);
      if (!textarea || textarea.disabled || !textarea.isConnected) return false;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => focus() && observer.disconnect());
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    return () => observer.disconnect();
  }, [open, threadId, host]);

  const exists = threadId === MAIN_THREAD_ID || threads.some((thread) => thread.id === threadId);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col [&_.composer-wrap]:!px-5 [&_.composer-wrap]:!pb-4 [&_.conversation-content]:!px-6 [&_.conversation-content]:!pt-5 max-sm:[&_.composer-wrap]:!px-3 max-sm:[&_.conversation-content]:!px-4"
      onScrollCapture={onScrollCapture}
      onKeyDownCapture={(event) => {
        if (event.key !== "Tab") return;
        // Extend Radix's focus loop through the independently retained portal body.
        const dialog = host.closest('[role="dialog"]');
        const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
          .filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <ThreadSwitcher current={threadId} unread={unread} onSelect={onThreadChange} />
      {!exists && threads.length > 0 && <p role="alert" className="px-6 pt-4 text-sm text-destructive">Portal has no thread with the id “{threadId}”.</p>}
      {visited.map((id) => <PortalThread key={id} threadId={id} thread={threads.find((thread) => thread.id === id) ?? null} visible={id === threadId} handlers={handlers} onOpenWatches={openWatches} onNavigate={onNavigate} />)}
    </div>
  );
}

/** Where the dialog is a bottom sheet (below Tailwind's `sm`), so its grip and header drag. */
const SHEET_QUERY = "(max-width: 639px)";

/**
 * Drag-to-close for the phone sheet: a pointer on the grip or header that moves down past the tap
 * slop takes over (captured, so a press that started on a header button does not click it), the
 * sheet follows it on `translate`, and on release `sheetDragCloses` decides between closing and
 * springing back. `translate` composes with the exit animation's `transform`, so a close slides
 * on from where the finger left it.
 */
function useSheetDrag(onClose: () => void) {
  const sheet = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ pointerId: number; y: number; dragging: boolean; lastY: number; lastAt: number; speed: number } | null>(null);
  const settle = useCallback((closing: boolean) => {
    const element = sheet.current;
    if (!element) return;
    if (closing) return onClose();
    element.style.transition = "translate 200ms ease-out";
    element.style.translate = "";
  }, [onClose]);
  const dragHandlers = useMemo(() => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!event.isPrimary || !window.matchMedia(SHEET_QUERY).matches) return;
      gesture.current = { pointerId: event.pointerId, y: event.clientY, dragging: false, lastY: event.clientY, lastAt: event.timeStamp, speed: 0 };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      const element = sheet.current;
      if (!g || g.pointerId !== event.pointerId || !element) return;
      const dy = Math.max(0, event.clientY - g.y);
      if (!g.dragging) {
        if (dy <= TAP_SLOP_PX) return;
        g.dragging = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        element.style.transition = "none";
      }
      const elapsed = event.timeStamp - g.lastAt;
      if (elapsed > 0) g.speed = (event.clientY - g.lastY) / elapsed;
      g.lastY = event.clientY;
      g.lastAt = event.timeStamp;
      element.style.translate = `0 ${dy}px`;
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;
      gesture.current = null;
      // A finger that stopped before lifting is not flicking.
      const speed = event.timeStamp - g.lastAt > 100 ? 0 : g.speed;
      if (g.dragging) settle(sheetDragCloses(Math.max(0, event.clientY - g.y), speed));
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;
      gesture.current = null;
      if (g.dragging) settle(false);
    },
  }), [settle]);
  return { sheet, dragHandlers };
}
