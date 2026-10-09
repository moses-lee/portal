"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Archive, GitPullRequest, KeyRound, LoaderCircle, Sparkles, Target } from "lucide-react";
import ChatComposer from "../ChatComposer";
import PortalMessage from "../PortalMessage";
import { DayDivider } from "../ChatTime";
import type { ItemCardHandlers } from "../PortalItemCard";
import { useSend } from "../useSend";
import { openSettings } from "../useSettings";
import { usePortalEvents, usePortalLive } from "./PortalLive";
import { useWorkspace } from "../WorkspaceProvider";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { daySections, formatDateTime } from "@/lib/orchestrator/format";
import { mergeMessages, prependOlder, replaceWithPage } from "@/lib/orchestrator/message-merge";
import { MAIN_THREAD_ID, type MessagePage, type OrchestratorMessage, type Thread } from "@/lib/orchestrator/types";
import { panelSessionFromSearch } from "@/lib/session-routes";
import { roomCover } from "@/room/layout";
import type { WorkspaceView } from "@portal/contracts/workspace";

const providerNames = { openai: "OpenAI", anthropic: "Anthropic" } as const;

/** The transport throws the response body as the message; surface the server's `{ error }` when it is one. */
function describeChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  try {
    const parsed = JSON.parse(message) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* Not JSON. */
  }
  return message === "Failed to fetch"
    ? "Could not reach the server. Check the connection and try again."
    : message || "Portal could not answer. Try again.";
}

/** Where a thread's messages live. The main thread keeps its original routes. */
function threadRoutes(threadId: string) {
  const base = `/api/portal/threads/${encodeURIComponent(threadId)}`;
  return {
    messages: threadId === MAIN_THREAD_ID ? "/api/portal/messages" : `${base}/messages`,
    message: (id: string) => `${base}/messages/${encodeURIComponent(id)}`,
    cancel: `${base}/cancel`,
  };
}

/** `GET` a page of messages; the response may lack cursors (an older server, a test fixture). */
async function fetchPage(url: string, signal?: AbortSignal): Promise<MessagePage> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? "Could not load the conversation.");
  }
  const page = (await r.json()) as Partial<MessagePage>;
  return { messages: page.messages ?? [], hasMore: page.hasMore ?? false, before: page.before ?? null, after: page.after ?? null };
}

/**
 * The send waiting for the server's acknowledgement. The reply's response opening (2xx) is the
 * acknowledgement: the server stores the user message before it starts the turn. A refused send
 * (409, a dropped connection) rejects it, so the composer keeps what the user typed.
 */
