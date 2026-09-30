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
import { writeDraft } from "@/lib/drafts";
import { forgetPromptHistory, sessionHistoryKey } from "@/lib/prompt-history";
import { PAGE_TURNS, createHistoryCache, type HistoryCache } from "@/lib/history-cache";
import type {
  AgentInfo,
  EventPage,
  SessionListEvent,
  SessionSummary,
} from "@/lib/types";
import { usePortalEvents } from "./portal/PortalLive";

// TODO(step 5): import from @portal/contracts
/** A session the user or Portal chose to keep an eye on (`GET /api/portal/tracked`). */
export type TrackedSession = {
  sessionId: string;
  trackedAt: number;
  trackedBy: "user" | "portal";
};
// TODO(step 5): import from @portal/contracts
/** The portal stream's full tracked set, sent on connect and after every change. */
type TrackedSessionsEvent = { type: "tracked"; sessions: TrackedSession[] };

export type Sessions = {
  /** The agent registry (`GET /api/agents`). */
  agents: AgentInfo[];
  /** The registry's default agent; "" until loaded. */
  defaultAgentId: string;
  /** Every session's list entry, kept current by the list stream. */
  sessions: SessionSummary[];
  /** The tracked set, as the portal stream pushes it; empty until known. */
  tracked: TrackedSession[];
  /** True until the first agents and sessions load settles. */
  loading: boolean;
  /** Why that load failed; the list stream stays closed while it is set. */
  loadError: string | null;
  /** Patch one session's list entry (a viewer's stream `meta`, a config change). */
  updateSession: (id: string, patch: Partial<SessionSummary>) => void;
  /** Put a session at the top of the list, replacing an existing entry (one just created). */
  putSession: (session: SessionSummary) => void;
  /** Drop a session from the list (it was deleted); caches and drafts are the caller's business. */
  removeSession: (id: string) => void;
  /** Refetch the whole list; resolves with it. */
  refetchSessions: (signal?: AbortSignal) => Promise<SessionSummary[]>;
  /** Reduced transcripts of visited (and hovered) sessions, shared by every session view. */
  historyCache: HistoryCache;
  /** `PUT /api/portal/tracked/:id`; rejects with the server's message. */
  track: (id: string) => Promise<void>;
  /** `DELETE /api/portal/tracked/:id`; rejects with the server's message. */
  untrack: (id: string) => Promise<void>;
};

const SessionsContext = createContext<Sessions | null>(null);

/** The latest transcript page for the history cache; null when the session is gone. */
async function fetchHistoryPage(id: string): Promise<EventPage | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/events?turns=${PAGE_TURNS}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as EventPage;
}

const trackedUrl = (id: string) => `/api/portal/tracked/${encodeURIComponent(id)}`;

async function failure(r: Response, fallback: string): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error ?? fallback);
}

/**
 * The session list for the whole app: the agents registry, every session's list entry (loaded once,
 * then followed over `/api/sessions/stream`), the history cache session views share, and the tracked
 * set (loaded once, then followed over the portal stream's `tracked` event). Needs a
 * `PortalLiveProvider` above it.
 */
