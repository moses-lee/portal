"use client";

import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Group, Panel, Separator } from "react-resizable-panels";
import SessionControls from "./SessionControls";
import ContextBar from "./ContextBar";
import StartPage, { type StartPageProps } from "./StartPage";
import ChatComposer from "./ChatComposer";
import PromptQueue from "./PromptQueue";
import Conversation from "./Conversation";
import SessionHeader, { type PaneMenu } from "./SessionHeader";
import SessionLinkBanner from "./SessionLinkBanner";
import { Button } from "@/components/ui/button";
import { useSessions } from "./SessionsProvider";
import { sessionUrl, useSessionStream } from "./useSessionStream";
import type { AgentActivity } from "@/lib/agent-activity";
import { startKey } from "@/lib/drafts";
import { sessionHistoryKey } from "@/lib/prompt-history";
import { queueEditLabel } from "@/lib/prompt-queue";
import { sessionDisplayTitle } from "@/lib/session-title";

const TerminalPanel = dynamic(() => import("./TerminalPanel"), {
  ssr: false,
  loading: () => (
    <p className="p-4 text-xs text-muted-foreground">Opening terminal…</p>
  ),
});

/**
 * The start page's props as the shell hands them to every start-page pane. What is per pane (its
 * draft, whether it is creating, its creation error) is keyed by the pane's `startKey`: the pane
 * picks its own out, so two start pages open at once do not share a spinner or an error. `onCreate`
 * also says which pane asked, so the new session lands in it (decision 9).
 */
export type StartPaneProps = Omit<StartPageProps, "onCreate" | "creating" | "error"> & {
  /** The `startKey` of the pane whose session is being created; null when none is. */
  creatingIn: string | null;
  /** The last creation failure and the pane it happened in. */
  createError: { startKey: string; message: string } | null;
  /** A session-list load failure: every start page shows it. */
  loadError: string | null;
  onCreate: (firstPrompt: string | undefined, paneId: string | null, startKey: string) => void;
};

export type InitialSend = {
  sessionId: string;
  pending: boolean;
  error: string | null;
} | null;

export type SessionPaneProps = {
  /** The open session, or null for the start page. The parent keys this component by the pane. */
  sessionId: string | null;
  /** The workspace pane this is; null for the bare start page of an empty workspace. */
  paneId: string | null;
  /**
   * The key this device renders the pane under (the provider's `keyOf`): stable when the server
   * replaces an optimistic id, so per-pane state keyed by it (a start page's draft) survives. Defaults
   * to `paneId`.
   */
  paneKey?: string | null;
  /** Props for the start page shown when no session is open. */
  start: StartPaneProps;
  /** Only the first pane of a tab carries the sidebar toggle. */
  showSidebarToggle?: boolean;
  onOpenSidebar: (opener: HTMLElement) => void;
  showGithub: boolean;
  onToggleGithub: (opener: HTMLElement) => void;
  initialSend: InitialSend;
  onInitialSendHandled: (sessionId: string) => void;
  /** The header's "New conversation": a start page somewhere in the workspace. */
  onNew: () => void;
  /** The session was deleted (by this or another viewer). */
  onSessionDeleted: (id: string) => void;
  /** The pane menu (split, move, close); absent on the bare start page. */
  pane?: PaneMenu;
  /** The agent's activity, for the room scene behind the focused pane. */
  onActivity?: (paneId: string | null, activity: AgentActivity) => void;
};

/**
 * What a pane shows for a session the server does not have (deleted, or from another Portal), and
 * what the workspace view shows when `/sessions/<id>` names one: the way back is a new conversation.
 */
export function MissingConversation({ onNew }: { onNew: () => void }) {
  return (
    <div data-missing-conversation className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg">This conversation is no longer here.</h2>
      <p className="text-sm text-muted-foreground">It may have been deleted, or opened from a different Portal.</p>
      <Button onClick={onNew} variant="secondary">
        Start a conversation
      </Button>
    </div>
  );
}

/**
 * One pane: header, transcript, message box, controls, and terminals for one session, or the start
 * page. The terminal's open state and height are this pane's own (decision 26); element ids are per
 * instance, since several panes render at once.
 */
