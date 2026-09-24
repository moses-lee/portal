"use client";

import { useCallback, useRef, useState } from "react";
import { useDraft } from "./useDraft";
import { clearSubmittedDraft, readDraft, writeDraft } from "@/lib/drafts";
import { recordPrompt } from "@/lib/prompt-history";

export type UseSendOptions = {
  /** The conversation's draft id (see `@/lib/drafts`). */
  draftKey: string;
  /** Where accepted prompts are recorded for Up/Down recall; none when omitted. */
  historyKey?: string;
  /**
   * Hand the trimmed text to the server. Resolves once the server has taken the message (the
   * prompt was accepted, the reply stream opened); rejects with the reason when it did not.
   */
  submit: (text: string) => Promise<void>;
  /** Whether a send may start right now (the agent is idle, the thread takes messages, ...). */
  canSend?: () => boolean;
  /** Runs once the server has taken a message (scroll to the end, ...). */
  onSent?: () => void;
  /** The text shown for a refused send; null shows nothing (the send was called off, not refused). */
  describeError?: (error: unknown) => string | null;
};

const defaultDescribe = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message === "Failed to fetch") return "Could not reach the server. Check the connection and try again.";
  return message || "Could not send your message. Your draft is saved; try again.";
};

/**
 * The composer's send behaviour, shared by agent sessions and Talk to Portal: the draft stays in
 * the box while the server is asked, with the send button showing "Sending…"; once the server has
 * taken the message the draft is cleared (unless the user has edited it meanwhile) and the prompt
 * joins the conversation's Up/Down history; a refused send keeps the text and shows the reason.
 * Text sent from elsewhere (a card's "Ask Portal") is put back into an empty draft when refused,
 * so nothing typed or clicked is lost.
 */
export function useSend({ draftKey, historyKey, submit, canSend, onSent, describeError = defaultDescribe }: UseSendOptions) {
  const [draft, setDraft] = useDraft(draftKey);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A send is in flight: between asking the server and its answer. */
  const pending = useRef(false);

  /**
   * Send `text` (the draft by default). Returns false at once when nothing was sent: empty text, a
   * send already in flight, or `canSend` said no. The server's answer arrives later, in state.
   */
  const send = useCallback(
    (text: string = readDraft(draftKey)): boolean => {
      const trimmed = text.trim();
      if (!trimmed || pending.current || (canSend && !canSend())) return false;
      pending.current = true;
      setSending(true);
      setError(null);
      void (async () => {
        try {
          await submit(trimmed);
          clearSubmittedDraft(draftKey, text);
          if (historyKey) recordPrompt(historyKey, trimmed);
          onSent?.();
        } catch (e) {
          const message = describeError(e);
          if (message !== null) {
            setError(message);
            // The text came from elsewhere, or the user cleared the box meanwhile: put it back to retry.
            if (readDraft(draftKey).trim() === "") writeDraft(draftKey, text);
          }
        } finally {
          pending.current = false;
          setSending(false);
        }
      })();
      return true;
    },
    [draftKey, historyKey, submit, canSend, onSent, describeError],
  );

  /** Show an error that arrived after the server took the message (the reply broke off). */
  const reportError = useCallback((message: string | null) => setError(message), []);

  return { draft, setDraft, sending, error, send, reportError };
}
