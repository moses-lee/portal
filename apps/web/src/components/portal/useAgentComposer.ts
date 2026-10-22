"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WorkspaceView } from "@portal/contracts/workspace";
import type { QueuedPrompt } from "@/lib/types";
import { portalJson, portalSend, portalRoutes } from "@/lib/orchestrator/api";
import { readDraft, writeDraft } from "@/lib/drafts";
import { restoreToDraft } from "@/lib/prompt-queue";
import { readEditing, subscribeEditing, writeEditing } from "@/lib/queue-edit";
import { useSend } from "../useSend";
import { usePortalEvents } from "./PortalLive";

const queuePath = "/api/portal/queue";
const itemPath = (id: string) => `${queuePath}/${encodeURIComponent(id)}`;

/** The Agent chat's queue controls share the session composer's editing and draft restoration rules. */
export function useAgentComposer({ draftKey, ready, busy, submitTurn, stopStream, currentView, describeError }: {
  draftKey: string;
  ready: boolean;
  busy: boolean;
  submitTurn: (text: string) => Promise<void>;
  stopStream: () => void;
  currentView: () => WorkspaceView;
  describeError: (error: unknown) => string;
}) {
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const version = useRef(0);
  const editingId = useSyncExternalStore(subscribeEditing, () => readEditing(draftKey), () => null);
  const readQueue = useCallback((signal?: AbortSignal) => {
    const requestedAt = version.current;
    return portalJson<{ queue: QueuedPrompt[] }>(queuePath, { signal }).then((result) => {
      if (signal?.aborted || requestedAt !== version.current) return;
      setQueue(result.queue);
      setLoaded(true);
      setQueueError(null);
    }).catch((error: unknown) => {
      if (!signal?.aborted) setQueueError(describeError(error));
    });
  }, [describeError]);
  useEffect(() => {
    const controller = new AbortController();
    void readQueue(controller.signal);
    return () => controller.abort();
  }, [readQueue]);
  usePortalEvents((event) => {
    if (event.type === "queue") {
      version.current++;
      setQueue(event.queue);
      setLoaded(true);
      setQueueError(null);
    } else if (event.type === "reconnected") void readQueue();
  });
  useEffect(() => {
    if (loaded && editingId && !queue.some((item) => item.id === editingId)) writeEditing(draftKey, null);
  }, [loaded, editingId, queue, draftKey]);

  const submit = useCallback(async (text: string) => {
    const editing = readEditing(draftKey);
    if (editing) {
      const response = await fetch(itemPath(editing), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!response.ok) {
        if (response.status === 404) writeEditing(draftKey, null);
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? "Could not save the queued prompt.");
      }
      writeEditing(draftKey, null);
    } else if (busy || (queue.length > 0 && !queue.some((item) => item.editing))) {
      await portalSend(queuePath, "POST", { text, view: currentView() });
    } else {
      try { await submitTurn(text); }
      catch (error) {
        // Another viewer may take the turn between the status snapshot and this request.
        if (/still answering|queued prompts waiting/.test(describeError(error))) {
          await portalSend(queuePath, "POST", { text, view: currentView() });
        } else throw error;
      }
    }
  }, [draftKey, busy, queue, currentView, submitTurn, describeError]);
  const composer = useSend({
    draftKey, historyKey: draftKey, submit,
    canSend: () => ready && loaded,
    describeError,
  });
  const heldBack = useRef<string[]>([]);
  const takeBack = (texts: string[]) => {
    if (composer.sending) heldBack.current.push(...texts);
    else writeDraft(draftKey, restoreToDraft(texts, readDraft(draftKey)));
  };
  useEffect(() => {
    if (composer.sending || !heldBack.current.length) return;
    writeDraft(draftKey, restoreToDraft(heldBack.current.splice(0), readDraft(draftKey)));
  }, [composer.sending, draftKey]);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setQueueError(null);
    try {
      const editing = readEditing(draftKey);
      const result = await portalSend<{ queued: QueuedPrompt[] } | undefined>(portalRoutes.cancel, "POST");
      stopStream();
      takeBack((result?.queued ?? []).filter((item) => item.id !== editing).map((item) => item.text));
      writeEditing(draftKey, null);
    } catch (error) {
      setQueueError(describeError(error));
    } finally { setStopping(false); }
  };
  const editQueued = async (item: QueuedPrompt) => {
    setQueueError(null);
    try {
      const previous = readEditing(draftKey);
      const result = await portalSend<{ item: QueuedPrompt }>(`${itemPath(item.id)}/edit`, "POST");
      if (previous && previous !== item.id) await portalSend(`${itemPath(previous)}/edit`, "DELETE");
      writeEditing(draftKey, item.id);
      takeBack([result.item.text]);
    } catch (error) { setQueueError(describeError(error)); }
  };
  const cancelEdit = async () => {
    const editing = readEditing(draftKey);
    if (!editing) return;
    try {
      await portalSend(`${itemPath(editing)}/edit`, "DELETE");
      writeEditing(draftKey, null);
    } catch (error) { setQueueError(describeError(error)); }
  };
  const removeQueued = async (item: QueuedPrompt) => {
    try { await portalSend(itemPath(item.id), "DELETE"); }
    catch (error) { setQueueError(describeError(error)); }
  };
  return { ...composer, error: queueError ?? composer.error, queue, loaded, editingId, editQueued, cancelEdit, removeQueued, stop, stopping };
}
