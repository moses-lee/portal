"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Group, Panel, Separator } from "react-resizable-panels";
import SessionControls from "./SessionControls";
import ContextBar from "./ContextBar";
import StartPage, { type StartPageProps } from "./StartPage";
import ChatComposer from "./ChatComposer";
import Conversation from "./Conversation";
import SessionHeader from "./SessionHeader";
import AuroraBackground from "./AuroraBackground";
import { Button } from "@/components/ui/button";
import { useDraft } from "./useDraft";
import { clearSubmittedDraft } from "@/lib/drafts";
import { recordPrompt, sessionHistoryKey } from "@/lib/prompt-history";
import { applyConfigChange } from "@/lib/session-config";
import { agentActivity } from "@/lib/agent-activity";
import type {
  EventPage,
  PortalEvent,
  SessionLink,
  SessionMetaEvent,
  SessionState,
  SessionSummary,
  SetConfigRequest,
} from "@/lib/types";
import {
  appendEvent,
  firstSeq,
  lastSeq,
  segment,
  type History,
} from "@/lib/transcript";
import type { HistoryCache } from "@/lib/history-cache";

const TerminalPanel = dynamic(() => import("./TerminalPanel"), {
  ssr: false,
  loading: () => (
    <p className="p-4 text-xs text-muted-foreground">Opening terminal…</p>
  ),
});
const sessionUrl = (id: string, suffix = "") =>
  `/api/sessions/${encodeURIComponent(id)}${suffix}`;

export type SessionPaneProps = {
  /** The open session, or null for the start page. The parent keys this component by it. */
  sessionId: string | null;
  /** The session's list entry when known; seeds state until the stream's `meta` arrives. */
  session: SessionSummary | undefined;
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
  /** Live changes to the session's list entry (title, branch, connection, …). */
  onSessionUpdate: (id: string, patch: Partial<SessionSummary>) => void;
  /** The session was deleted (by this or another viewer). */
  onSessionDeleted: (id: string) => void;
  /** Reduced transcripts from earlier visits, so a return renders at once; this pane keeps its entry current. */
  historyCache: HistoryCache;
  showShell: boolean;
  onShowShell: (open: boolean) => void;
  shellSize: number;
  onShellSize: (size: number) => void;
};

