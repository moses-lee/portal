"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { useSend } from "./useSend";
import { useSessions } from "./SessionsProvider";
import { sessionHistoryKey } from "@/lib/prompt-history";
import { applyConfigChange } from "@/lib/session-config";
import { agentActivity } from "@/lib/agent-activity";
import { sessionState as deriveSessionState } from "@/lib/session-state";
import { sessionStatusLabel } from "@/lib/session-status";
import type {
  EventPage,
  PortalEvent,
  SessionLink,
  SessionMetaEvent,
  SessionState,
  SessionSummary,
  SetConfigRequest,
  StoredEvent,
} from "@/lib/types";
import {
  appendEvent,
  firstSeq,
  segment,
  type History,
} from "@/lib/transcript";
import {
  PAGE_TURNS,
  type CachedHistory,
  type HistoryCache,
} from "@/lib/history-cache";

export const sessionUrl = (id: string, suffix = "") =>
  `/api/sessions/${encodeURIComponent(id)}${suffix}`;

export type SessionStreamOptions = {
  /** The session was deleted (by this or another viewer); its cache entry is already gone. */
  onDeleted?: (id: string) => void;
  /** Runs as a prompt is submitted, before the request (the start page's first send hands over here). */
  onSubmit?: (id: string) => void;
  /** Hold sends back while true (the start page's first message is still in flight). */
  sendBlocked?: boolean;
};

/** The session's live state, as the stream's `meta` events keep it. */
export type SessionStreamMeta = {
  busy: boolean;
  link: SessionLink | null;
  /** Modes, config options and slash commands; null until known. */
  state: SessionState | null;
};

/** What a view of `sessionId` starts from: the cached transcript, and the list entry's live state until the stream's `meta`. */
function seed(
  sessionId: string | null,
  cached: CachedHistory | undefined,
  session: SessionSummary | undefined,
) {
  return {
    history: cached?.history ?? { turns: [], hasMore: false },
    loading: !!sessionId && !cached,
    link: session?.link ?? null,
    busy: session?.busy ?? false,
    // The list entry carries modes and config options but not the slash commands; those arrive with the first `meta`.
    state: session?.state ? { ...session.state, commands: [] } : null,
  };
}

/**
 * One session's transcript and controls: loads the newest page (or the cached one), follows the
 * live stream, patches the session's list entry from its `meta`, and holds the composer's draft and
 * send. Mount it once per view of a session; the server takes several viewers of one session, and
 * the history cache simply keeps whichever copy wrote last. A change of `sessionId` resets it to
 * the new session's seed, so callers may key by session (a full remount) or not.
 */
