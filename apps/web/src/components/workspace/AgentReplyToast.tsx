"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { Bot, X } from "lucide-react";
import IconButton from "../IconButton";
import { useAgentInbox } from "../portal/AgentInbox";
import { usePortalLive } from "../portal/PortalLive";
import { MAIN_THREAD_ID } from "@/lib/orchestrator/types";

/**
 * Portal's latest reply on a phone, while Agent is closed: one line floating just above the
 * composer (over the bar's host, so it clears the composer whether or not the keyboard has hidden
 * the bar). A tap opens Agent on the reply's thread; the cross or `REPLY_PREVIEW_MS` dismisses it.
 * `host` is the `data-pane-bar-host` it is positioned in.
 */
export default function AgentReplyToast({ host }: { host: RefObject<HTMLElement | null> }) {
  const agent = useAgentInbox();
  const { threads } = usePortalLive();
  const preview = agent?.preview ?? null;
  const bottom = useAboveComposer(host, preview !== null);
  if (!agent || !preview || bottom === null) return null;
  const thread = preview.threadId === MAIN_THREAD_ID ? null : threads.find((t) => t.id === preview.threadId);
  return (
    <div
      key={preview.key}
      data-agent-reply-preview
      role="status"
      style={{ bottom }}
      className="glass absolute inset-x-3 z-20 flex items-center gap-1 rounded-xl py-1 pr-1 pl-3 text-xs shadow-lg duration-200 animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <button
        type="button"
        onClick={() => agent.openAgent(preview.threadId)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left focus-visible:outline-none"
      >
        <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{thread ? `Portal in ${thread.title}:` : "Portal replied:"}</span>{" "}
          <span className="text-foreground/80">{preview.text}</span>
        </span>
      </button>
      <IconButton label="Dismiss" size="icon-sm" onClick={agent.dismissPreview} className="size-7 shrink-0 text-muted-foreground">
        <X className="size-3.5" />
      </IconButton>
    </div>
  );
}

/**
 * The `bottom` (px) that puts a box 8 px above the composer inside `host`, tracked every frame
 * while `active` (a preview lasts seconds): the composer mounts once its pane loads, grows with its
 * text, and moves when the bar comes and goes with the keyboard, not all of which resize anything.
 * Without a composer (a pane still loading) it sits above the bar, or the host's foot.
 */
function useAboveComposer(host: RefObject<HTMLElement | null>, active: boolean): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = () => {
      // The parent ref may attach after this child's layout effect, or change while a workspace
      // resolver finishes. Read the current host on every frame and show only after measuring.
      const root = host.current;
      if (root) {
        const anchor = root.querySelector<HTMLElement>(".composer-wrap") ?? root.querySelector<HTMLElement>("[data-pane-bar]:not([hidden])");
        const foot = root.getBoundingClientRect().bottom;
        setBottom(Math.round(Math.max(8, (anchor ? foot - anchor.getBoundingClientRect().top : 0) + 8)));
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [host, active]);
  return bottom;
}
