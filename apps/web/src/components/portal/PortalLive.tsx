"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Approval,
  Intent,
  Item,
  OrchestratorEvent,
  OrchestratorStatus,
  Thread,
} from "@/lib/orchestrator/types";

/** What listeners receive: every server event, plus `reconnected` when the stream reopens after a drop (anything may be stale). */
export type PortalLiveEvent = OrchestratorEvent | { type: "reconnected" };

export type PortalLive = {
  /** Null until the first `GET /api/portal` or stream `status` lands. */
  status: OrchestratorStatus | null;
  items: Item[];
  /** Main first, then the agent's side threads (as the server orders them), archived ones included. */
  threads: Thread[];
  /** Active intents, as the stream pushes them. */
  intents: Intent[];
  /** Pending approval requests; the approvals dialog shows them whenever there are any. */
  approvals: Approval[];
  /** Message from the last failed load; the stream's reconnects are silent. */
  error: string | null;
  /** Apply a locally known item (an optimistic PATCH result) before the stream confirms it. */
  putItem: (item: Item) => void;
  /** Apply an intent the server just answered with (a cancel drops it from the active list). */
  putIntent: (intent: Intent) => void;
  /** Replace the pending approvals with a fresher list (a REST read), or drop one that was just decided. */
  setApprovals: (update: (current: Approval[]) => Approval[]) => void;
  /** Hear every event; returns the unsubscribe. */
  subscribe: (listener: (event: PortalLiveEvent) => void) => () => void;
  /** Bring one approval request to the front of the dialog (an item's "Review request", an action that answered `{ approvalId }`). */
  requestApproval: (id: string) => void;
  /** The approval asked for by `requestApproval`, until the dialog takes it. */
  requestedApproval: { id: string; at: number } | null;
};

const PortalLiveContext = createContext<PortalLive | null>(null);

const MIN_RETRY = 1000;
const MAX_RETRY = 30_000;

/**
 * The orchestrator's live state for the whole app: `GET /api/portal/stream` opens with `status`,
 * `items`, `threads`, `approvals`, and `intents`, then pushes changes. It lives above every page so
 * an approval request reaches the user wherever they are, and holding it open is what the server
 * counts as presence. Views that show other data (jobs, activity, memory, world) subscribe and
 * refetch on their event. The browser reconnects a dropped `EventSource` on its own; a refused one
 * (the server answered with an error) is retried here with backoff.
 */
export function PortalLiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [approvals, setApprovalsState] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [requestedApproval, setRequestedApproval] = useState<PortalLive["requestedApproval"]>(null);
  const listeners = useRef(new Set<(event: PortalLiveEvent) => void>());
  const notify = useCallback((event: PortalLiveEvent) => {
    for (const listener of [...listeners.current]) listener(event);
  }, []);

  // The header should not wait for the stream, and a refused stream cannot say why (EventSource
  // hides the response), so prime `status` once over REST. Everything else comes from the stream
  // alone: it opens with all of it, and a slower REST answer must not overwrite what it delivered.
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
        // A reopened stream missed whatever fell into the gap; views refetch what they show.
        if (opens++ > 0) notify({ type: "reconnected" });
      };
      es.onmessage = (m) => {
        let event: OrchestratorEvent;
        try {
          event = JSON.parse(m.data) as OrchestratorEvent;
        } catch {
          return;
        }
        switch (event.type) {
          case "status":
            setStatus(event.status);
            setError(null);
            break;
          case "items":
            setItems(event.items);
            break;
          case "threads":
            setThreads(event.threads);
            break;
          case "intents":
            setIntents(event.intents);
            break;
          case "approvals":
            setApprovalsState(event.approvals);
            break;
        }
        notify(event);
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
  }, [notify]);

  const putItem = useCallback((item: Item) => {
    setItems((prev) =>
      prev.some((i) => i.id === item.id)
        ? prev.map((i) => (i.id === item.id ? item : i))
        : [...prev, item],
    );
  }, []);
  const putIntent = useCallback((intent: Intent) => {
    setIntents((prev) =>
      intent.status === "active"
        ? prev.some((row) => row.id === intent.id)
          ? prev.map((row) => (row.id === intent.id ? intent : row))
          : [...prev, intent]
        : prev.filter((row) => row.id !== intent.id),
    );
  }, []);
  const subscribe = useCallback((listener: (event: PortalLiveEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const requestApproval = useCallback((id: string) => setRequestedApproval({ id, at: Date.now() }), []);
  const setApprovals = useCallback((update: (current: Approval[]) => Approval[]) => setApprovalsState(update), []);

  const value = useMemo<PortalLive>(
    () => ({
      status,
      items,
      threads,
      intents,
      approvals,
      error,
      putItem,
      putIntent,
      setApprovals,
      subscribe,
      requestApproval,
      requestedApproval,
    }),
    [status, items, threads, intents, approvals, error, putItem, putIntent, setApprovals, subscribe, requestApproval, requestedApproval],
  );
  return <PortalLiveContext.Provider value={value}>{children}</PortalLiveContext.Provider>;
}

export function usePortalLive(): PortalLive {
  const live = useContext(PortalLiveContext);
  if (!live) throw new Error("usePortalLive needs a PortalLiveProvider above it.");
  return live;
}

/** Calls `handler` for every live event; the latest handler is used without resubscribing. */
export function usePortalEvents(handler: (event: PortalLiveEvent) => void) {
  const { subscribe } = usePortalLive();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}

/** A clock for relative times, ticking every `ms` while `enabled`. */
export function useNow(ms = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    // Catch up at once when (re)enabled: the last reading may be long stale.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ms, enabled]);
  return now;
}
