"use client";

import { ArrowLeft, ExternalLink } from "lucide-react";
import AgentLogo from "../AgentLogo";
import IconButton from "../IconButton";
import { trackedState } from "@/lib/tracked-sessions";
import type { SessionSummary } from "@/lib/types";
import { TrackedRowMenu, TrackedStateBadge, trackedTitle, type TrackedRowActions } from "./parts";

/**
 * The panel's session mode: one session beside the Portal view, named by `?session=`.
 *
 * TODO(step 6): the body is a placeholder. Session mode renders `Conversation`, the link-status
 * banner, and `ChatComposer` from `useSessionStream(sessionId, historyCache)` below this header;
 * the panel gives it the resizable width (`TRACKED_WIDTH_KEY`).
 */
export default function TrackedSessionView({
  sessionId,
  session,
  loading,
  onBack,
  actions,
}: {
  sessionId: string;
  /** The session's list entry; undefined while the list loads, or when no session has this id. */
  session: SessionSummary | undefined;
  /** True until the session list has loaded. */
  loading: boolean;
  /** Back to the list (clears `?session=`). */
  onBack: () => void;
  actions: TrackedRowActions;
}) {
  const state = session ? trackedState(session) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-panel-session={sessionId}>
      <header className="flex items-center gap-1.5 border-b border-white/5 px-2 py-2">
        <IconButton label="Back to tracked sessions" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft className="size-4" />
        </IconButton>
        {session && <AgentLogo agentId={session.agentId} className="!size-[14px] opacity-80" />}
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {session ? trackedTitle(session) : "Conversation"}
        </h2>
        {state && <TrackedStateBadge state={state} />}
        <IconButton
          label="Open full page"
          onClick={() => actions.onOpenFullPage(sessionId)}
          className="text-muted-foreground"
        >
          <ExternalLink className="size-4" />
        </IconButton>
        {session && state && <TrackedRowMenu session={session} state={state} actions={actions} />}
      </header>
      <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
        {session
          ? "The conversation opens here soon. Open the full page to reply for now."
          : loading
            ? "Loading…"
            : "Portal has no session with this id."}
      </p>
    </div>
  );
}