class Acknowledgement {
  private waiting: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  /** Settles with the next `accept` or `refuse`. */
  wait(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
  accept(): void {
    this.waiting?.resolve();
    this.waiting = null;
  }
  /** Rejects the waiting send; false when none was waiting (the error came after the acknowledgement). */
  refuse(error: unknown): boolean {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
    return waiting !== null;
  }
}

/** Drafts and prompt history per thread; the main thread keeps the keys it had before side threads existed. */
export const threadDraftKey = (threadId: string) =>
  threadId === MAIN_THREAD_ID ? "portal:orchestrator" : `portal:orchestrator:${threadId}`;

/** What a side thread is about, above its messages: title, when Portal opened it, and its scope. */
function ThreadIntro({ thread, onOpenWatches }: { thread: Thread; onOpenWatches: () => void }) {
  const { scope } = thread;
  const chips = [
    ...scope.pulls.map((pull) => ({ key: `pr:${pull.url}`, label: `${pull.repo}#${pull.number}`, href: pull.url })),
    ...scope.repos.map((repo) => ({ key: `repo:${repo}`, label: repo, href: undefined })),
    ...scope.people.map((login) => ({ key: `person:${login}`, label: `@${login}`, href: undefined })),
    ...scope.taskTypes.map((slug) => ({ key: `task:${slug}`, label: slug, href: undefined })),
  ];
  return (
    <div className="rounded-2xl border border-white/8 bg-white/[.02] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Sparkles className="size-3.5" />
        <span>Portal opened this thread {formatDateTime(thread.createdAt)}</span>
        {thread.status === "archived" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-white/8 px-1.5 leading-4 text-foreground/70">
            <Archive className="size-3" /> Archived
          </span>
        )}
      </div>
      <h2 className="mt-1 text-[15px] font-medium tracking-[-.01em]">{thread.title}</h2>
      {(chips.length > 0 || thread.intentId) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((chip) =>
            chip.href ? (
              <a
                key={chip.key}
                href={chip.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-white/6 px-2 text-[11px] leading-5 text-foreground/80 hover:bg-white/10"
              >
                <GitPullRequest className="size-3" />
                {chip.label}
              </a>
            ) : (
              <span key={chip.key} className="rounded-full bg-white/6 px-2 text-[11px] leading-5 text-foreground/80">
                {chip.label}
              </span>
            ),
          )}
          {thread.intentId && (
            <button
              type="button"
              onClick={onOpenWatches}
              className="inline-flex items-center gap-1 rounded-full bg-sky-300/10 px-2 text-[11px] leading-5 text-sky-200 hover:bg-sky-300/15"
            >
              <Target className="size-3" />
              View watch
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One thread's conversation: its history, its composer, its own send and stop. Turns go through
 * the thread's message route (only the newest user message; the server owns history). Sending
 * behaves as on a session page (`useSend`): the text stays in the box, with "Sending…", until the
 * server has taken the message, which for Portal is the reply stream opening (by then the message
 * is stored). The composer waits only for this thread's own turn; background jobs and other threads
 * never block it. The page keeps visited threads mounted (hidden) so a reply keeps streaming while
 * the user looks elsewhere.
 */
export default function PortalThread({
  threadId,
  thread,
  visible,
  handlers,
  onOpenWatches,
}: {
  threadId: string;
  /** Null until the thread list arrives, or for a thread the server does not know. */
  thread: Thread | null;
  visible: boolean;
  handlers: Omit<ItemCardHandlers, "onAsk">;
  onOpenWatches: () => void;
}) {
  const live = usePortalLive();
  const { status } = live;
  const { focus } = useWorkspace();
  /** The view at send time (stable, so the transport memoised on the routes sees the latest focus). */
  const currentView = useStableCallback((): WorkspaceView => {
    const panelSession = panelSessionFromSearch(window.location.search);
    if (panelSession) return { sessionId: panelSession, tabId: null, paneId: null };
    return { sessionId: focus.sessionId, tabId: focus.tabId, paneId: focus.paneId };
  });
  const routes = useMemo(() => threadRoutes(threadId), [threadId]);
  const key = threadDraftKey(threadId);
  const [ack] = useState(() => new Acknowledgement());
  const transport = useMemo(
    () =>
      new DefaultChatTransport<OrchestratorMessage>({
        api: routes.messages,
        // Decision 16: what this device is looking at goes with the message (the tracked panel's open session, else the focused pane).
        prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1), view: currentView() } }),
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.ok) ack.accept();
          return response;
        },
      }),
    [routes, ack, currentView],
  );
  /** Bumped whenever the server's thread should replace the local one; the load waits for our own turn to end. */
  const [historyRequest, setHistoryRequest] = useState(0);
  const refetchHistory = useCallback(() => setHistoryRequest((n) => n + 1), []);
  /** Shows an error that arrived after the server took the message (the reply broke off); set by `useSend` below. */
  const reportError = useRef<(message: string | null) => void>(() => {});
  const { messages, setMessages, sendMessage, stop, status: chatStatus } = useChat<OrchestratorMessage>({
    id: `portal:${threadId}`,
    transport,
    onFinish: ({ isError }) => {
      if (!isError) ack.accept();
    },
    onError: (error) => {
      const message = describeChatError(error);
      // Before the acknowledgement the send itself failed (useSend shows it); after, the reply did.
      if (!ack.refuse(new Error(message))) reportError.current(message);
      // The server did not keep this turn; reloading the thread drops the local copy.
      refetchHistory();
    },
  });
  const responding = chatStatus === "submitted" || chatStatus === "streaming";

  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** The newest request already answered; a failed turn is what asks for the next one. */
  const [historyServed, setHistoryServed] = useState(-1);
  /** Where the loaded messages sit in the thread: cursors for the page before and for what arrived since. */
  const cursor = useRef<{ before: number | null; after: number | null }>({ before: null, after: null });
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  /** A `messages` event arrived while a turn was streaming here; fetched once the turn ends. */
  const newerPending = useRef(false);
  // Load the newest page on mount and on every request, but never while a turn is streaming into
  // it: a turn that starts mid-load aborts it, and the load runs again once the turn ends.
  useEffect(() => {
    if (responding || historyServed >= historyRequest) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const page = await fetchPage(routes.messages, controller.signal);
        if (controller.signal.aborted) return;
        // Unchanged messages keep the objects already held, so their memoised rows skip rendering.
        setMessages((prev) => replaceWithPage(prev, page.messages));
        cursor.current = { before: page.before, after: page.after };
        setHasMore(page.hasMore);
        setHistoryError(null);
        setHistoryServed(historyRequest);
      } catch (e) {
        if (controller.signal.aborted) return;
        setHistoryError(
          e instanceof Error && e.message !== "Failed to fetch"
            ? e.message
            : "Could not load the conversation. Check the server and reload the page to retry.",
        );
      } finally {
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [historyRequest, historyServed, responding, routes, setMessages]);

  /**
   * Bring in what the server appended since the newest message held (a job's note, the stored copy
   * of a turn just streamed here), merged by id so untouched messages keep their identity. Without a
   * cursor yet (the first page has not landed, or the server sent none) the newest page is reloaded.
   */
  const fetchNewer = useCallback(async () => {
    const after = cursor.current.after;
    if (after === null) {
      refetchHistory();
      return;
    }
    try {
      const page = await fetchPage(`${routes.messages}?after=${after}`);
      setMessages((prev) => mergeMessages(prev, page.messages));
      if (page.after !== null) cursor.current.after = page.after;
    } catch {
      // The next event, or a reconnect, tries again.
    }
  }, [routes, setMessages, refetchHistory]);

  usePortalEvents((event) => {
    if (event.type !== "reconnected" && !(event.type === "messages" && (event.threadId ?? MAIN_THREAD_ID) === threadId)) return;
    // The SDK owns the message list while it streams; the server's copies are merged once it is done.
    if (responding) newerPending.current = true;
    else void fetchNewer();
  });
  useEffect(() => {
    if (responding || !newerPending.current) return;
    newerPending.current = false;
    void fetchNewer();
  }, [responding, fetchNewer]);

  /** The page before the oldest message held, prepended; the scroller keeps the viewport where it was. */
  const loadOlder = useCallback(async () => {
    const before = cursor.current.before;
    if (before === null || loadingOlderRef.current || historyLoading) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(`${routes.messages}?before=${before}`);
      setMessages((prev) => prependOlder(prev, page.messages));
      if (page.before !== null) cursor.current.before = page.before;
      setHasMore(page.hasMore);
    } catch {
      setHistoryError("Could not load earlier messages. Scroll up to retry.");
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [routes, setMessages, historyLoading]);

  /** A paged message comes without its tool traffic; opening a tool row fetches the whole message once. */
  const loadingToolIO = useRef(new Set<string>());
  const loadToolIO = useCallback(
    async (messageId: string) => {
      if (loadingToolIO.current.has(messageId)) return;
      loadingToolIO.current.add(messageId);
      try {
        const r = await fetch(routes.message(messageId));
        if (!r.ok) return;
        const { message } = (await r.json()) as { message: OrchestratorMessage };
        setMessages((prev) => prev.map((current) => (current.id === messageId ? message : current)));
      } catch {
        // Leave the placeholder; the next open retries.
      } finally {
        loadingToolIO.current.delete(messageId);
      }
    },
    [routes, setMessages],
  );

  const isMain = threadId === MAIN_THREAD_ID;
  const ready = status?.ready ?? false;
  const archived = thread?.status === "archived";
  /** A turn in this thread that this view did not start (another tab, or one still running from before a reload). */
  const otherTurn = !responding && !!status?.busyThreads.includes(threadId);

  /** Start the turn; settles when the reply stream opens (taken) or the send is refused. */
  const submit = useCallback(
    (text: string) => {
      const taken = ack.wait();
      sendMessage({ text, metadata: { at: Date.now() } }).catch((error: unknown) => ack.refuse(error));
      return taken;
    },
    [sendMessage, ack],
  );
  const canSend = useCallback(() => ready && !archived && !responding && !otherTurn, [ready, archived, responding, otherTurn]);
  const { draft, setDraft, sending, error: chatError, send, reportError: setChatError } = useSend({
    draftKey: key,
    historyKey: key,
    submit,
    canSend,
    describeError: describeChatError,
  });
  useEffect(() => {
    reportError.current = setChatError;
  }, [setChatError]);
  const composerWrap = useRef<HTMLDivElement>(null);
  const stopTurn = () => {
    stop();
    fetch(routes.cancel, { method: "POST" }).catch(() => {});
  };
  /**
   * The rows are memoised; `handlers` changes identity whenever the page above re-renders, so the
   * rows get a stable callback that reads the newest handler instead.
   */
  const latestHandlers = useRef(handlers);
  useLayoutEffect(() => {
    latestHandlers.current = handlers;
  }, [handlers]);
  const openCurationRun = useCallback((runId: string) => latestHandlers.current.onOpenCurationRun?.(runId), []);
  const canOpenCurationRun = !!handlers.onOpenCurationRun;

  /** Where the day dividers go, and the day each message sits under (0 before the first known time). */
  const days = useMemo(() => daySections(messages.map((message) => message.metadata?.at ?? 0)), [messages]);

  const last = messages.at(-1);
  const waitingForReply =
    (responding && (!last || last.role === "user" || !last.parts.some((part) => part.type === "text" && part.text))) ||
    otherTurn;
  const hint = !status
    ? "Connecting to Portal…"
    : !ready
      ? `Add a ${providerNames[status.provider]} API key in Settings to talk to Portal.`
      : archived
        ? "Portal archived this thread. Continue in the main thread."
        : otherTurn
          ? "Portal is answering in this thread. You can stop it, or wait for the reply."
          : null;

  return (
    <div hidden={!visible} className="flex min-h-0 flex-1 flex-col" data-thread={threadId}>
      <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={80}>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport
            data-room-passthrough
            aria-label={isMain ? "Talk to Portal" : thread?.title ?? "Thread"}
            preserveScrollOnPrepend
            onScroll={(event) => {
              if (event.currentTarget.scrollTop < 200 && hasMore && !historyLoading && !loadingOlder) void loadOlder();
            }}
          >
            {/* Outside the message list so its first item stays a stable scroll anchor. */}
            {(hasMore || loadingOlder) && (
              <div className="flex justify-center px-6 pt-4">
                <Button type="button" variant="ghost" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                </Button>
              </div>
            )}
            <MessageScrollerContent
              ref={roomCover("column")}
              className="conversation-content !gap-8"
              role="log"
              aria-live="off"
              aria-label="Messages"
            >
              {!isMain && thread && <ThreadIntro thread={thread} onOpenWatches={onOpenWatches} />}
              {isMain && status && !ready && (
                <div className="frost flex flex-col items-start gap-3 rounded-2xl p-5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <KeyRound className="size-4 text-amber-300" />
                    Talk to Portal needs an API key for {providerNames[status.provider]}.
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Portal chats and runs its background work with {status.model}. Keys stay on this
                    machine and never reach the browser.
                  </p>
                  <Button type="button" variant="secondary" size="sm" onClick={() => openSettings("orchestrator")}>
                    Add API key
                  </Button>
                </div>
              )}
              {historyLoading && (
                <p role="status" className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  Opening the conversation…
                </p>
              )}
              {historyError && (
                <p role="alert" className="text-sm text-destructive">
                  {historyError}
                </p>
              )}
              {isMain && !historyLoading && messages.length === 0 && ready && (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <span className="frost rounded-2xl p-4">
                    <Sparkles className="size-7 text-foreground/80" />
                  </span>
                  <h2 className="mt-2 text-lg font-medium tracking-tight">Ask Portal what needs you.</h2>
                  <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                    It keeps an eye on your sessions, pull requests, and worktrees in the background,
                    and opens a side thread when a task needs its own.
                  </p>
                </div>
              )}
              {messages.map((message, index) => {
                const { divider, day } = days[index];
                return (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    {divider !== null && <DayDivider at={divider} className="mb-8" />}
                    <PortalMessage
                      message={message}
                      streaming={responding && index === messages.length - 1}
                      day={day}
                      onOpenCurationRun={canOpenCurationRun ? openCurationRun : undefined}
                      onLoadToolIO={loadToolIO}
                    />
                  </MessageScrollerItem>
                );
              })}
              {waitingForReply && (
                <p role="status" className="flex items-center gap-2.5 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Thinking…
                </p>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      <div ref={composerWrap} className="composer-wrap" data-draft-key={key}>
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={stopTurn}
          busy={(responding && !sending) || otherTurn}
          sending={sending}
          disabled={!ready || archived}
          label={isMain ? "Message Portal" : `Message Portal in ${thread?.title ?? "this thread"}`}
          historyKey={key}
          placeholder={
            archived ? "This thread is archived" : !ready ? "Add an API key to talk to Portal" : isMain ? "Ask Portal…" : "Reply in this thread…"
          }
          error={chatError}
          settings={hint ? <span className="pl-2 text-[11px] font-normal text-muted-foreground">{hint}</span> : undefined}
        />
      </div>
    </div>
  );
}
