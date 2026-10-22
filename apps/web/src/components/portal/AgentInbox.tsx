"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePortalEvents, usePortalLive } from "./PortalLive";
import type { AgentActivity } from "@/lib/agent-activity";
import { isAbort, portalJson, portalRoutes } from "@/lib/orchestrator/api";
import { portalActivity } from "@/lib/orchestrator/format";
import type { MessagePage } from "@/lib/orchestrator/types";
import { REPLY_PREVIEW_MS, replyPreview } from "@/lib/workspace-mobile";

/** A reply that landed while Agent was closed, for the phone's preview above the composer. */
export type AgentReplyPreview = {
  /** Changes with every reply, so a newer one replaces the shown preview (and restarts its time). */
  key: number;
  text: string;
};

/** What the shell knows about Agent while it is closed, and the way to open it. */
export type AgentInbox = {
  /** Working while Portal answers, waiting while an approval is pending. */
  activity: AgentActivity;
  /** The chat has messages the user has not seen (they arrived while Agent was closed). */
  unread: boolean;
  /** The latest reply's preview, on a phone only; null once it is opened, dismissed or timed out. */
  preview: AgentReplyPreview | null;
  dismissPreview: () => void;
  openAgent: () => void;
};

const AgentInboxContext = createContext<AgentInbox | null>(null);

export const AgentInboxProvider = AgentInboxContext.Provider;

/** The shell's Agent inbox; null outside the shell. */
export function useAgentInbox(): AgentInbox | null {
  return useContext(AgentInboxContext);
}

/**
 * The shell's side of Agent: whether the chat has news, and on a phone (`previews`) the latest
 * reply's text, fetched when a `messages` event lands while Agent is closed. It lives in the shell
 * rather than the dialog so the bar can show it before Agent has ever been opened.
 */
export function useAgentInboxState({ open, previews, openAgent }: {
  open: boolean;
  previews: boolean;
  openAgent: () => void;
}): AgentInbox {
  const { status, approvals } = usePortalLive();
  const [unread, setUnread] = useState(false);
  if (open && unread) setUnread(false);
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
    if (event.type !== "messages" || open) return;
    setUnread(true);
    if (!previews) return;
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    portalJson<Partial<MessagePage>>(`${portalRoutes.messages}?limit=1`, { signal: controller.signal })
      .then((page) => {
        const text = replyPreview(page.messages?.at(-1));
        if (controller.signal.aborted || openRef.current || !text) return;
        setPreview({ key: Date.now(), text });
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
