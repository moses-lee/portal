"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Archive, GitPullRequest, KeyRound, LoaderCircle, Sparkles, Target } from "lucide-react";
import ChatComposer from "../ChatComposer";
import PortalMessage from "../PortalMessage";
import PortalNeedsYou from "../PortalNeedsYou";
import { isVisibleItem, type ItemCardHandlers } from "../PortalItemCard";
import { useDraft } from "../useDraft";
import { openSettings } from "../useSettings";
import { usePortalEvents, usePortalLive } from "./PortalLive";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { clearSubmittedDraft, readDraft, writeDraft } from "@/lib/drafts";
import { formatDateTime } from "@/lib/orchestrator/format";
import { recordPrompt } from "@/lib/prompt-history";
import { MAIN_THREAD_ID, type OrchestratorMessage, type Thread } from "@/lib/orchestrator/types";

const providerNames = { openai: "OpenAI", anthropic: "Anthropic" } as const;

/** The transport throws the response body as the message; surface the server's `{ error }` when it is one. */
function describeChatError(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* Not JSON. */
  }
  return error.message === "Failed to fetch"
    ? "Could not reach the server. Check the connection and try again."
    : error.message || "Portal could not answer. Try again.";
}

/** Where a thread's messages live. The main thread keeps its original routes. */
function threadRoutes(threadId: string) {
  if (threadId === MAIN_THREAD_ID)
    return { messages: "/api/portal/messages", cancel: `/api/portal/threads/${MAIN_THREAD_ID}/cancel` };
  const base = `/api/portal/threads/${encodeURIComponent(threadId)}`;
  return { messages: `${base}/messages`, cancel: `${base}/cancel` };
}

/** Drafts and prompt history per thread; the main thread keeps the keys it had before side threads existed. */
const threadKey = (threadId: string) =>
  threadId === MAIN_THREAD_ID ? "portal:orchestrator" : `portal:orchestrator:${threadId}`;

