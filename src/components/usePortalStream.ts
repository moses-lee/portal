"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Item,
  OrchestratorEvent,
  OrchestratorStatus,
  TickReport,
  Watch,
} from "@/lib/orchestrator/types";

export type PortalLive = {
  /** Null until the first `GET /api/portal` or stream `status` lands. */
  status: OrchestratorStatus | null;
  items: Item[];
  watches: Watch[];
  /** The most recent tick report pushed over the stream, with when it arrived. */
  lastTick: { report: TickReport; at: number } | null;
  /** Apply a locally known item (an optimistic PATCH result) before the stream confirms it. */
  putItem: (item: Item) => void;
  /** Show a tick report that arrived some other way (the `Run now` response). */
  noteTick: (report: TickReport) => void;
  /** Message from the last failed load; the stream's reconnects are silent. */
  error: string | null;
};

const MIN_RETRY = 1000;
const MAX_RETRY = 30_000;

/**
 * The orchestrator's live state: `GET /api/portal/stream` opens with `status`, `items`, and
 * `watches`, then pushes changes. `onMessagesChanged` fires for `messages` events (the thread
 * changed outside this viewer's chat turn) and whenever the stream reopens after a drop, since
 * events sent in between are gone. The browser reconnects a dropped `EventSource` on its own; a
 * refused one (the server answered with an error) is retried here with backoff.
 */
export function usePortalStream(onMessagesChanged: () => void): PortalLive {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [lastTick, setLastTick] = useState<PortalLive["lastTick"]>(null);
  const [error, setError] = useState<string | null>(null);
  const onMessages = useRef(onMessagesChanged);
  useEffect(() => {
    onMessages.current = onMessagesChanged;
  }, [onMessagesChanged]);

  // The header should not wait for the stream, and a refused stream cannot say why (EventSource
  // hides the response), so prime `status` once over REST. Items and watches come from the stream
  // alone: it opens with both, and a slower REST answer must not overwrite what it delivered.
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const r = await fetch("/api/portal", { signal: controller.signal });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? "Could not reach Talk to Portal.");
        }
        const { status } = (await r.json()) as { status: OrchestratorStatus };
        if (controller.signal.aborted) return;
        // The stream's copy, when it got here first, is the fresher one.
        setStatus((prev) => prev ?? status);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(
          e instanceof Error && e.message !== "Failed to fetch"
            ? e.message
            : "Could not reach the server. Check the connection and reload the page to retry.",
        );
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retry = MIN_RETRY;
    let stopped = false;
    let opens = 0;
    const connect = () => {
      if (stopped) return;
      es = new EventSource("/api/portal/stream");
      es.onopen = () => {
        retry = MIN_RETRY;
        // A reopened stream missed whatever `messages` events fell into the gap; the thread may be stale.
        if (opens++ > 0) onMessages.current();
      };
      es.onmessage = (m) => {
        const event = JSON.parse(m.data) as OrchestratorEvent;
        switch (event.type) {
          case "status":
            setStatus(event.status);
            setError(null);
            return;
          case "items":
            setItems(event.items);
            return;
          case "watches":
            setWatches(event.watches);
            return;
          case "tick":
            setLastTick({ report: event.report, at: Date.now() });
            return;
          case "messages":
            onMessages.current();
            return;
        }
      };
      es.onerror = () => {
        // CLOSED means the server refused the stream (not ready, error); the browser gives up, so retry ourselves.
        if (es?.readyState !== EventSource.CLOSED) return;
        es.close();
        es = null;
        timer = setTimeout(connect, retry);
        retry = Math.min(MAX_RETRY, retry * 2);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, []);

  const putItem = useCallback((item: Item) => {
    setItems((prev) =>
      prev.some((i) => i.id === item.id)
        ? prev.map((i) => (i.id === item.id ? item : i))
        : [...prev, item],
    );
  }, []);
  const noteTick = useCallback((report: TickReport) => {
    setLastTick((prev) =>
      prev?.report.id === report.id ? prev : { report, at: Date.now() },
    );
  }, []);

  return { status, items, watches, lastTick, putItem, noteTick, error };
}
