"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  EyeOff,
  LoaderCircle,
  MessageCircleMore,
  MoreHorizontal,
  RotateCcw,
  ShieldQuestion,
  Timer,
} from "lucide-react";
import PortalMarkdown from "./PortalMarkdown";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  Item,
  ItemAction,
  ItemKind,
  ItemPatch,
} from "@/lib/orchestrator/types";

export const kindLabels: Record<ItemKind, string> = {
  session_finished: "Session finished",
  session_waiting: "Session waiting",
  session_offline: "Session offline",
  pr_checks_failing: "Checks failing",
  pr_changes_requested: "Changes requested",
  pr_conflicts: "Merge conflicts",
  pr_review_requested: "Review requested",
  pr_merged: "PR merged",
  pr_closed: "PR closed",
  worktree_merged: "Worktree merged",
  worktree_dirty: "Worktree dirty",
  folder_missing: "Folder missing",
  watch_update: "Follow-up",
  intent_update: "Goal update",
  approval_needed: "Needs approval",
  custom: "Note",
};

/**
 * What still asks for attention: open items, and snoozed ones whose snooze has run out. The
 * "Needs you" strip and the counts use this. Cards under a message are not filtered by it: the
 * thread stays an honest record, so resolved and dismissed items render there dimmed instead.
 */
export function isVisibleItem(item: Item, now = Date.now()): boolean {
  if (item.status === "open") return true;
  return item.status === "snoozed" && (item.snoozedUntil === null || item.snoozedUntil <= now);
}

export function actionLabel(action: ItemAction): string {
  if (action.label) return action.label;
  switch (action.type) {
    case "open_session":
      return "Open session";
    case "open_url":
      return "Open on GitHub";
    case "start_session":
      return "Start a session";
    case "send_prompt":
      return "Send to session";
    case "remove_worktree":
      return "Remove worktree";
    case "ask_portal":
      return "Ask Portal";
  }
}

/** Midnight tomorrow, local time. */
function tomorrowMorning(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";

async function readFailure(r: Response, fallback: string) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error ?? fallback);
}

export type ItemCardHandlers = {
  onOpenSession: (sessionId: string) => void;
  /** Send `text` to the orchestrator as if the user typed it; when it cannot go right now, the page keeps it in the composer. */
  onAsk: (text: string) => void;
  /** The server's copy of the item after a PATCH, so the list updates before the stream confirms. */
  onPatched: (item: Item) => void;
  /** Open the approvals dialog on this request (an item that links one, or an action the server gated). */
  onReviewApproval: (approvalId: string) => void;
};

