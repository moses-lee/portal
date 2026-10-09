"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { PanelRightClose, X } from "lucide-react";
import IconButton from "../IconButton";
import { useSessions } from "../SessionsProvider";
import { useMediaQuery } from "../useMediaQuery";
import { usePreference } from "../usePreference";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { panelSessionFromSearch, withPanelSession } from "@/lib/session-routes";
import {
  MAIN_PANE_MIN_WIDTH,
  TRACKED_LIST_WIDTH,
  TRACKED_OPEN_KEY,
  TRACKED_SESSION_MIN_WIDTH,
  TRACKED_WIDTH_KEY,
  parseTrackedWidth,
  trackedSessionWidth,
} from "@/lib/tracked-sessions";
import type { SessionSummary } from "@/lib/types";
import TrackedList from "./TrackedList";
import TrackedSessionView from "./TrackedSessionView";
import { TrackedToggle, useTrackedGroups, type TrackedRowActions } from "./parts";

/** From this width up the panel pushes the main pane aside; below it the panel is a sheet (the GitHub inspector's breakpoint). */
export const TRACKED_PUSH_QUERY = "(min-width: 1280px)";

/** Show a session in the panel, or its list (null): `?session=` on the current Portal path. */
export function setPanelSession(sessionId: string | null) {
  window.history.pushState(null, "", withPanelSession(window.location.pathname, sessionId));
}

export type TrackedPanelProps = {
  /** Below 1280 px: whether the list sheet is open (the header's toggle opens it). */
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
  /** Navigate to a session's full page (`/sessions/:id`). */
  onOpenFullPage: (sessionId: string) => void;
  /** "Ask Portal about this": prefill the orchestrator composer. */
  onAskPortal: (session: SessionSummary) => void;
};

/**
 * The panel with its session read from the URL (`?session=`). `useSearchParams` needs a Suspense
 * boundary on the prerendered Portal routes; render `TrackedPanel` with `selected={null}` as its
 * fallback so the prerendered page already has the list and nothing shifts at hydration.
 */
export function TrackedPanelFromUrl(props: TrackedPanelProps) {
  const selected = panelSessionFromSearch(useSearchParams().toString());
  return <TrackedPanel {...props} selected={selected} />;
}

/**
 * The tracked sessions beside every Portal view. Two modes: the list (`selected` null), or one
 * session. At 1280 px and up it is a push panel after the main pane (CSS decides, so it is in the
 * server HTML): 320 px in list mode, or a slim toggle when collapsed (`portal.tracked.open`); a
 * selected session opens it whatever the preference says. Below that it is a right sheet, opened
 * from the Portal header or by a selected session; closing the sheet clears `?session=`.
 */
export default function TrackedPanel({
  selected,
  sheetOpen,
  onSheetOpenChange,
  onOpenFullPage,
  onAskPortal,
}: TrackedPanelProps & { selected: string | null }) {
  // Assume wide until measured: the sheet is JS-driven, and must not flash open on a wide screen.
  const wide = useMediaQuery(TRACKED_PUSH_QUERY, true);
  const [openPreference, setOpenPreference] = usePreference(TRACKED_OPEN_KEY, "true");
  const { sessions, loading, untrack } = useSessions();
  const { groups, count } = useTrackedGroups();
  const [error, setError] = useState<string | null>(null);
  const selectedSession = useMemo(
    () => (selected ? sessions.find((session) => session.id === selected) : undefined),
    [selected, sessions],
  );

  /**
   * Below 1280 px the sheet is modal and would keep focus from the composer "Ask Portal" fills, so
   * the sheet closes first and the ask runs once it has, in place of returning focus to the toggle.
   */
  const pendingAsk = useRef<SessionSummary | null>(null);
  const actions: TrackedRowActions = useMemo(
    () => ({
      onOpenFullPage,
      onAskPortal: (session: SessionSummary) => {
        if (wide) return onAskPortal(session);
        pendingAsk.current = session;
        onSheetOpenChange(false);
        if (selected) setPanelSession(null);
      },
      untrack,
      onError: setError,
    }),
    [onOpenFullPage, onAskPortal, untrack, wide, onSheetOpenChange, selected],
  );
  const select = useCallback((sessionId: string) => {
    setError(null);
    setPanelSession(sessionId);
  }, []);
  const back = useCallback(() => setPanelSession(null), []);

  const body = (onClose: () => void, closeLabel: string, CloseIcon: typeof X, listId: string) =>
    selected ? (
      <TrackedSessionView
        key={selected}
        sessionId={selected}
        session={selectedSession}
        loading={loading}
        onBack={back}
        actions={actions}
      />
    ) : (
      <>
        <header className="flex items-center gap-2 border-b border-white/5 py-2 pr-2 pl-4">
          <h2 className="flex-1 text-[13px] font-medium">Tracked ({count})</h2>
          <IconButton
            label={closeLabel}
            aria-expanded={true}
            aria-controls={listId}
            onClick={onClose}
            className="text-muted-foreground"
          >
            <CloseIcon className="size-4" />
          </IconButton>
        </header>
        {error && (
          <p role="alert" className="border-b border-white/5 px-4 py-1.5 text-[11px] text-destructive">
            {error}
          </p>
        )}
        <TrackedList id={listId} groups={groups} loading={loading} onSelect={select} actions={actions} />
      </>
    );

  const closeSheet = () => {
    onSheetOpenChange(false);
    if (selected) setPanelSession(null);
  };
  const expanded = openPreference === "true" || selected !== null;

  return (
    <>
      {!wide && (
        <Sheet
          open={sheetOpen || selected !== null}
          onOpenChange={(open) => (open ? onSheetOpenChange(true) : closeSheet())}
        >
          <SheetContent
            id="tracked-sheet"
            showCloseButton={false}
            // A session takes the whole screen; the list is a narrow sheet.
            className={selected ? "!w-screen !max-w-none gap-0 p-0" : "!w-[min(360px,92vw)] gap-0 p-0"}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const ask = pendingAsk.current;
              pendingAsk.current = null;
              if (ask) onAskPortal(ask);
              else document.getElementById("tracked-toggle")?.focus();
            }}
          >
            <SheetTitle className="sr-only">Tracked sessions</SheetTitle>
            <SheetDescription className="sr-only">The sessions you and Portal keep an eye on.</SheetDescription>
            {body(closeSheet, "Close tracked sessions", X, "tracked-sheet-list")}
          </SheetContent>
        </Sheet>
      )}
      {/* Rendered in the server HTML (the query's server value is wide) and hidden by CSS below 1280 px; not mounted once measured narrow, so a session never streams twice. */}
      {!wide ? null : selected ? (
        <SessionAside>
          {body(() => setOpenPreference("false"), "Collapse tracked sessions", PanelRightClose, "tracked-list")}
        </SessionAside>
      ) : expanded ? (
        <aside
          id="tracked-panel"
          aria-label="Tracked sessions"
          className="frost-subtle flex min-h-0 shrink-0 flex-col border-l border-white/5 max-xl:hidden"
          style={{ width: TRACKED_LIST_WIDTH }}
        >
          {body(() => setOpenPreference("false"), "Collapse tracked sessions", PanelRightClose, "tracked-list")}
        </aside>
      ) : (
        <aside
          id="tracked-panel"
          aria-label="Tracked sessions"
          className="frost-subtle flex w-12 shrink-0 flex-col items-center border-l border-white/5 py-3 max-xl:hidden"
        >
          <TrackedToggle expanded={false} controls="tracked-panel" onClick={() => setOpenPreference("true")} />
        </aside>
      )}
    </>
  );
}