export function SessionsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** The current list, for stream handlers that must not close over a stale render. */
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const [tracked, setTracked] = useState<TrackedSession[]>([]);
  /** Set once the stream has delivered the set: a slower REST read must not overwrite it then. Local edits do not set it. */
  const trackedFromStreamRef = useRef(false);
  /** Sessions untracked here before any full set arrived; the REST read skips them. */
  const untrackedEarly = useRef(new Set<string>());
  const [historyCache] = useState(() => createHistoryCache(fetchHistoryPage));

  const refetchSessions = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch("/api/sessions", { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { sessions: fetched } = (await r.json()) as {
      sessions: SessionSummary[];
    };
    if (!signal?.aborted) setSessions(fetched);
    return fetched;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [agentsResponse, sessionsResponse] = await Promise.all([
          fetch("/api/agents", { signal: controller.signal }),
          fetch("/api/sessions", { signal: controller.signal }),
        ]);
        if (!agentsResponse.ok || !sessionsResponse.ok) {
          throw new Error(
            "Could not load agents and sessions. Reload the page to retry.",
          );
        }
        const [registry, saved] = await Promise.all([
          agentsResponse.json() as Promise<{
            agents: AgentInfo[];
            defaultAgentId: string;
          }>,
          sessionsResponse.json() as Promise<{ sessions: SessionSummary[] }>,
        ]);
        if (controller.signal.aborted) return;
        setAgents(registry.agents);
        setDefaultAgentId(registry.defaultAgentId);
        setSessions(saved.sessions);
      } catch {
        if (!controller.signal.aborted) {
          setLoadError(
            "Could not load agents and sessions. Check the server and reload the page to retry.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  // Follow the list live once it has loaded: other sessions' busy, permission, connection, title,
  // and activity changes, plus sessions created or deleted from another browser. The open session's
  // own stream still patches its git state and agent state.
  useEffect(() => {
    if (loading || loadError) return;
    const controller = new AbortController();
    const es = new EventSource("/api/sessions/stream");
    es.onmessage = (m) => {
      const event = JSON.parse(m.data) as SessionListEvent;
      switch (event.type) {
        case "snapshot": {
          const byId = new Map(event.sessions.map((s) => [s.id, s]));
          // The snapshot decides what exists; entries it lacks were deleted while we were not listening.
          setSessions((prev) =>
            prev
              .filter((s) => byId.has(s.id))
              .map((s) => ({ ...s, ...byId.get(s.id) })),
          );
          // A session created while we were not listening needs its full entry (folder, branch, project).
          const known = new Set(sessionsRef.current.map((s) => s.id));
          if (event.sessions.some((s) => !known.has(s.id)))
            refetchSessions(controller.signal).catch(() => {});
          return;
        }
        case "created":
          setSessions((prev) =>
            prev.some((s) => s.id === event.session.id)
              ? prev
              : [event.session, ...prev],
          );
          return;
        case "updated":
          setSessions((prev) =>
            prev.map((s) => (s.id === event.id ? { ...s, ...event.patch } : s)),
          );
          return;
        case "deleted":
          setSessions((prev) => prev.filter((s) => s.id !== event.id));
          historyCache.delete(event.id);
          writeDraft(event.id, "");
          forgetPromptHistory(sessionHistoryKey(event.id));
          return;
      }
    };
    return () => {
      controller.abort();
      es.close();
    };
  }, [loading, loadError, refetchSessions, historyCache]);

  // The tracked set: one REST read so it does not wait for the stream, which then keeps it current.
  // A stream delivery that got here first is the fresher copy. A track/untrack answered before the
  // read is applied on top of it. A server without the route yet answers 404; the set then stays
  // empty until the stream says otherwise.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/portal/tracked", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) return;
        const { sessions: fetched } = (await r.json()) as { sessions: TrackedSession[] };
        if (controller.signal.aborted || trackedFromStreamRef.current) return;
        setTracked((prev) => [
          ...fetched.filter(
            (t) =>
              !prev.some((p) => p.sessionId === t.sessionId) &&
              !untrackedEarly.current.has(t.sessionId),
          ),
          ...prev,
        ]);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  usePortalEvents((event) => {
    // TODO(step 5): drop the cast once `OrchestratorEvent` from @portal/contracts is used here.
    const e = event as typeof event | TrackedSessionsEvent;
    if (e.type !== "tracked") return;
    trackedFromStreamRef.current = true;
    setTracked((e as TrackedSessionsEvent).sessions);
  });

  const updateSession = useCallback(
    (id: string, patch: Partial<SessionSummary>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [],
  );
  const putSession = useCallback((session: SessionSummary) => {
    setSessions((prev) => [
      session,
      ...prev.filter((item) => item.id !== session.id),
    ]);
  }, []);
  const removeSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const track = useCallback(async (id: string) => {
    const r = await fetch(trackedUrl(id), { method: "PUT" });
    if (!r.ok) throw await failure(r, "Could not track the session. Try again.");
    const { session } = (await r.json()) as { session: TrackedSession };
    // The stream confirms with the full set; apply the answer now so the toggle does not lag.
    untrackedEarly.current.delete(id);
    setTracked((prev) => [
      ...prev.filter((t) => t.sessionId !== session.sessionId),
      session,
    ]);
  }, []);
  const untrack = useCallback(async (id: string) => {
    const r = await fetch(trackedUrl(id), { method: "DELETE" });
    if (!r.ok && r.status !== 404)
      throw await failure(r, "Could not untrack the session. Try again.");
    // Until the set is known, remember the removal so the REST read does not bring the row back.
    if (!trackedFromStreamRef.current) untrackedEarly.current.add(id);
    setTracked((prev) => prev.filter((t) => t.sessionId !== id));
  }, []);

  const value = useMemo<Sessions>(
    () => ({
      agents,
      defaultAgentId,
      sessions,
      tracked,
      loading,
      loadError,
      updateSession,
      putSession,
      removeSession,
      refetchSessions,
      historyCache,
      track,
      untrack,
    }),
    [agents, defaultAgentId, sessions, tracked, loading, loadError, updateSession, putSession, removeSession, refetchSessions, historyCache, track, untrack],
  );
  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

export function useSessions(): Sessions {
  const value = useContext(SessionsContext);
  if (!value) throw new Error("useSessions needs a SessionsProvider above it.");
  return value;
}