/** "Resolved", "Dismissed", or "Snoozed until 09:00" for the badge row; null while the item is open. */
export function describeItemStatus(item: Item): string | null {
  switch (item.status) {
    case "resolved":
      return "Resolved";
    case "dismissed":
      return "Dismissed";
    case "snoozed":
      return item.snoozedUntil === null
        ? "Snoozed"
        : `Snoozed until ${new Date(item.snoozedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    default:
      return null;
  }
}

/**
 * One action item: title, Markdown body, kind badge, its action buttons, and a `⋯` menu to
 * resolve, snooze, or dismiss it (or reopen it once it is settled). `open_*` and `ask_portal`
 * actions run in the browser; the rest go to `POST /api/portal/items/[id]/actions/[index]`, which
 * may answer `{ approvalId }` when the server gates the action: the approvals dialog takes over.
 * An item that links an approval (`approval_needed`) gets a "Review request" button for the same
 * dialog. Settled items render dimmed with their status in the badge row.
 */
export default function PortalItemCard({
  item,
  onOpenSession,
  onAsk,
  onPatched,
  onReviewApproval,
}: { item: Item } & ItemCardHandlers) {
  const [pending, setPending] = useState<number | "menu" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  const flash = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };

  const perform = async (index: number) => {
    const action = item.actions[index];
    if (!action) return;
    setError(null);
    switch (action.type) {
      case "open_session":
        onOpenSession(action.sessionId);
        return;
      case "open_url":
        window.open(action.url, "_blank", "noopener,noreferrer");
        return;
      case "ask_portal":
        onAsk(action.text);
        return;
    }
    setPending(index);
    try {
      let r: Response;
      try {
        r = await fetch(
          `/api/portal/items/${encodeURIComponent(item.id)}/actions/${index}`,
          { method: "POST" },
        );
      } catch {
        throw new Error(NETWORK_ERROR);
      }
      if (!r.ok) throw await readFailure(r, "Could not run that action. Try again.");
      const result = (await r.json().catch(() => ({}))) as { sessionId?: string; approvalId?: string };
      if (result.approvalId) {
        flash("Waiting for your approval");
        onReviewApproval(result.approvalId);
      } else if (result.sessionId) onOpenSession(result.sessionId);
      else flash("Done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run that action. Try again.");
    } finally {
      setPending(null);
    }
  };

  const patch = async (body: ItemPatch) => {
    setError(null);
    setPending("menu");
    try {
      let r: Response;
      try {
        r = await fetch(`/api/portal/items/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error(NETWORK_ERROR);
      }
      if (!r.ok) throw await readFailure(r, "Could not update the item. Try again.");
      const { item: updated } = (await r.json()) as { item: Item };
      onPatched(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the item. Try again.");
    } finally {
      setPending(null);
    }
  };

  const settled = item.status === "resolved" || item.status === "dismissed";
  const approvalId = item.links.approvalId;
  const statusLabel = describeItemStatus(item);
  return (
    <article
      aria-label={item.title}
      data-status={item.status}
      className={`glass rounded-2xl p-4 text-[13px] ${settled ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase">
            <span className="rounded-full bg-amber-300/15 px-1.5 leading-4 text-amber-200">
              Needs you
            </span>
            <span className="text-muted-foreground">{kindLabels[item.kind]}</span>
            {statusLabel && <span className="text-muted-foreground">· {statusLabel}</span>}
          </div>
          <h3 className="text-[14px] font-medium leading-snug tracking-[-.01em]">
            {item.title}
          </h3>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`More actions for ${item.title}`}
              disabled={pending === "menu"}
              className="-mt-1 -mr-1 text-muted-foreground"
            >
              {pending === "menu" ? <LoaderCircle className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {item.status !== "open" && (
              <DropdownMenuItem onSelect={() => void patch({ status: "open", snoozedUntil: null })}>
                <RotateCcw />
                Reopen
              </DropdownMenuItem>
            )}
            {!settled && (
              <>
                <DropdownMenuItem onSelect={() => void patch({ status: "resolved", snoozedUntil: null })}>
                  <Check />
                  Resolve
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void patch({ status: "snoozed", snoozedUntil: Date.now() + 3_600_000 })}
                >
                  <Timer />
                  Snooze 1h
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void patch({ status: "snoozed", snoozedUntil: tomorrowMorning() })}
                >
                  <Timer />
                  Snooze until tomorrow
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => void patch({ status: "dismissed", snoozedUntil: null })}
                >
                  <EyeOff />
                  Dismiss
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {item.body && (
        <div className="mt-2 text-foreground/85">
          <PortalMarkdown text={item.body} compact />
        </div>
      )}
      {(item.actions.length > 0 || notice || approvalId) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {approvalId && !settled && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onReviewApproval(approvalId)}
              className="text-xs"
            >
              <ShieldQuestion />
              Review request
            </Button>
          )}
          {item.actions.map((action, index) => (
            <Button
              key={index}
              type="button"
              size="sm"
              variant={index === 0 && !approvalId ? "secondary" : "ghost"}
              disabled={pending !== null}
              onClick={() => void perform(index)}
              className="text-xs"
            >
              {pending === index ? (
                <LoaderCircle className="animate-spin" />
              ) : action.type === "open_url" ? (
                <ExternalLink />
              ) : action.type === "ask_portal" ? (
                <MessageCircleMore />
              ) : null}
              {actionLabel(action)}
            </Button>
          ))}
          {notice && (
            <span role="status" className="text-xs text-muted-foreground">
              {notice}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