/**
 * The desktop panel in session mode: resizable with the same hand-rolled separator as the sidebar,
 * persisted in `portal.tracked.width`. The first open takes half the space beside the sidebar; the width is clamped so
 * the main pane (the element before the panel) keeps 480 px.
 */
function SessionAside({ children }: { children: ReactNode }) {
  const [stored, store] = usePreference(TRACKED_WIDTH_KEY, "");
  // The sidebar's width, read as `Sidebar` does, for the pre-measure width below.
  const [sidebarOpen] = usePreference("portal.sidebar.open", "true");
  const [sidebarStored] = usePreference("portal.sidebar.width", "280");
  const sidebarWidth = sidebarOpen === "true" ? Math.max(240, Math.min(400, Number(sidebarStored) || 280)) : 0;
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const aside = useRef<HTMLElement>(null);
  /** The room the panel shares with the main pane (the shell less the sidebar); measured, so null until the first layout. */
  const [room, setRoom] = useState<{ shared: number } | null>(null);
  useEffect(() => {
    const panel = aside.current;
    const main = panel?.previousElementSibling as HTMLElement | null | undefined;
    const shell = panel?.parentElement;
    if (!panel || !main || !shell) return;
    const observer = new ResizeObserver(() => {
      const shared = panel.offsetWidth + main.offsetWidth;
      setRoom((prev) => (prev?.shared === shared ? prev : { shared }));
    });
    observer.observe(shell);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);
  const clamp = (wanted: number | null) => (room ? trackedSessionWidth({ wanted, ...room }) : (wanted ?? TRACKED_SESSION_MIN_WIDTH));
  const width = dragWidth ?? clamp(parseTrackedWidth(stored));
  const max = room ? clamp(Number.MAX_SAFE_INTEGER) : width;
  return (
    <aside
      ref={aside}
      id="tracked-panel"
      aria-label="Tracked sessions"
      className="frost-subtle relative flex min-h-0 shrink-0 flex-col border-l border-white/5 max-xl:hidden"
      // Until measured: half the space beside the sidebar, less whatever would leave the thread under 480 px.
      style={{
        width:
          room || stored
            ? width
            : `min(calc((100% - ${sidebarWidth}px) / 2), calc(100% - ${sidebarWidth + MAIN_PANE_MIN_WIDTH}px))`,
      }}
    >
      <div
        role="separator"
        aria-label="Resize tracked session"
        aria-orientation="vertical"
        aria-valuemin={TRACKED_SESSION_MIN_WIDTH}
        aria-valuemax={max}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-white/5 focus-visible:bg-white/10"
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId) || !aside.current) return;
          setDragWidth(clamp(aside.current.getBoundingClientRect().right - e.clientX));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (dragWidth !== null) store(String(dragWidth));
          setDragWidth(null);
        }}
        onPointerCancel={() => setDragWidth(null)}
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          // The handle is on the left edge: moving it left widens the panel.
          const next =
            e.key === "Home"
              ? TRACKED_SESSION_MIN_WIDTH
              : e.key === "End"
                ? max
                : width + (e.key === "ArrowLeft" ? 16 : -16);
          store(String(clamp(next)));
        }}
      />
      {children}
    </aside>
  );
}