export default function SessionPane({
  sessionId,
  paneId,
  paneKey = paneId,
  start,
  showSidebarToggle = true,
  onOpenSidebar,
  onNew,
  onSessionDeleted,
  showGithub,
  onToggleGithub,
  initialSend,
  onInitialSendHandled,
  pane,
  onActivity,
}: SessionPaneProps) {
  const { historyCache, tracked, track, untrack, renameSession } = useSessions();
  const uid = useId();
  const terminalPanelId = `${uid}-terminal`;
  const contextId = `${uid}-context`;
  const isTracked = !!sessionId && tracked.some((entry) => entry.sessionId === sessionId);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackPending, setTrackPending] = useState(false);
  const [showShell, setShowShell] = useState(false);
  const [shellSize, setShellSize] = useState(33);
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
  // The header's line under it reports failed track toggles and renames alike.
  const rename = (title: string) => {
    if (!sessionId) return;
    setTrackError(null);
    renameSession(sessionId, title).catch((error: unknown) =>
      setTrackError(error instanceof Error ? error.message : "Could not rename the session. Try again."),
    );
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
    queue,
    editingId,
    editQueued,
    cancelEdit,
    removeQueued,
    answerPermission,
    setConfig,
    configInFlight,
    configError,
    retryAttach,
    activity,
    statusLabel,
    scrollRequest,
  } = useSessionStream(sessionId, historyCache, {
    onDeleted: onSessionDeleted,
    onSubmit: onInitialSendHandled,
    sendBlocked: initialPending,
  });
  const shellButton = useRef<HTMLButtonElement>(null);
  const roomActivity: AgentActivity = sessionId ? activity : "idle";
  useEffect(() => {
    onActivity?.(paneId, roomActivity);
  }, [onActivity, paneId, roomActivity]);

  const agentName = session?.agentName ?? "the agent";

  const hideShell = () => {
    setShowShell(false);
    shellButton.current?.focus();
  };

  const composerError =
    sendError ??
    (initialSend?.sessionId === sessionId ? initialSend.error : null);
  /** This start page's share of the shell's start-page state (see `StartPaneProps`). */
  const key = startKey(paneKey);
  const { creatingIn, createError, loadError, onCreate, ...startPage } = start;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-pane={paneId ?? undefined}
      data-session={sessionId ?? undefined}
    >
      <SessionHeader
        title={
          session
            ? sessionDisplayTitle(session.title)
            : sessionId
              ? "Conversation"
              : "Your workspace"
        }
        activity={activity}
        statusLabel={statusLabel}
        hasSession={!!sessionId}
        showShell={showShell && !!sessionId}
        showGithub={showGithub}
        showSidebarToggle={showSidebarToggle}
        onSidebar={onOpenSidebar}
        onNew={onNew}
        onTerminal={() => setShowShell((open) => !open)}
        onGithub={onToggleGithub}
        shellButton={shellButton}
        terminalPanelId={terminalPanelId}
        tracked={isTracked}
        trackPending={trackPending}
        onToggleTrack={toggleTracked}
        renameFrom={session?.title ?? ""}
        onRename={session ? rename : undefined}
        pane={pane}
      />
      {trackError && (
        <p role="alert" className="border-b border-white/5 px-5 py-1.5 text-[11px] text-destructive">
          {trackError}
        </p>
      )}
      {!sessionId ? (
        <div data-room-passthrough className="min-h-0 flex-1 overflow-y-auto">
          <StartPage
            {...startPage}
            draftKey={key}
            creating={creatingIn === key}
            error={createError?.startKey === key ? createError.message : loadError}
            onCreate={(text) => onCreate(text, paneId, key)}
          />
        </div>
      ) : (
        <Group
          orientation="vertical"
          className="min-h-0 flex-1"
          onLayoutChanged={(layout) => {
            if (layout.shell) setShellSize(layout.shell);
          }}
        >
          <Panel id="chat" minSize="25%" className="flex min-h-0 flex-col">
            {notFound ? (
              <MissingConversation onNew={onNew} />
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
              <PromptQueue
                queue={queue}
                busy={busy}
                editingId={editingId}
                onEdit={(item) => void editQueued(item)}
                onRemove={(item) => void removeQueued(item)}
              />
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
                queues
                editing={
                  editingId
                    ? { label: queueEditLabel(queue, editingId), onCancel: () => void cancelEdit() }
                    : undefined
                }
                sending={sending || initialPending}
                stopping={stopping}
                disabled={notFound}
                commands={sessionState?.commands}
                historyKey={sessionId ? sessionHistoryKey(sessionId) : undefined}
                label={`Message ${agentName}`}
                placeholder={`Message ${agentName}…`}
                describedBy={session ? contextId : undefined}
                paletteId={`${uid}-palette`}
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
                      id={contextId}
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
                panelId={terminalPanelId}
              />
            </Panel>
          )}
        </Group>
      )}
    </div>
  );
}
