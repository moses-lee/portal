"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { useSend } from "./useSend";
import { useSessions } from "./SessionsProvider";
import { sessionHistoryKey } from "@/lib/prompt-history";
import { restoreToDraft } from "@/lib/prompt-queue";
import { readDraft, writeDraft } from "@/lib/drafts";
import { readEditing, subscribeEditing, writeEditing } from "@/lib/queue-edit";
import { applyConfigChange } from "@/lib/session-config";
import { agentActivity } from "@/lib/agent-activity";
import { sessionState as deriveSessionState } from "@/lib/session-state";
import { sessionStatusLabel } from "@/lib/session-status";
import type {
  EventPage,
  QueuedPrompt,
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

const queueItemUrl = (sessionId: string, itemId: string, suffix = "") =>
  sessionUrl(sessionId, `/queue/${encodeURIComponent(itemId)}${suffix}`);

const QUEUED_PROMPT_GONE = "That queued prompt is no longer in the queue.";

/** The server's `error`, else `fallback`; a 404 means the queued prompt has gone (sent, removed, or dropped by Stop). */
async function queueRequestError(response: Response, fallback: string) {
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(result.error ?? (response.status === 404 ? QUEUED_PROMPT_GONE : fallback));
}

/**
 * `PATCH /queue/:itemId` with the composer's text: the prompt keeps its place in the queue and
 * the edit (with the queue's pause) ends. A prompt that has gone meanwhile (404) ends the edit
 * too; the text stays in the composer, and the error says why.
 */
async function saveQueuedEdit(sessionId: string, itemId: string, text: string) {
  const response = await fetch(queueItemUrl(sessionId, itemId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (response.status === 404) {
    writeEditing(sessionId, null);
    throw new Error(`${QUEUED_PROMPT_GONE} Your text is still here; send it to queue it again.`);
  }
  if (!response.ok)
    throw await queueRequestError(response, "Could not save the queued prompt. Your text is still here; try again.");
  writeEditing(sessionId, null);
}

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
    // The list stream does not patch the queue; the stream's first `meta` corrects it on connect.
    queue: session?.queue ?? [],
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
  const { sessions, updateSession, sessionStreams } = useSessions();
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
  /** The prompts waiting for the agent, as the stream's `meta` keeps them (see `QueuedPrompt`). */
  const [queue, setQueue] = useState<QueuedPrompt[]>(initial.seed.queue);
  /** Whether `queue` came from the stream yet; the seed's copy (the list entry) may be stale. */
  const [queueLive, setQueueLive] = useState(false);
  /**
   * The queued prompt this session's composer is editing (see `@/lib/queue-edit`): shared by every
   * view of the session in this tab, as the draft is, and kept across a reload.
   */
  const editingId = useSyncExternalStore(
    subscribeEditing,
    () => (sessionId ? readEditing(sessionId) : null),
    () => null,
  );
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
    setQueue(next.queue);
    setQueueLive(false);
    setSessionState(next.state);
    setConfigInFlight(false);
    setConfigError(null);
    setStopping(false);
  }

  // Load the newest page, then follow the live tail on the page's shared session stream (see
  // `@/lib/session-stream-hub`). Subscribing also asks the server to reattach the agent when the
  // session was persisted by an earlier run.
  useEffect(() => {
    currentIdRef.current = sessionId;
    if (loadedForRef.current !== sessionId) loadedForRef.current = null;
    if (!sessionId) return;
    const controller = new AbortController();
    /** Ends the current subscription; null before the first page has loaded. */
    let unsubscribe: (() => void) | null = null;
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
      if (meta.queue) {
        setQueue(meta.queue);
        setQueueLive(true);
      }
      const patch: Partial<SessionSummary> = {};
      if (meta.busy !== undefined) patch.busy = meta.busy;
      if (meta.queue) patch.queue = meta.queue;
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
        unsubscribe?.();
        unsubscribe = sessionStreams.subscribe(sessionId, entry.cursor, {
          onEvent: (seq, ev) => {
            cursorRef.current = Math.max(cursorRef.current, seq);
            // `appendEvent` drops an event the history already holds (a replay after reconnect).
            // The server stamps each event with its logged time; an older server sent none.
            pending.push({ ...ev, seq, ts: typeof ev.ts === "number" ? ev.ts : Date.now() });
            frame ??= requestAnimationFrame(flushEvents);
          },
          onMeta: applyMeta,
          // The server no longer holds the events between our cursor and now: start over from a fresh page.
          onReset: () => void open({ fresh: true }),
          // The subscription has ended with the session; the cache entry goes with it.
          onDeleted: () => {
            historyCache.delete(sessionId);
            sessionDeleted(sessionId);
          },
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
      unsubscribe?.();
      unsubscribe = null;
      if (frame !== null) cancelAnimationFrame(frame);
      pending = [];
    };
  }, [sessionId, updateSession, sessionDeleted, historyCache, sessionStreams]);

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

  /**
   * `POST /prompt` with `queue`: resolves once the server has the prompt, sent (its `turn_start`
   * follows on the stream) or, while the agent works, queued (it shows up in `queue`). While a
   * queued prompt is being edited, the text saves into that prompt's slot instead (see
   * `saveQueuedEdit`); `useSend` then clears the draft as after any send.
   */
  const submitPrompt = useCallback(
    async (text: string) => {
      if (!sessionId) throw new Error("No active session.");
      const editing = readEditing(sessionId);
      if (editing) return saveQueuedEdit(sessionId, editing, text);
      submitted(sessionId);
      const response = await fetch(sessionUrl(sessionId, "/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, queue: true }),
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
  const draftKey = sessionId ?? "new";
  const {
    draft,
    setDraft,
    sending,
    error: sendError,
    send,
  } = useSend({
    draftKey,
    historyKey: sessionId ? sessionHistoryKey(sessionId) : undefined,
    submit: submitPrompt,
    canSend: () => !!sessionId && !sendBlocked,
    onSent: () => setScrollRequest((request) => request + 1),
  });

  /**
   * Prompts taken out of the queue (edited, or dropped by Stop) that wait for a send in flight:
   * `useSend` clears the draft only when it still equals what it sent, so changing the draft
   * meanwhile would leave the sent text in the box to be sent again.
   */
  const heldBack = useRef<string[]>([]);
  /** Put prompts taken out of the queue into this viewer's composer, ahead of its draft. */
  const takeBack = (texts: string[]) => {
    if (texts.length === 0) return;
    if (sending) {
      heldBack.current.push(...texts);
      return;
    }
    writeDraft(draftKey, restoreToDraft(texts, readDraft(draftKey)));
  };
  useEffect(() => {
    if (sending || heldBack.current.length === 0) return;
    const texts = heldBack.current.splice(0);
    writeDraft(draftKey, restoreToDraft(texts, readDraft(draftKey)));
  }, [sending, draftKey]);

  /**
   * Stop the turn. The server drops the queue with it and hands the prompts back; they go into
   * this composer, so nothing typed is lost and nothing starts a turn by itself after a stop. An
   * edit in progress ends with its prompt (see the effect below), the composer keeping its text.
   */
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
      // The server has already dropped the queue; an unreadable answer must not pass as an empty one.
      const result = (await response.json()) as { queued?: QueuedPrompt[] };
      if (currentIdRef.current !== sessionId) return;
      // The prompt this composer is editing is already in it (with any changes), so it is not handed
      // back twice; an emptied composer gets it back, so the text is not lost.
      const editing = readDraft(draftKey).trim() ? readEditing(sessionId) : null;
      takeBack((result.queued ?? []).filter((item) => item.id !== editing).map((item) => item.text));
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

  /**
   * `DELETE /queue/:itemId`; the queue's new shape arrives as `meta.queue` on the stream. Answers
   * whether the prompt was still queued: false once it has gone out (the turn ended as the button
   * was clicked) or was removed by another viewer.
   */
  const removeQueued = async (item: QueuedPrompt) => {
    if (!sessionId) return false;
    try {
      const response = await fetch(sessionUrl(sessionId, `/queue/${encodeURIComponent(item.id)}`), { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove the queued prompt. Try again.");
      const { removed } = (await response.json()) as { removed: boolean };
      return removed;
    } catch (error) {
      if (currentIdRef.current === sessionId) showRequestError(error instanceof Error ? error.message : "Could not remove the queued prompt. Try again.");
      return false;
    }
  };

  /**
   * Edit a queued prompt in place: `POST /queue/:itemId/edit` marks it (the queue sends nothing
   * while a prompt is being edited), its text goes into the composer ahead of the draft, and
   * Enter saves it back into the same slot (see `submitPrompt`). A prompt that already went out
   * (404) is not restored, so nothing runs twice. Starting on another prompt while one is being
   * edited moves the edit: the new prompt is marked first, then the old edit is cancelled, so
   * the queue stays paused throughout (ending the old edit first could send the head) and no
   * prompt is left pausing it afterwards.
   */
  const editQueued = async (item: QueuedPrompt) => {
    if (!sessionId) return;
    try {
      const previous = readEditing(sessionId);
      const response = await fetch(queueItemUrl(sessionId, item.id, "/edit"), { method: "POST" });
      if (!response.ok) throw await queueRequestError(response, "Could not edit the queued prompt. Try again.");
      const result = (await response.json().catch(() => ({}))) as { item?: QueuedPrompt };
      if (previous && previous !== item.id)
        await fetch(queueItemUrl(sessionId, previous, "/edit"), { method: "DELETE" }).catch(() => undefined);
      if (currentIdRef.current !== sessionId) return;
      writeEditing(sessionId, item.id);
      // The server's copy is current (another viewer may have saved an edit); a queued prompt is never blank.
      takeBack([result.item?.text || item.text]);
    } catch (error) {
      if (currentIdRef.current === sessionId)
        showRequestError(error instanceof Error ? error.message : "Could not edit the queued prompt. Try again.");
    }
  };

  /** Leave the edit: `DELETE /queue/:itemId/edit` keeps the prompt's original text in its slot, and the composer keeps its text. */
  const cancelEdit = async () => {
    if (!sessionId) return;
    const itemId = readEditing(sessionId);
    if (!itemId) return;
    try {
      const response = await fetch(queueItemUrl(sessionId, itemId, "/edit"), { method: "DELETE" });
      if (!response.ok) throw await queueRequestError(response, "Could not cancel the edit. Try again.");
      writeEditing(sessionId, null);
    } catch (error) {
      if (currentIdRef.current === sessionId)
        showRequestError(error instanceof Error ? error.message : "Could not cancel the edit. Try again.");
    }
  };

  // The edit ends with the prompt: removed by another viewer, sent, or dropped by Stop, it leaves
  // `meta.queue`, and the composer keeps its text. Only the stream's queue counts, so an edit
  // restored after a reload survives until the first `meta` says the prompt is gone.
  useEffect(() => {
    if (!sessionId || !editingId || !queueLive) return;
    if (!queue.some((item) => item.id === editingId)) writeEditing(sessionId, null);
  }, [sessionId, editingId, queueLive, queue]);

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
    /** The prompts waiting for the agent, first to go out first. */
    queue,
    /** The queued prompt this composer is editing (Enter saves it in place), or null. */
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
    /** The header's status line: the activity, hung and background as the sidebar says them, and background task titles. */
    statusLabel,
    awaitingPermission,
    /** Bumped after each accepted send; `Conversation` scrolls to the end on a change. */
    scrollRequest,
  };
}

export type SessionStream = ReturnType<typeof useSessionStream>;