/** The main column: header, transcript, message box, controls, and terminals for one session. */
export default function SessionPane({
  sessionId,
  session,
  start,
  onOpenSidebar,
  onBack,
  onSessionUpdate,
  onSessionDeleted,
  historyCache,
  showGithub,
  onToggleGithub,
  initialSend,
  onInitialSendHandled,
  showShell,
  onShowShell,
  shellSize,
  onShellSize,
}: SessionPaneProps) {
  // A session seen before renders from the cache on the first paint; the stream then fills in the rest.
  const [initial] = useState(() =>
    sessionId ? historyCache.get(sessionId) : undefined,
  );
  const [history, setHistory] = useState<History>(
    initial?.history ?? { turns: [], hasMore: false },
  );
  const [historyLoading, setHistoryLoading] = useState(!!sessionId && !initial);
  /** Seq of the newest streamed event held; the stream reopens from here and the cache entry records it. */
  const cursorRef = useRef(initial?.cursor ?? -1);
  /** True once `history` reflects the log (a page or a cache hit); before that it must not be cached. */
  const loadedRef = useRef(!!initial);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [link, setLink] = useState<SessionLink | null>(session?.link ?? null);
  const [busy, setBusy] = useState(session?.busy ?? false);
  const [sessionState, setSessionState] = useState<SessionState | null>(
    session?.state ?? null,
  );
  const [configInFlight, setConfigInFlight] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [input, setInput] = useDraft(sessionId ?? "new");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const shellButton = useRef<HTMLButtonElement>(null);
  /** A prompt POST is in flight or its turn has not started yet. */
  const pendingPromptRef = useRef(false);
  /** Client-only notices (failed requests) get negative seqs so they never collide with the log. */
  const localSeqRef = useRef(-1);
  const loadingOlderRef = useRef(false);

  // Load the newest page, then follow the live tail. Opening the stream also asks the server to
  // reattach the agent when the session was persisted by an earlier run.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let es: EventSource | null = null;
    const applyMeta = (meta: Partial<SessionMetaEvent>) => {
      if (meta.busy !== undefined) {
        setBusy(meta.busy);
        if (!meta.busy) setStopping(false);
      }
      if (meta.link) setLink(meta.link);
      // Agent state (modes, config options, commands) changes from any viewer; the stream is the source of truth.
      if (meta.state) setSessionState(meta.state);
      const patch: Partial<SessionSummary> = {};
      if (meta.busy !== undefined) patch.busy = meta.busy;
      if (meta.link) patch.link = meta.link;
      if (meta.title !== undefined) patch.title = meta.title;
      if (meta.git !== undefined) patch.git = meta.git;
      if (meta.state) patch.state = meta.state;
      if (meta.project !== undefined) patch.project = meta.project;
      if (meta.cwdMissing !== undefined) patch.cwdMissing = meta.cwdMissing;
      onSessionUpdate(sessionId, patch);
    };
    // `fresh` skips the cache: the stream no longer holds the events after our cursor.
    const open = async ({ fresh = false } = {}) => {
      const cached = fresh ? undefined : historyCache.get(sessionId);
      if (!cached) setHistoryLoading(true);
      try {
        const entry = cached ?? (await historyCache.load(sessionId, { fresh }));
        if (controller.signal.aborted) return;
        if (!entry) {
          setNotFound(true);
          return;
        }
        cursorRef.current = entry.cursor;
        loadedRef.current = true;
        setHistory(entry.history);
        // The page is authoritative: whatever prompt was in flight has either started or failed by now.
        pendingPromptRef.current = false;
        es?.close();
        const mine = new EventSource(
          sessionUrl(sessionId, `/stream?since=${entry.cursor}`),
        );
        es = mine;
        mine.onmessage = (m) => {
          if (es !== mine) return;
          const ev = JSON.parse(m.data) as PortalEvent;
          const seq = Number(m.lastEventId);
          cursorRef.current = Math.max(cursorRef.current, seq);
          setHistory((prev) => {
            const last = lastSeq(prev);
            return last !== undefined && last >= seq
              ? prev
              : appendEvent(prev, { ...ev, seq, ts: Date.now() });
          });
          if (
            ev.type === "turn_start" ||
            ev.type === "turn_end" ||
            ev.type === "error"
          )
            pendingPromptRef.current = false;
          if (ev.type === "turn_start") setBusy(true);
          if (ev.type === "turn_end" || ev.type === "error") {
            setBusy(false);
            setStopping(false);
          }
        };
        mine.addEventListener("meta", (m) => {
          if (es === mine)
            applyMeta(
              JSON.parse((m as MessageEvent).data) as Partial<SessionMetaEvent>,
            );
        });
        // The server no longer holds the events between our cursor and now: start over from a fresh page.
        mine.addEventListener("reset", () => {
          if (es === mine) void open({ fresh: true });
        });
        mine.addEventListener("deleted", () => {
          if (es !== mine) return;
          mine.close();
          historyCache.delete(sessionId);
          onSessionDeleted(sessionId);
        });
      } catch {
        if (!controller.signal.aborted)
          setHistoryError(
            "Could not load the conversation. Check the server and reload the page to retry.",
          );
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    };
    void open();
    return () => {
      controller.abort();
      es?.close();
      es = null;
    };
  }, [sessionId, onSessionUpdate, onSessionDeleted, historyCache]);

  // Keep the cache entry current so the next visit starts from this history and cursor.
  useEffect(() => {
    if (sessionId && loadedRef.current)
      historyCache.set(sessionId, { history, cursor: cursorRef.current });
  }, [sessionId, history, historyCache]);

  // Fetch the page before the oldest loaded event and prepend it without moving the viewport.
  const loadOlder = async () => {
    const before = firstSeq(history);
    if (
      !sessionId ||
      !history.hasMore ||
      loadingOlderRef.current ||
      historyLoading ||
      before === undefined ||
      before <= 0
    )
      return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const r = await fetch(sessionUrl(sessionId, `/events?before=${before}`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const page = (await r.json()) as EventPage;
      setHistory((prev) => {
        // History was replaced (a `reset`) while this page was in flight: it no longer fits.
        if (firstSeq(prev) !== before) return prev;
        return {
          turns: [...segment(page.events), ...prev.turns],
          hasMore: page.hasMore,
        };
      });
    } catch {
      setHistoryError("Could not load earlier messages. Scroll up to retry.");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const showRequestError = (message: string) => {
    const event = {
      type: "error" as const,
      message,
      seq: localSeqRef.current--,
      ts: Date.now(),
    };
    setHistory((previous) => appendEvent(previous, event));
  };

  const send = async () => {
    const text = input.trim();
    if (
      !text ||
      !sessionId ||
      busy ||
      pendingPromptRef.current ||
      (initialSend?.sessionId === sessionId && initialSend.pending)
    )
      return;
    const draft = input;
    onInitialSendHandled(sessionId);
    pendingPromptRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const response = await fetch(sessionUrl(sessionId, "/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          result.error ??
            "Could not send your message. Your draft is saved; try again.",
        );
      }
      clearSubmittedDraft(sessionId, draft);
      recordPrompt(sessionHistoryKey(sessionId), text);
      setScrollRequest((request) => request + 1);
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : "Could not send your message. Your draft is saved; try again.",
      );
    } finally {
      pendingPromptRef.current = false;
      setSending(false);
    }
  };

  const stop = async () => {
    if (!sessionId || stopping) return;
    setStopping(true);
    try {
      const response = await fetch(sessionUrl(sessionId, "/cancel"), {
        method: "POST",
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(result.error ?? "Could not stop the agent. Try again.");
      }
    } catch (error) {
      setStopping(false);
      showRequestError(
        error instanceof Error
          ? error.message
          : "Could not stop the agent. Try again.",
      );
    }
  };

  /** Ask the server to reconnect the agent; the outcome arrives as `meta.link` on the stream. */
  const retryAttach = async () => {
    if (!sessionId) return;
    setLink({ status: "connecting" });
    try {
      const r = await fetch(sessionUrl(sessionId, "/attach"), {
        method: "POST",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setLink({
          status: "offline",
          error: j.error ?? "Could not reconnect.",
        });
      }
    } catch {
      setLink({ status: "offline", error: "Could not reach the server." });
    }
  };

  /** Change a config option or mode: apply locally first, then adopt the agent's confirmed state or revert. */
  const setConfig = async (request: SetConfigRequest) => {
    if (!sessionId || !sessionState || configInFlight) return;
    const previous = sessionState;
    setConfigError(null);
    setConfigInFlight(true);
    setSessionState(applyConfigChange(previous, request));
    const revert = (message: string) => {
      setSessionState(previous);
      setConfigError(message);
    };
    try {
      const r = await fetch(sessionUrl(sessionId, "/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const j = (await r.json()) as { state?: SessionState; error?: string };
      if (!r.ok || !j.state) {
        revert(j.error ?? "Could not change the setting. Try again.");
        return;
      }
      setSessionState(j.state);
      onSessionUpdate(sessionId, { state: j.state });
    } catch {
      revert(
        "Could not change the setting. Check the server connection and try again.",
      );
    } finally {
      setConfigInFlight(false);
    }
  };

  /** Answer a permission request; the card resolves when the matching `permission_response` arrives over SSE. */
  const answerPermission = useCallback(
    async (requestId: string, optionId: string) => {
      if (!sessionId) throw new Error("No active session.");
      let r: Response;
      try {
        r = await fetch(sessionUrl(sessionId, "/permission"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, optionId }),
        });
      } catch {
        throw new Error(
          "Could not send the answer. Check the server connection and try again.",
        );
      }
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Could not send the answer. Try again.");
      }
    },
    [sessionId],
  );

  const lastTurn = history.turns.at(-1);
  const awaitingPermission =
    busy &&
    !!lastTurn?.blocks.some(
      (b) => b.kind === "permission" && b.response === null,
    );
  const offline = link?.status === "offline";
  const agentName = session?.agentName ?? "the agent";

  const hideShell = () => {
    onShowShell(false);
    shellButton.current?.focus();
  };

  const activity = agentActivity({
    busy,
    awaitingPermission,
    link,
    failed: lastTurn?.blocks.at(-1)?.kind === "error",
  });
  const initialPending =
    initialSend?.sessionId === sessionId && initialSend.pending;
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
      />
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
              {link && link.status !== "live" && (
                <div
                  role="status"
                  className={`mb-3 flex items-center gap-3 rounded-xl border px-3 py-2 text-xs leading-relaxed ${offline ? "border-amber-300/10 bg-amber-300/5 text-amber-200" : "border-white/5 text-muted-foreground"}`}
                >
                  <span className="min-w-0 flex-1">
                    {link.status === "connecting"
                      ? `Connecting to ${agentName}…`
                      : (link.error ??
                        `${agentName} is offline. Send a message to reconnect.`)}
                  </span>
                  {offline && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void retryAttach()}
                    >
                      Reconnect
                    </Button>
                  )}
                </div>
              )}
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