/** What a side thread is about, above its messages: title, when Portal opened it, and its scope. */
function ThreadIntro({ thread, onOpenGoals }: { thread: Thread; onOpenGoals: () => void }) {
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
              onClick={onOpenGoals}
              className="inline-flex items-center gap-1 rounded-full bg-sky-300/10 px-2 text-[11px] leading-5 text-sky-200 hover:bg-sky-300/15"
            >
              <Target className="size-3" />
              View goal
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One thread's conversation: its history, its composer, its own send and stop. Turns go through
 * the thread's message route (only the newest user message; the server owns history). The composer
 * waits only for this thread's own turn; background jobs and other threads never block it. The page
 * keeps visited threads mounted (hidden) so a reply keeps streaming while the user looks elsewhere.
 */
export default function PortalThread({
  threadId,
  thread,
  visible,
  handlers,
  onOpenGoals,
}: {
  threadId: string;
  /** Null until the thread list arrives, or for a thread the server does not know. */
  thread: Thread | null;
  visible: boolean;
  handlers: Omit<ItemCardHandlers, "onAsk">;
  onOpenGoals: () => void;
}) {
  const live = usePortalLive();
  const { status, items } = live;
  const routes = useMemo(() => threadRoutes(threadId), [threadId]);
  const key = threadKey(threadId);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<OrchestratorMessage>({
        api: routes.messages,
        prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } }),
      }),
    [routes],
  );
  const [chatError, setChatError] = useState<string | null>(null);
  /** Bumped whenever the server's thread should replace the local one; the load waits for our own turn to end. */
  const [historyRequest, setHistoryRequest] = useState(0);
  const refetchHistory = useCallback(() => setHistoryRequest((n) => n + 1), []);
  /**
   * The text of the turn in flight. The composer keeps it until the server has taken the message
   * (the reply starts streaming, or the turn finishes without error), so a refused send (409, a
   * dropped connection) never loses what the user typed.
   */
  const inFlight = useRef<string | null>(null);
  const { messages, setMessages, sendMessage, stop, status: chatStatus } = useChat<OrchestratorMessage>({
    id: `portal:${threadId}`,
    transport,
    onFinish: ({ isError }) => {
      const text = inFlight.current;
      inFlight.current = null;
      if (text !== null && !isError) {
        clearSubmittedDraft(key, text);
        recordPrompt(key, text);
      }
    },
    onError: (error) => {
      setChatError(describeChatError(error));
      // The text came from a card, or the user cleared the composer meanwhile: put it back so it can be retried.
      const text = inFlight.current;
      inFlight.current = null;
      if (text !== null && readDraft(key).trim() === "") writeDraft(key, text);
      // The server did not keep this turn; reloading the thread drops the local copy.
      refetchHistory();
    },
  });
  const responding = chatStatus === "submitted" || chatStatus === "streaming";
  // The first chunk means the server accepted and persisted the message; the composer can let go of it.
  useEffect(() => {
    if (chatStatus !== "streaming" || inFlight.current === null) return;
    clearSubmittedDraft(key, inFlight.current);
    recordPrompt(key, inFlight.current);
    inFlight.current = null;
  }, [chatStatus, key]);

  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** The newest request already answered; the server's `messages` event is what asks for the next one. */
  const [historyServed, setHistoryServed] = useState(-1);
  // Load the thread on mount and on every request, but never while a turn is streaming into it:
  // a turn that starts mid-load aborts it, and the load runs again once the turn ends.
  useEffect(() => {
    if (responding || historyServed >= historyRequest) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const r = await fetch(routes.messages, { signal: controller.signal });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "Could not load the conversation.");
        }
        const { messages: history } = (await r.json()) as { messages: OrchestratorMessage[] };
        if (controller.signal.aborted) return;
        setMessages(history);
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

  usePortalEvents((event) => {
    if (event.type === "reconnected") refetchHistory();
    else if (event.type === "messages" && (event.threadId ?? MAIN_THREAD_ID) === threadId) refetchHistory();
  });

  const isMain = threadId === MAIN_THREAD_ID;
  const ready = status?.ready ?? false;
  const archived = thread?.status === "archived";
  /** A turn in this thread that this view did not start (another tab, or one still running from before a reload). */
  const otherTurn = !responding && !!status?.busyThreads.includes(threadId);
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const needsYou = useMemo(
    () =>
      isMain
        ? items
            .filter((item) => item.list === "needs_you" && isVisibleItem(item))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : [],
    [items, isMain],
  );

  const [draft, setDraft] = useDraft(key);
  const composerWrap = useRef<HTMLDivElement>(null);
  /** Send `text` as the user's next message; false when nothing was sent (empty, not ready, archived, or mid-turn). */
  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !ready || archived || responding || otherTurn) return false;
      setChatError(null);
      inFlight.current = text;
      void sendMessage({ text: trimmed, metadata: { at: Date.now() } });
      return true;
    },
    [ready, archived, responding, otherTurn, sendMessage],
  );
  const send = () => void sendText(draft);
  /**
   * A card's "Ask Portal". When the turn cannot start right now (a reply is running, or there is
   * no key yet) the text goes into the composer instead, ready to send, so nothing is dropped.
   */
  const ask = useCallback(
    (text: string) => {
      if (sendText(text)) return;
      const current = readDraft(key);
      if (!current.includes(text)) writeDraft(key, current.trim() ? `${current.trimEnd()}\n${text}` : text);
      composerWrap.current?.querySelector("textarea")?.focus();
    },
    [sendText, key],
  );
  const stopTurn = () => {
    stop();
    fetch(routes.cancel, { method: "POST" }).catch(() => {});
  };
  const cardHandlers: ItemCardHandlers = useMemo(() => ({ ...handlers, onAsk: ask }), [handlers, ask]);

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
          <MessageScrollerViewport aria-label={isMain ? "Talk to Portal" : thread?.title ?? "Thread"}>
            <MessageScrollerContent
              className="conversation-content !gap-8"
              role="log"
              aria-live="off"
              aria-label="Messages"
            >
              {isMain && <PortalNeedsYou items={needsYou} handlers={cardHandlers} />}
              {!isMain && thread && <ThreadIntro thread={thread} onOpenGoals={onOpenGoals} />}
              {isMain && status && !ready && (
                <div className="glass flex flex-col items-start gap-3 rounded-2xl p-5">
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
                  <span className="glass rounded-2xl p-4">
                    <Sparkles className="size-7 text-foreground/80" />
                  </span>
                  <h2 className="mt-2 text-lg font-medium tracking-tight">Ask Portal what needs you.</h2>
                  <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                    It keeps an eye on your sessions, pull requests, and worktrees in the background,
                    and opens a side thread when a task needs its own.
                  </p>
                </div>
              )}
              {messages.map((message, index) => (
                <MessageScrollerItem key={message.id} messageId={message.id} className="![content-visibility:visible]">
                  <PortalMessage
                    message={message}
                    items={itemsById}
                    streaming={responding && index === messages.length - 1}
                    handlers={cardHandlers}
                  />
                </MessageScrollerItem>
              ))}
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
      <div ref={composerWrap} className="composer-wrap">
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={stopTurn}
          busy={responding || otherTurn}
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
