"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { KeyRound, LoaderCircle, PanelLeft, Play, Sparkles } from "lucide-react";
import ChatComposer from "./ChatComposer";
import IconButton from "./IconButton";
import PortalMessage, { formatTime } from "./PortalMessage";
import PortalNeedsYou from "./PortalNeedsYou";
import { isVisibleItem, type ItemCardHandlers } from "./PortalItemCard";
import { useDraft } from "./useDraft";
import { openSettings } from "./useSettings";
import { usePortalStream } from "./usePortalStream";
import { Button } from "@/components/ui/button";
import { clearSubmittedDraft, readDraft, writeDraft } from "@/lib/drafts";
import { recordPrompt } from "@/lib/prompt-history";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type {
  OrchestratorMessage,
  OrchestratorStatus,
  TickReport,
} from "@/lib/orchestrator/types";

const DRAFT_ID = "portal:orchestrator";
const HISTORY_KEY = "portal:orchestrator";
const providerNames = { openai: "OpenAI", anthropic: "Anthropic" } as const;

/** The header's one-line summary of where the orchestrator stands. */
export function describeStatus(
  status: OrchestratorStatus | null,
  responding: boolean,
  now = Date.now(),
): string {
  if (!status) return "Connecting…";
  if (!status.ready) return "Paused: add an API key";
  if (responding) return `${status.model} · Responding…`;
  if (status.busy) return "Checking…";
  if (status.nextTickAt === null) return `${status.model} · no check scheduled`;
  const minutes = Math.ceil((status.nextTickAt - now) / 60_000);
  return `${status.model} · ${minutes <= 0 ? "next check any moment" : `next check in ${minutes} min`}`;
}

/** "Checked at 10:42 · 2 changes, 1 new item" for the inline tick line. */
function describeTick(report: TickReport): string {
  const when = `Checked at ${formatTime(report.finishedAt)}`;
  if (report.error) return `${when} · failed: ${report.error}`;
  if (!report.modelInvoked) return `${when} · nothing new`;
  const parts = [`${report.changes} ${report.changes === 1 ? "change" : "changes"}`];
  if (report.itemsCreated.length) parts.push(`${report.itemsCreated.length} new`);
  if (report.itemsUpdated.length) parts.push(`${report.itemsUpdated.length} updated`);
  if (report.itemsResolved.length) parts.push(`${report.itemsResolved.length} resolved`);
  return `${when} · ${parts.join(", ")}`;
}

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

/**
 * Talk to Portal: the orchestrator's one thread, its action items, and a composer. Chat turns go
 * through `POST /api/portal/messages` (only the newest user message; the server owns history);
 * everything else arrives over `GET /api/portal/stream`.
 */
