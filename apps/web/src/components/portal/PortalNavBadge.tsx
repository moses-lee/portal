"use client";

import { ShieldAlert } from "lucide-react";
import { usePortalLive } from "./PortalLive";

/**
 * The count beside the sidebar's Talk to Portal button: waiting approvals first (they block work),
 * else open Needs-you items. Nothing when neither. Visual only: the button keeps its plain name,
 * and the approvals dialog and the Portal page announce the same counts themselves.
 */
export default function PortalNavBadge() {
  const { status, approvals } = usePortalLive();
  if (approvals.length > 0)
    return (
      <span aria-hidden="true" className="ml-auto flex items-center gap-0.5 rounded-full bg-amber-300/15 px-1.5 text-[10px] font-medium leading-4 text-amber-200">
        <ShieldAlert className="size-2.5" />
        {approvals.length}
      </span>
    );
  const needsYou = status?.counts.needsYou ?? 0;
  if (!needsYou) return null;
  return (
    <span aria-hidden="true" className="ml-auto rounded-full bg-white/10 px-1.5 text-[10px] leading-4 text-foreground/80">
      {needsYou}
    </span>
  );
}
