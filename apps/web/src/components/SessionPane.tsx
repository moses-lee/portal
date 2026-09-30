"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Group, Panel, Separator } from "react-resizable-panels";
import SessionControls from "./SessionControls";
import ContextBar from "./ContextBar";
import StartPage, { type StartPageProps } from "./StartPage";
import ChatComposer from "./ChatComposer";
import Conversation from "./Conversation";
import SessionHeader from "./SessionHeader";
import SessionLinkBanner from "./SessionLinkBanner";
import AuroraBackground from "./AuroraBackground";
import { Button } from "@/components/ui/button";
import { useSessions } from "./SessionsProvider";
import { sessionUrl, useSessionStream } from "./useSessionStream";
import { sessionHistoryKey } from "@/lib/prompt-history";

const TerminalPanel = dynamic(() => import("./TerminalPanel"), {
  ssr: false,
  loading: () => (
    <p className="p-4 text-xs text-muted-foreground">Opening terminal…</p>
  ),
});

export type SessionPaneProps = {
  /** The open session, or null for the start page. The parent keys this component by it. */
  sessionId: string | null;
  /** Props for the start page shown when no session is open. */
  start: StartPageProps;
  onOpenSidebar: () => void;
  showGithub: boolean;
  onToggleGithub: () => void;
  initialSend: {
    sessionId: string;
    pending: boolean;
    error: string | null;
  } | null;
  onInitialSendHandled: (sessionId: string) => void;
  /** "+ New": back to the start page. */
  onBack: () => void;
  /** The session was deleted (by this or another viewer). */
  onSessionDeleted: (id: string) => void;
  showShell: boolean;
  onShowShell: (open: boolean) => void;
  shellSize: number;
  onShellSize: (size: number) => void;
};

/** The main column: header, transcript, message box, controls, and terminals for one session. */
export default function SessionPane({
  sessionId,
  start,
  onOpenSidebar,
  onBack,
  onSessionDeleted,
  showGithub,
  onToggleGithub,
  initialSend,
  onInitialSendHandled,
  showShell,
  onShowShell,
  shellSize,
  onShellSize,
}: SessionPaneProps) {
  const { historyCache, tracked, track, untrack } = useSessions();
  const isTracked = !!sessionId && tracked.some((entry) => entry.sessionId === sessionId);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackPending, setTrackPending] = useState(false);
  const toggleTracked = () => {
    if (!sessionId || trackPending) return;
    setTrackPending(true);
    setTrackError(null);
    (isTracked ? untrack(sessionId) : track(sessionId))
      .catch((error: unknown) =>
        setTrackError(error instanceof Error ? error.message : "Could not change tracking. Try again."),
      )
      .finally(() => setTrackPending(false));
  };
  const initialPending =
    initialSend?.sessionId === sessionId && initialSend.pending;
  const {
    session,
    history,
    loading: historyLoading,
    loadingOlder,
    error: historyError,
    notFound,
    meta: { busy, link, state: sessionState },
    loadOlder,
    draft: input,
    setDraft: setInput,
    sending,
    sendError,
    send,
    stop,
    stopping,
    answerPermission,
    setConfig,
    configInFlight,
    configError,
    retryAttach,
    activity,
    scrollRequest,
  } = useSessionStream(sessionId, historyCache, {
    onDeleted: onSessionDeleted,
    onSubmit: onInitialSendHandled,
    sendBlocked: initialPending,
  });
  const shellButton = useRef<HTMLButtonElement>(null);

  const agentName = session?.agentName ?? "the agent";

  const hideShell = () => {
    onShowShell(false);
    shellButton.current?.focus();
  };

  const composerError =
    sendError ??
    (initialSend?.sessionId === sessionId ? initialSend.error : null);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AuroraBackground activity={sessionId ? activity : "idle"} />
      <SessionHeader
        title={
          session
            ? session.title || "New conversation"
            : sessionId
              ? "Conversation"
              : "Your workspace"
        }
        activity={activity}
        hasSession={!!sessionId}
        showShell={showShell && !!sessionId}
        showGithub={showGithub}
        onSidebar={onOpenSidebar}
        onNew={onBack}
        onTerminal={() => onShowShell(!showShell)}
        onGithub={onToggleGithub}
        shellButton={shellButton}
        tracked={isTracked}
        trackPending={trackPending}
        onToggleTrack={toggleTracked}
      />
      {trackError && (
        <p role="alert" className="border-b border-white/5 px-5 py-1.5 text-[11px] text-destructive">
          {trackError}
        </p>
      )}
      {!sessionId ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StartPage {...start} />
        </div>
      ) : (
        <Group
          orientation="vertical"
          className="min-h-0 flex-1"
          onLayoutChanged={(layout) => {
            if (layout.shell) onShellSize(layout.shell);
          }}
        >
          <Panel id="chat" minSize="25%" className="flex min-h-0 flex-col">
            {notFound ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                <h2 className="text-lg">
                  This conversation is no longer here.
                </h2>
                <p className="text-sm text-muted-foreground">
                  It may have been deleted, or opened from a different Portal.
                </p>
                <Button onClick={onBack} variant="secondary">
                  Start a conversation
                </Button>
              </div>
            ) : (
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
            )}
            <div className="composer-wrap">
              <SessionLinkBanner
                link={link}
                agentName={agentName}
                onRetry={() => void retryAttach()}
              />
              <ChatComposer
                value={input}
                onChange={setInput}
                onSend={() => void send()}
                onStop={() => void stop()}
                busy={busy}
                sending={sending || initialPending}
                stopping={stopping}
                disabled={notFound}
                commands={sessionState?.commands}
                historyKey={sessionId ? sessionHistoryKey(sessionId) : undefined}
                label={`Message ${agentName}`}
                placeholder={`Message ${agentName}…`}
                describedBy={session ? "session-context" : undefined}
                error={composerError}
                settings={
                  sessionState && (
                    <SessionControls
                      state={sessionState}
                      disabled={
                        busy || configInFlight || sending || initialPending
                      }
                      error={configError}
                      onChange={(request) => void setConfig(request)}
                    />
                  )
                }
                context={
                  session && (
                    <ContextBar
                      cwd={session.cwd}
                      displayCwd={session.displayCwd}
                      git={session.git}
                      note={
                        session.cwdMissing
                          ? "Working directory is missing"
                          : undefined
                      }
                    />
                  )
                }
              />
            </div>
          </Panel>
          {showShell && (
            <Separator
              aria-label="Resize terminal panel"
              className="h-1.5 shrink-0 bg-white/5 transition-colors hover:bg-indigo-300/30 focus-visible:bg-indigo-300/30"
            />
          )}
          {showShell && (
            <Panel
              id="shell"
              defaultSize={`${shellSize}%`}
              minSize="20%"
              maxSize="75%"
            >
              <TerminalPanel
                endpoint={sessionUrl(sessionId, "/terminals")}
                onHide={hideShell}
              />
            </Panel>
          )}
        </Group>
      )}
    </main>
  );
}
