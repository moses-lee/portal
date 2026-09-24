"use client";

import { Activity, Brain, MessagesSquare, ServerCog, ShieldAlert, Target, type LucideIcon } from "lucide-react";
import { usePortalLive } from "./PortalLive";
import type { PortalView } from "@/lib/session-routes";

/** The sidebar entry and page title of each Portal view; Chat is the home and keeps the page's old name. */
export const viewMeta: Record<PortalView, { label: string; title: string; icon: LucideIcon }> = {
  chat: { label: "Chat", title: "Talk to Portal", icon: MessagesSquare },
  goals: { label: "Goals", title: "Goals", icon: Target },
  activity: { label: "Activity", title: "Activity", icon: Activity },
  memory: { label: "Memory", title: "Memory", icon: Brain },
  system: { label: "System", title: "System", icon: ServerCog },
};

/** The numbers behind the sidebar's badges, per view, plus waiting approvals (which Chat shows first). */
export type PortalViewCounts = Record<PortalView, number> & { approvals: number };

/**
 * Read the live context once and reduce it to plain numbers, so the sidebar has a single subscriber
 * and its badges render from primitives instead of each reading the whole context.
 */
export function usePortalViewCounts(): PortalViewCounts {
  const { status, approvals } = usePortalLive();
  const counts = status?.counts;
  return {
    chat: counts?.needsYou ?? 0,
    goals: counts?.intents ?? 0,
    activity: 0,
    memory: counts?.inbox ?? 0,
    system: 0,
    approvals: approvals.length,
  };
}

/**
 * The count beside a view's sidebar entry: on Chat, waiting approvals first (they block work), else
 * open Needs-you items; on Goals the goals; on Memory the inbox. Nothing otherwise. Visual only: the
 * entry keeps its plain name, and the approvals dialog and the views announce the same counts.
 */
export default function PortalViewBadge({
  view,
  approvals,
  count,
}: {
  view: PortalView;
  /** Waiting approvals; only Chat shows them. */
  approvals: number;
  /** The view's own count from `usePortalViewCounts`. */
  count: number;
}) {
  if (view === "chat" && approvals > 0)
    return (
      <span aria-hidden="true" className="ml-auto flex items-center gap-0.5 rounded-full bg-amber-300/15 px-1.5 text-[10px] font-medium leading-4 text-amber-200">
        <ShieldAlert className="size-2.5" />
        {approvals}
      </span>
    );
  if (!count) return null;
  return (
    <span
      aria-hidden="true"
      className={`ml-auto rounded-full px-1.5 text-[10px] leading-4 ${view === "chat" ? "bg-amber-300/15 text-amber-200" : "bg-white/10 text-foreground/80"}`}
    >
      {count}
    </span>
  );
}