export default function PortalPage({
  onOpenSidebar,
  onOpenSession,
}: {
  onOpenSidebar: () => void;
  /** Navigate to a session, the way the sidebar does. */
  onOpenSession: (sessionId: string) => void;
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport<OrchestratorMessage>({
        api: "/api/portal/messages",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { message: messages.at(-1) },
        }),
      }),
    [],
  );
  const [chatError, setChatError] = useState<string | null>(null);
  /** Bumped whenever the server's thread should replace the local one; the load waits for our own turn to end. */
  const [historyRequest, setHistoryRequest] = useState(0);
  const refetchHistory = useCallback(() => setHistoryRequest((n) => n + 1), []);
  /**
   * The text of the turn in flight. The composer keeps it until the server has taken the message
   * (the reply starts streaming, or the turn finishes without error), so a refused send (409 while
   * a check is running, a dropped connection) never loses what the user typed.
   */
  const inFlight = useRef<string | null>(null);
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    status: chatStatus,
  } = useChat<OrchestratorMessage>({
    id: "portal",
    transport,
    onFinish: ({ isError }) => {
      const text = inFlight.current;
      inFlight.current = null;
      if (text !== null && !isError) {
        clearSubmittedDraft(DRAFT_ID, text);
        recordPrompt(HISTORY_KEY, text);
      }
    },
    onError: (error) => {
      setChatError(describeChatError(error));
      // The text came from a card, or the user cleared the composer meanwhile: put it back so it can be retried.
      const text = inFlight.current;
      inFlight.current = null;
      if (text !== null && readDraft(DRAFT_ID).trim() === "") writeDraft(DRAFT_ID, text);
      // The server did not keep this turn; reloading the thread drops the local copy.
      refetchHistory();
    },
  });
  const responding = chatStatus === "submitted" || chatStatus === "streaming";
  // The first chunk means the server accepted and persisted the message; the composer can let go of it.
  useEffect(() => {
    if (chatStatus !== "streaming" || inFlight.current === null) return;
    clearSubmittedDraft(DRAFT_ID, inFlight.current);
    recordPrompt(HISTORY_KEY, inFlight.current);
    inFlight.current = null;
  }, [chatStatus]);

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
        const r = await fetch("/api/portal/messages", { signal: controller.signal });
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
  }, [historyRequest, historyServed, responding, setMessages]);

  const live = usePortalStream(refetchHistory);
  const { status, items, lastTick, putItem, noteTick } = live;
  const ready = status?.ready ?? false;
  /** A tick is running: the server would answer a chat turn with 409, so the composer waits like it does mid-reply. */
  const checking = !responding && !!status?.busy;
  const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const needsYou = useMemo(
    () =>
      items
        .filter((item) => item.list === "needs_you" && isVisibleItem(item))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [items],
  );

  // The subtitle counts down; refresh it each minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The inline tick line shows for a few seconds, then leaves the header alone.
  const [expiredTickAt, setExpiredTickAt] = useState<number | null>(null);
  useEffect(() => {
    if (!lastTick) return;
    const timer = setTimeout(() => setExpiredTickAt(lastTick.at), 8000);
    return () => clearTimeout(timer);
  }, [lastTick]);
  const tickNotice = lastTick && expiredTickAt !== lastTick.at ? lastTick.report : null;

  const [draft, setDraft] = useDraft(DRAFT_ID);
  const composerWrap = useRef<HTMLDivElement>(null);
  /** Send `text` as the user's next message; false when nothing was sent (empty, not ready, mid-turn, or mid-check). */
  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !ready || responding || checking) return false;
      setChatError(null);
      inFlight.current = text;
      void sendMessage({ text: trimmed, metadata: { at: Date.now() } });
      return true;
    },
    [ready, responding, checking, sendMessage],
  );
  /** The composer's send: the draft stays put until the server has the message (see `inFlight`). */
  const send = () => void sendText(draft);
  /**
   * A card's "Ask Portal". When the turn cannot start right now (a reply or a check is running,
   * or there is no key yet) the text goes into the composer instead, ready to send, so nothing is
   * silently dropped.
   */
  const ask = useCallback(
    (text: string) => {
      if (sendText(text)) return;
      const current = readDraft(DRAFT_ID);
      if (!current.includes(text)) writeDraft(DRAFT_ID, current.trim() ? `${current.trimEnd()}\n${text}` : text);
      composerWrap.current?.querySelector("textarea")?.focus();
    },
    [sendText],
  );
  const stopTurn = () => {
    stop();
    fetch("/api/portal/cancel", { method: "POST" }).catch(() => {});
  };

  const [ticking, setTicking] = useState(false);
  const [tickError, setTickError] = useState<string | null>(null);
  const runNow = async () => {
    setTicking(true);
    setTickError(null);
    try {
      const r = await fetch("/api/portal/tick", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as { report?: TickReport; error?: string };
      if (!r.ok || !j.report) throw new Error(j.error ?? "Could not run a check. Try again.");
      noteTick(j.report);
    } catch (e) {
      setTickError(
        e instanceof Error && e.message !== "Failed to fetch"
          ? e.message
          : "Could not reach the server. Check the connection and try again.",
      );
    } finally {
      setTicking(false);
    }
  };

  const handlers: ItemCardHandlers = useMemo(
    () => ({ onOpenSession, onAsk: ask, onPatched: putItem }),
    [onOpenSession, ask, putItem],
  );

  const last = messages.at(-1);
  const waitingForReply =
    responding &&
    (!last || last.role === "user" || !last.parts.some((part) => part.type === "text" && part.text));
  const composerHint =
    !ready || checking ? (
      <span className="pl-2 text-[11px] font-normal text-muted-foreground">
        {!status
          ? "Connecting to Portal…"
          : !ready
            ? `Add a ${providerNames[status.provider]} API key in Settings to talk to Portal.`
            : "Portal is running a check. Your message can go once it finishes, or stop the check."}
      </span>
    ) : undefined;

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="workspace-header">
        <IconButton
          id="sidebar-toggle"
          label="Toggle sidebar"
          onClick={onOpenSidebar}
          className="text-muted-foreground"
        >
          <PanelLeft className="size-4" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="text-[13px] font-medium leading-snug tracking-[-.01em]">
            Talk to Portal
          </h1>
          <p className="mt-1 truncate text-[10px] text-muted-foreground" aria-live="polite">
            {describeStatus(status, responding, now)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!ready || ticking || !!status?.busy}
          onClick={() => void runNow()}
          className="text-xs text-foreground/80"
        >
          {ticking ? <LoaderCircle className="animate-spin" /> : <Play />}
          Run now
        </Button>
      </header>
      {(tickNotice || tickError || live.error) && (
        <p
          role={tickError || live.error ? "alert" : "status"}
          className={`border-b border-white/5 px-5 py-1.5 text-[11px] ${tickError || live.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {tickError ?? live.error ?? (tickNotice && describeTick(tickNotice))}
        </p>
      )}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={80}>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label="Talk to Portal">
            <MessageScrollerContent
              className="conversation-content !gap-8"
              role="log"
              aria-live="off"
              aria-label="Messages"
            >
              <PortalNeedsYou items={needsYou} handlers={handlers} />
              {status && !ready && (
                <div className="glass flex flex-col items-start gap-3 rounded-2xl p-5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <KeyRound className="size-4 text-amber-300" />
                    Talk to Portal needs an API key for {providerNames[status.provider]}.
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Portal chats and runs its periodic checks with {status.model}. Keys stay on this
                    machine and never reach the browser.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => openSettings("orchestrator")}
                  >
                    Add API key
                  </Button>
                </div>
              )}
              {historyLoading && (
                <p
                  role="status"
                  className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                  Opening the conversation…
                </p>
              )}
              {historyError && (
                <p role="alert" className="text-sm text-destructive">
                  {historyError}
                </p>
              )}
              {!historyLoading && messages.length === 0 && ready && (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <span className="glass rounded-2xl p-4">
                    <Sparkles className="size-7 text-foreground/80" />
                  </span>
                  <h2 className="mt-2 text-lg font-medium tracking-tight">
                    Ask Portal what needs you.
                  </h2>
                  <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                    It watches your sessions, pull requests, and worktrees between checks, and
                    keeps this one thread.
                  </p>
                </div>
              )}
              {messages.map((message, index) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  className="![content-visibility:visible]"
                >
                  <PortalMessage
                    message={message}
                    items={itemsById}
                    streaming={responding && index === messages.length - 1}
                    handlers={handlers}
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
          busy={responding || checking}
          disabled={!ready}
          label="Message Portal"
          historyKey={HISTORY_KEY}
          placeholder={ready ? "Ask Portal…" : "Add an API key to talk to Portal"}
          error={chatError}
          settings={composerHint}
        />
      </div>
    </main>
  );
}
