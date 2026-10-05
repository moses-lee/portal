"use client";

import { ArrowLeft, ExternalLink } from "lucide-react";
import AgentLogo from "../AgentLogo";
import ChatComposer from "../ChatComposer";
import PromptQueue from "../PromptQueue";
import Conversation from "../Conversation";
import IconButton from "../IconButton";
import SessionLinkBanner from "../SessionLinkBanner";
import { useSessions } from "../SessionsProvider";
import { useSessionStream } from "../useSessionStream";
import { sessionHistoryKey } from "@/lib/prompt-history";
import { trackedState } from "@/lib/tracked-sessions";
import type { SessionSummary } from "@/lib/types";
import { TrackedRowMenu, TrackedStateBadge, backgroundTaskCount, trackedTitle, type TrackedRowActions } from "./parts";

/**
 * The panel's session mode: one session beside the Portal view, named by `?session=`. The same
 * stream, transcript, and composer as the session page (`useSessionStream`, `Conversation` with its
 * permission cards, the link banner, `ChatComposer`), without the terminal, the GitHub panel, the
 * agent settings, or the room backdrop. The panel keys it by session, so a switch starts fresh.
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
  const { historyCache, removeSession } = useSessions();
  const {
    history,
    loading: historyLoading,
    loadingOlder,
    error: historyError,
    notFound,
    meta: { busy, link, state: sessionState },
    loadOlder,
    draft,
    setDraft,
    sending,
    sendError,
    send,
    stop,
    stopping,
    queue,
    editQueued,
    removeQueued,
    answerPermission,
    retryAttach,
    scrollRequest,
  } = useSessionStream(sessionId, historyCache, {
    // Deleted here or elsewhere: drop it from the list and go back to it.
    onDeleted: (id) => {
      removeSession(id);
      onBack();
    },
  });
  const state = session ? trackedState(session) : null;
  const agentName = session?.agentName ?? "the agent";
  const missing = notFound || (!loading && !session);
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
        {session && state && <TrackedStateBadge state={state} tasks={backgroundTaskCount(session)} />}
        <IconButton
          label="Open full page"
          onClick={() => actions.onOpenFullPage(sessionId)}
          className="text-muted-foreground"
        >
          <ExternalLink className="size-4" />
        </IconButton>
        {session && state && <TrackedRowMenu session={session} state={state} actions={actions} />}
      </header>
      {missing ? (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
          Portal has no session with this id. It may have been deleted.
        </p>
      ) : (
        <>
          <Conversation
            history={history}
            loading={historyLoading}
            loadingOlder={loadingOlder}
            error={historyError}
            loadOlder={() => void loadOlder()}
            busy={busy}
            agentId={session?.agentId ?? ""}
            agentName={agentName}
            onAnswer={answerPermission}
            scrollRequest={scrollRequest}
          />
          <div className="composer-wrap !px-3">
            <PromptQueue queue={queue} busy={busy} onEdit={(item) => void editQueued(item)} onRemove={(item) => void removeQueued(item)} />
            <SessionLinkBanner link={link} agentName={agentName} onRetry={() => void retryAttach()} />
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              onStop={() => void stop()}
              busy={busy}
              queues
              sending={sending}
              stopping={stopping}
              commands={sessionState?.commands}
              historyKey={sessionHistoryKey(sessionId)}
              label={`Message ${agentName}`}
              placeholder={`Message ${agentName}…`}
              error={sendError}
              paletteId="tracked-command-palette"
            />
          </div>
        </>
      )}
    </div>
  );
}