export function useSessionStream(
  sessionId: string | null,
  historyCache: HistoryCache,
  { onDeleted, onSubmit, sendBlocked = false }: SessionStreamOptions = {},
) {
  const { sessions, updateSession } = useSessions();
  const session: SessionSummary | undefined = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : undefined;
  const sessionDeleted = useStableCallback((id: string) => onDeleted?.(id));
  const submitted = useStableCallback((id: string) => onSubmit?.(id));

  // A session seen before renders from the cache on the first paint; the stream then fills in the rest.
  const [initial] = useState(() => {
    const cached = sessionId ? historyCache.get(sessionId) : undefined;
    return { cached, seed: seed(sessionId, cached, session) };
  });
  const [history, setHistory] = useState<History>(initial.seed.history);
  const [historyLoading, setHistoryLoading] = useState(initial.seed.loading);
  /** Seq of the newest streamed event held; the stream reopens from here and the cache entry records it. */
  const cursorRef = useRef(initial.cached?.cursor ?? -1);
  /**
   * The session `history` reflects the log of (a page or a cache hit), else null; until it is the
   * current one, history must not be cached, or a switch would file one session's transcript under
   * the next one's id.
   */
  const loadedForRef = useRef<string | null>(initial.cached ? sessionId : null);
  /** The session the stream effect is following; requests in flight for an earlier one drop their result. */
  const currentIdRef = useRef(sessionId);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [link, setLink] = useState<SessionLink | null>(initial.seed.link);
  const [busy, setBusy] = useState(initial.seed.busy);
  const [sessionState, setSessionState] = useState<SessionState | null>(
    initial.seed.state,
  );
  const [configInFlight, setConfigInFlight] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [scrollRequest, setScrollRequest] = useState(0);
  /** Client-only notices (failed requests) get negative seqs so they never collide with the log. */
  const localSeqRef = useRef(-1);
  const loadingOlderRef = useRef(false);

  // Another session without a remount: start over from its seed, as a fresh mount would.
  const [seededFor, setSeededFor] = useState(sessionId);
  if (seededFor !== sessionId) {
    setSeededFor(sessionId);
    const next = seed(
      sessionId,
      sessionId ? historyCache.get(sessionId) : undefined,
      session,
    );
    setHistory(next.history);
    setHistoryLoading(next.loading);
    setLoadingOlder(false);
    setHistoryError(null);
    setNotFound(false);
    setLink(next.link);
    setBusy(next.busy);
    setSessionState(next.state);
    setConfigInFlight(false);
    setConfigError(null);
    setStopping(false);
  }

  // Load the newest page, then follow the live tail. Opening the stream also asks the server to
  // reattach the agent when the session was persisted by an earlier run.
  useEffect(() => {
    currentIdRef.current = sessionId;
    if (loadedForRef.current !== sessionId) loadedForRef.current = null;
    if (!sessionId) return;
    const controller = new AbortController();
    let es: EventSource | null = null;
    // Streamed events are applied once per animation frame: an agent sends many small chunks a
    // second, and each `setHistory` is a render of the live turn.
    let pending: StoredEvent[] = [];
    let frame: number | null = null;
    const flushEvents = () => {
      frame = null;
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      setHistory((prev) => batch.reduce(appendEvent, prev));
      for (const ev of batch) {
        if (ev.type === "turn_start") setBusy(true);
        if (ev.type === "turn_end" || ev.type === "error") {
          setBusy(false);
          setStopping(false);
        }
      }
    };
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
      if (meta.titleSource !== undefined) patch.titleSource = meta.titleSource;
      if (meta.git !== undefined) patch.git = meta.git;
      if (meta.state) patch.state = meta.state;
      if (meta.project !== undefined) patch.project = meta.project;
      if (meta.cwdMissing !== undefined) patch.cwdMissing = meta.cwdMissing;
      updateSession(sessionId, patch);
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
        loadedForRef.current = sessionId;
        setHistory(entry.history);
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
          // `appendEvent` drops an event the history already holds (a replay after reconnect).
          pending.push({ ...ev, seq, ts: Date.now() });
          frame ??= requestAnimationFrame(flushEvents);
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
          sessionDeleted(sessionId);
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
      if (frame !== null) cancelAnimationFrame(frame);
      pending = [];
    };
  }, [sessionId, updateSession, sessionDeleted, historyCache]);

  // Keep the cache entry current so the next visit starts from this history and cursor.
  useEffect(() => {
    if (sessionId && loadedForRef.current === sessionId)
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
      const r = await fetch(sessionUrl(sessionId, `/events?turns=${PAGE_TURNS}&before=${before}`));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const page = (await r.json()) as EventPage;
      if (currentIdRef.current !== sessionId) return;
      setHistory((prev) => {
        // History was replaced (a `reset`) while this page was in flight: it no longer fits.
        if (firstSeq(prev) !== before) return prev;
        return {
          turns: [...segment(page.events), ...prev.turns],
          hasMore: page.hasMore,
        };
      });
    } catch {
      if (currentIdRef.current === sessionId)
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

  /** `POST /prompt`; resolves once the agent has the prompt (its `turn_start` follows on the stream). */
  const submitPrompt = useCallback(
    async (text: string) => {
      if (!sessionId) throw new Error("No active session.");
      submitted(sessionId);
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
    },
    [sessionId, submitted],
  );
  const {
    draft,
    setDraft,
    sending,
    error: sendError,
    send,
  } = useSend({
    draftKey: sessionId ?? "new",
    historyKey: sessionId ? sessionHistoryKey(sessionId) : undefined,
    submit: submitPrompt,
    canSend: () => !!sessionId && !busy && !sendBlocked,
    onSent: () => setScrollRequest((request) => request + 1),
  });

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
      if (currentIdRef.current !== sessionId) return;
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
      if (currentIdRef.current !== sessionId) return;
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setLink({
          status: "offline",
          error: j.error ?? "Could not reconnect.",
        });
      }
    } catch {
      if (currentIdRef.current === sessionId)
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
      if (currentIdRef.current !== sessionId) return;
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
      updateSession(sessionId, { state: j.state });
      if (currentIdRef.current === sessionId) setSessionState(j.state);
    } catch {
      revert(
        "Could not change the setting. Check the server connection and try again.",
      );
    } finally {
      if (currentIdRef.current === sessionId) setConfigInFlight(false);
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
  // The list entry's liveness (kept current by the list stream; `meta` does not carry it) folds
  // hung and background in the way the sidebar dot does.
  const liveness = session?.liveness ?? null;
  const activity = agentActivity({
    busy,
    awaitingPermission,
    link,
    liveness,
    failed: lastTurn?.blocks.at(-1)?.kind === "error",
  });
  const backgroundTasks = session?.backgroundTasks;
  const statusLabel = sessionStatusLabel(
    activity,
    deriveSessionState({ busy, awaitingPermission, link, liveness }),
    backgroundTasks,
  );
  const meta = useMemo<SessionStreamMeta>(
    () => ({ busy, link, state: sessionState }),
    [busy, link, sessionState],
  );

  return {
    /** The session's list entry, when the list has it. */
    session,
    history,
    loading: historyLoading,
    loadingOlder,
    /** A failed load of the conversation or an older page. */
    error: historyError,
    /** The session no longer exists on the server. */
    notFound,
    meta,
    /** Seq of the newest event held; read `.current` in handlers, not during render. */
    cursor: cursorRef as { readonly current: number },
    loadOlder,
    /** The composer's draft for this session and its send (see `useSend`). */
    draft,
    setDraft,
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
    /** The header's status line: the activity, hung and background as the sidebar says them, and background task titles. */
    statusLabel,
    awaitingPermission,
    /** Bumped after each accepted send; `Conversation` scrolls to the end on a change. */
    scrollRequest,
  };
}

export type SessionStream = ReturnType<typeof useSessionStream>;
