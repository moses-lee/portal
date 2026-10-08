"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, ExternalLink, MessageCircleMore, MoreHorizontal, Square } from "lucide-react";
import { useSessions } from "../SessionsProvider";
import { Button } from "@/components/ui/button";
import { MenuItem, MenuSeparator } from "../ActionMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
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

/**
 * How many background tasks a session reports. Read through an optional field: the list entry only
 * carries `backgroundTasks` once the server reports them, and older servers never do.
 */
export function backgroundTaskCount(session: object): number {
  const tasks = (session as { backgroundTasks?: readonly unknown[] | null }).backgroundTasks;
  return Array.isArray(tasks) ? tasks.length : 0;
}

/** A session's state badge; a background session adds its task count when it has one ("Background · 2"). */
export function TrackedStateBadge({ state, tasks = 0, className }: { state: TrackedState; tasks?: number; className?: string }) {
  const label = trackedStateLabels[state];
  const count = state === "background" && tasks > 0 ? tasks : 0;
  return (
    <span
      data-state={state}
      title={count ? `${count} background ${count === 1 ? "task" : "tasks"} running` : undefined}
      className={cn("shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4 whitespace-nowrap", badgeTone[state], className)}
    >
      {label}
      {count > 0 && ` · ${count}`}
    </span>
  );
}

/**
 * The button that shows the tracked list: the desktop panel's collapsed strip and the mobile
 * header's entry. The badge counts sessions stuck on the user (needs approval, offline or hung).
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

/** A tracked session's menu, shared by its `…` button (`TrackedRowMenu`) and a right-click on its row or header (`ContextActions`). */
export type TrackedRowMenuState = {
  /** The items: open full page, stop turn (only while working), ask Portal, untrack. Null without a session. */
  items: ReactNode;
  /** An action is running: the button is disabled and the context menu off. */
  busy: boolean;
  onCloseAutoFocus: (event: Event) => void;
};

export function useTrackedRowMenu(
  session: SessionSummary | null,
  state: TrackedState | null,
  actions: TrackedRowActions,
): TrackedRowMenuState {
  const [busy, setBusy] = useState(false);
  /** Set by "Ask Portal": focus goes to the composer it filled, not back to this trigger. */
  const focusElsewhere = useRef(false);
  const run = (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    work()
      .catch((error: unknown) => actions.onError(error instanceof Error ? error.message : fallback))
      .finally(() => setBusy(false));
  };
  const onCloseAutoFocus = (event: Event) => {
    if (!focusElsewhere.current) return;
    focusElsewhere.current = false;
    event.preventDefault();
  };
  const items = session && state && (
    <>
      <MenuItem onSelect={() => actions.onOpenFullPage(session.id)}>
        <ExternalLink />
        Open full page
      </MenuItem>
      {state === "working" && (
        <MenuItem onSelect={() => run(() => stopTurn(session.id), "Could not stop the agent. Try again.")}>
          <Square />
          Stop turn
        </MenuItem>
      )}
      <MenuItem
        onSelect={() => {
          focusElsewhere.current = true;
          actions.onAskPortal(session);
        }}
      >
        <MessageCircleMore />
        Ask Portal about this
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => run(() => actions.untrack(session.id), "Could not untrack the session. Try again.")}>
        <EyeOff />
        Untrack
      </MenuItem>
    </>
  );
  return { items, busy, onCloseAutoFocus };
}

/** A tracked session's `…` button, opening the items from `useTrackedRowMenu`. */
export function TrackedRowMenu({
  menu,
  title,
  className,
}: {
  menu: TrackedRowMenuState;
  title: string;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${title}`}
          disabled={menu.busy}
          className={cn("text-muted-foreground", className)}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        {menu.items}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
