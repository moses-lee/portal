"use client";

import { Button } from "@/components/ui/button";
import type { SessionLink } from "@/lib/types";

/** Above a session's composer while its agent is not live: connecting, or offline with a Reconnect button. */
export default function SessionLinkBanner({
  link,
  agentName,
  onRetry,
}: {
  link: SessionLink | null;
  agentName: string;
  onRetry: () => void;
}) {
  if (!link || link.status === "live") return null;
  const offline = link.status === "offline";
  return (
    <div
      role="status"
      className={`mb-3 flex items-center gap-3 rounded-xl border px-3 py-2 text-xs leading-relaxed ${offline ? "border-amber-300/10 bg-amber-300/5 text-amber-200" : "border-white/5 text-muted-foreground"}`}
    >
      <span className="min-w-0 flex-1">
        {link.status === "connecting"
          ? `Connecting to ${agentName}…`
          : (link.error ?? `${agentName} is offline. Send a message to reconnect.`)}
      </span>
      {offline && (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          Reconnect
        </Button>
      )}
    </div>
  );
}
