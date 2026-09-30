"use client";

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PanelRightClose, X } from "lucide-react";
import IconButton from "../IconButton";
import { useSessions } from "../SessionsProvider";
import { useMediaQuery } from "../useMediaQuery";
import { usePreference } from "../usePreference";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { panelSessionFromSearch, withPanelSession } from "@/lib/session-routes";
import { TRACKED_OPEN_KEY } from "@/lib/tracked-sessions";
import type { SessionSummary } from "@/lib/types";
import TrackedList from "./TrackedList";
import TrackedSessionView from "./TrackedSessionView";
import { TrackedToggle, useTrackedGroups, type TrackedRowActions } from "./parts";

/** The list mode's fixed width, px. */
export const TRACKED_LIST_WIDTH = 320;
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

  const actions: TrackedRowActions = useMemo(
    () => ({ onOpenFullPage, onAskPortal, untrack, onError: setError }),
    [onOpenFullPage, onAskPortal, untrack],
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
            className="!w-[min(360px,92vw)] gap-0 p-0"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document.getElementById("tracked-toggle")?.focus();
            }}
          >
            <SheetTitle className="sr-only">Tracked sessions</SheetTitle>
            <SheetDescription className="sr-only">The sessions you and Portal keep an eye on.</SheetDescription>
            {body(closeSheet, "Close tracked sessions", X, "tracked-sheet-list")}
          </SheetContent>
        </Sheet>
      )}
      {/* Rendered in the server HTML (the query's server value is wide) and hidden by CSS below 1280 px; not mounted once measured narrow, so a session never streams twice. */}
      {!wide ? null : expanded ? (
        <aside
          id="tracked-panel"
          aria-label="Tracked sessions"
          className="glass-subtle flex min-h-0 shrink-0 flex-col border-l border-white/5 max-xl:hidden"
          style={{ width: TRACKED_LIST_WIDTH }}
        >
          {body(() => setOpenPreference("false"), "Collapse tracked sessions", PanelRightClose, "tracked-list")}
        </aside>
      ) : (
        <aside
          id="tracked-panel"
          aria-label="Tracked sessions"
          className="glass-subtle flex w-12 shrink-0 flex-col items-center border-l border-white/5 py-3 max-xl:hidden"
        >
          <TrackedToggle expanded={false} controls="tracked-panel" onClick={() => setOpenPreference("true")} />
        </aside>
      )}
    </>
  );
}
