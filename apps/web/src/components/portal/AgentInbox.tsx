"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePortalEvents, usePortalLive } from "./PortalLive";
import type { AgentActivity } from "@/lib/agent-activity";
import { isAbort, portalJson, threadRoutes } from "@/lib/orchestrator/api";
import { portalActivity } from "@/lib/orchestrator/format";
import { MAIN_THREAD_ID, type MessagePage } from "@/lib/orchestrator/types";
import { REPLY_PREVIEW_MS, replyPreview } from "@/lib/workspace-mobile";

/** A reply that landed while Agent was closed, for the phone's preview above the composer. */
export type AgentReplyPreview = {
  /** Changes with every reply, so a newer one replaces the shown preview (and restarts its time). */
  key: number;
  threadId: string;
  text: string;
};

/** What the shell knows about Agent while it is closed, and the way to open it. */
export type AgentInbox = {
  /** Working while Portal answers in any thread, waiting while an approval is pending. */
  activity: AgentActivity;
  /** Threads with messages the user has not seen (Agent closed, or open on another thread). */
  unread: ReadonlySet<string>;
  /** The latest reply's preview, on a phone only; null once it is opened, dismissed or timed out. */
  preview: AgentReplyPreview | null;
  dismissPreview: () => void;
  /** Open Agent, on `threadId` when given (else the thread it was last on). */
  openAgent: (threadId?: string) => void;
};

const AgentInboxContext = createContext<AgentInbox | null>(null);

export const AgentInboxProvider = AgentInboxContext.Provider;

/** The shell's Agent inbox; null outside the shell. */
export function useAgentInbox(): AgentInbox | null {
  return useContext(AgentInboxContext);
}

/**
 * The shell's side of Agent: which threads have news, and on a phone (`previews`) the latest
 * reply's text, fetched when a `messages` event lands while Agent is closed. It lives in the shell
 * rather than the dialog so the bar can show it before Agent has ever been opened.
 */
export function useAgentInboxState({ open, threadId, previews, openAgent }: {
  open: boolean;
  threadId: string;
  previews: boolean;
  openAgent: (threadId?: string) => void;
}): AgentInbox {
  const { status, approvals } = usePortalLive();
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  if (open && unread.has(threadId)) {
    const next = new Set(unread);
    next.delete(threadId);
    setUnread(next);
  }
  const [preview, setPreview] = useState<AgentReplyPreview | null>(null);
  if (open && preview) setPreview(null);

  /** The preview's fetch in flight; a newer reply (or opening Agent) supersedes it. */
  const loading = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) loading.current?.abort();
  }, [open]);
  useEffect(() => () => loading.current?.abort(), []);

  usePortalEvents((event) => {
    if (event.type !== "messages") return;
    const id = event.threadId ?? MAIN_THREAD_ID;
    if (open && id === threadId) return;
    setUnread((current) => (current.has(id) ? current : new Set(current).add(id)));
    if (open || !previews) return;
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    portalJson<Partial<MessagePage>>(`${threadRoutes(id).messages}?limit=1`, { signal: controller.signal })
      .then((page) => {
        const text = replyPreview(page.messages?.at(-1));
        if (controller.signal.aborted || openRef.current || !text) return;
        setPreview({ key: Date.now(), threadId: id, text });
      })
      .catch((error: unknown) => {
        // A preview is a courtesy: the unread dot already says there is news.
        if (!isAbort(error)) console.warn("Could not load Portal's reply for its preview:", error);
      });
  });

  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), REPLY_PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [preview]);
  const dismissPreview = useCallback(() => setPreview(null), []);

  const activity = portalActivity(status, approvals);
  return useMemo(() => ({ activity, unread, preview, dismissPreview, openAgent }), [activity, unread, preview, dismissPreview, openAgent]);
}
