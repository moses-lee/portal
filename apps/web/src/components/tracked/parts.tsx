"use client";

import { useMemo, useRef, useState } from "react";
import { Eye, EyeOff, ExternalLink, MessageCircleMore, MoreHorizontal, Square } from "lucide-react";
import { useSessions } from "../SessionsProvider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  groupTracked,
  shortSessionId,
  trackedAttentionCount,
  trackedStateLabels,
  type TrackedGroup,
  type TrackedState,
} from "@/lib/tracked-sessions";
import type { SessionSummary } from "@/lib/types";

/** The tracked sessions grouped for the panel, how many rows that makes, and how many wait on the user. */
export function useTrackedGroups(): { groups: TrackedGroup[]; count: number; attention: number } {
  const { tracked, sessions } = useSessions();
  return useMemo(() => {
    const groups = groupTracked(tracked, sessions);
    return {
      groups,
      count: groups.reduce((n, group) => n + group.rows.length, 0),
      attention: trackedAttentionCount(groups),
    };
  }, [tracked, sessions]);
}

/** A session's title, else its project and short id. */
export function trackedTitle(session: Pick<SessionSummary, "id" | "title" | "project">): string {
  if (session.title) return session.title;
  return session.project ? `${session.project.name} ${shortSessionId(session.id)}` : `Session ${shortSessionId(session.id)}`;
}

const badgeTone: Record<TrackedState, string> = {
  approval: "bg-amber-300/15 text-amber-200",
  finished: "bg-sky-300/15 text-sky-200",
  working: "bg-emerald-400/15 text-emerald-200",
  background: "bg-violet-400/15 text-violet-200",
  connecting: "bg-blue-300/10 text-blue-200/80",
  offline: "bg-destructive/15 text-red-200",
  hung: "bg-destructive/15 text-red-200",
};

export function TrackedStateBadge({ state, className }: { state: TrackedState; className?: string }) {
  return (
    <span
      data-state={state}
      className={cn("shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4 whitespace-nowrap", badgeTone[state], className)}
    >
      {trackedStateLabels[state]}
    </span>
  );
}

/**
 * The button that shows the tracked list: the desktop panel's collapsed strip and the mobile
 * header's entry. The badge counts sessions that wait on the user (needs approval or finished).
 */
export function TrackedToggle({
  id,
  expanded,
  controls,
  onClick,
  className,
}: {
  id?: string;
  /** Whether what it shows is open (`aria-expanded`). */
  expanded: boolean;
  /** The id of what it shows (`aria-controls`). */
  controls?: string;
  onClick: () => void;
  className?: string;
}) {
  const { attention } = useTrackedGroups();
  return (
    <Button
      id={id}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={attention ? `Show tracked sessions (${attention} waiting on you)` : "Show tracked sessions"}
      aria-expanded={expanded}
      aria-controls={controls}
      title="Tracked sessions"
      onClick={onClick}
      className={cn("relative text-muted-foreground", className)}
    >
      <Eye className="size-4" />
      {attention > 0 && (
        <span
          aria-hidden="true"
          data-testid="tracked-attention"
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-amber-300/90 px-1 text-[10px] font-semibold leading-4 text-black"
        >
          {attention}
        </span>
      )}
    </Button>
  );
}

export type TrackedRowActions = {
  /** Navigate to `/sessions/:id`. */
  onOpenFullPage: (sessionId: string) => void;
  /** Prefill the orchestrator composer about this session. */
  onAskPortal: (session: SessionSummary) => void;
  /** `DELETE /api/portal/tracked/:id`; rejects with the server's message. */
  untrack: (sessionId: string) => Promise<void>;
  /** Report a failed action (stop, untrack) where the panel shows errors. */
  onError: (message: string) => void;
};

async function stopTurn(sessionId: string) {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Could not stop the agent. Try again.");
  }
}

/** A tracked session's `…` menu: open full page, stop turn (only while working), ask Portal, untrack. */
export function TrackedRowMenu({
  session,
  state,
  actions,
  className,
}: {
  session: SessionSummary;
  state: TrackedState;
  actions: TrackedRowActions;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  /** Set by "Ask Portal": focus goes to the composer it filled, not back to this trigger. */
  const focusElsewhere = useRef(false);
  const title = trackedTitle(session);
  const run = (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    work()
      .catch((error: unknown) => actions.onError(error instanceof Error ? error.message : fallback))
      .finally(() => setBusy(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${title}`}
          disabled={busy}
          className={cn("text-muted-foreground", className)}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!focusElsewhere.current) return;
          focusElsewhere.current = false;
          event.preventDefault();
        }}
      >
        <DropdownMenuItem onSelect={() => actions.onOpenFullPage(session.id)}>
          <ExternalLink />
          Open full page
        </DropdownMenuItem>
        {state === "working" && (
          <DropdownMenuItem onSelect={() => run(() => stopTurn(session.id), "Could not stop the agent. Try again.")}>
            <Square />
            Stop turn
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            focusElsewhere.current = true;
            actions.onAskPortal(session);
          }}
        >
          <MessageCircleMore />
          Ask Portal about this
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run(() => actions.untrack(session.id), "Could not untrack the session. Try again.")}>
          <EyeOff />
          Untrack
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
