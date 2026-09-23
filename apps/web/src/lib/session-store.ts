/**
 * Persistence boundary for chat sessions. The ACP runtime owns live sessions in memory and writes
 * through this interface; nothing above it knows whether the backend is a directory of files or a
 * cloud store. Sequence numbers are assigned by the runtime (the log's only writer) and must be
 * dense from 0, so a store can serve "the page before seq N" without an index.
 */
import type { SessionState, StoredEvent } from "./types.ts";

/** The persisted half of a session: what Portal needs to list it and reattach its agent. */
export type SessionRecord = {
  id: string;
  agentId: string;
  agentName: string;
  cwd: string;
  /** Portal metadata only; never sent over ACP. */
  projectId: string;
  createdAt: number;
  lastActiveAt: number;
  title: string | null;
  /** The agent's own session ID (ACP `sessionId`), passed back to `session/resume`. */
  upstreamId: string;
  /** Last known agent-side state, shown until the agent is reattached. */
  state: SessionState;
};

export type TailQuery = {
  /** Return events with `seq < beforeSeq`; omit for the end of the log. */
  beforeSeq?: number;
  /** Maximum events to return. */
  limit: number;
};

export type TailResult = {
  /** Oldest first. */
  events: StoredEvent[];
  /** True when the log has events before `events[0]` (or before `beforeSeq` when empty). */
  hasMore: boolean;
};

export interface SessionStore {
  /** Resolves once existing sessions can be listed. */
  ready: Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  /** Create or replace a session's metadata. */
  putSession(record: SessionRecord): Promise<void>;
  /** Remove the metadata and the whole event log. No-op for unknown sessions. */
  deleteSession(id: string): Promise<void>;
  /**
   * Append one event. `event.seq` must be at least the current count; a gap is tolerated so a
   * write that failed does not block every later one. Rejects for a deleted or disposed log.
   */
  appendEvent(id: string, event: StoredEvent): Promise<void>;
  /** Read backwards from `beforeSeq` (default: the end). `hasMore` is false once nothing readable remains. */
  readTail(id: string, query: TailQuery): Promise<TailResult>;
  /** One past the highest stored seq (the seq the next event should get). */
  eventCount(id: string): Promise<number>;
  /** Release file handles or connections. */
  dispose(): Promise<void>;
}

function isSessionState(value: unknown): value is SessionState {
  const s = value as Record<string, unknown> | null;
  return !!s && typeof s === "object" && (s.modes === null || typeof s.modes === "object")
    && Array.isArray(s.configOptions) && Array.isArray(s.commands);
}

/** Session ids name files, so only plain identifiers are accepted from storage. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Shape check for records read back from storage. */
export function isSessionRecord(value: unknown): value is SessionRecord {
  const r = value as Record<string, unknown> | null;
  return !!r && typeof r === "object" && typeof r.id === "string" && SAFE_ID.test(r.id) && typeof r.agentId === "string"
    && typeof r.agentName === "string" && typeof r.cwd === "string" && typeof r.projectId === "string"
    && typeof r.createdAt === "number" && typeof r.lastActiveAt === "number"
    && (r.title === null || typeof r.title === "string") && typeof r.upstreamId === "string"
    && isSessionState(r.state);
}

/** Shape check for events read back from storage. */
export function isStoredEvent(value: unknown): value is StoredEvent {
  const e = value as Record<string, unknown> | null;
  return !!e && typeof e === "object" && typeof e.type === "string"
    && typeof e.seq === "number" && Number.isSafeInteger(e.seq) && e.seq >= 0 && typeof e.ts === "number";
}

/** Reference implementation; also what tests and disposable runtimes use. */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, { record: SessionRecord; events: StoredEvent[] }>();
  const entry = (id: string) => {
    const found = sessions.get(id);
    if (!found) throw new Error(`No such session: ${id}`);
    return found;
  };
  return {
    ready: Promise.resolve(),
    async listSessions() {
      return [...sessions.values()].map(({ record }) => record);
    },
    async getSession(id) {
      return sessions.get(id)?.record;
    },
    async putSession(record) {
      const existing = sessions.get(record.id);
      if (existing) existing.record = record;
      else sessions.set(record.id, { record, events: [] });
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async appendEvent(id, event) {
      const { events } = entry(id);
      const next = events.length ? events[events.length - 1].seq + 1 : 0;
      if (event.seq < next) throw new Error(`Out-of-order append: log already holds seq ${event.seq} (next is ${next})`);
      events.push(event);
    },
    async readTail(id, { beforeSeq, limit }) {
      const { events } = sessions.get(id) ?? { events: [] };
      if (limit <= 0) return { events: [], hasMore: events.length > 0 && (beforeSeq === undefined || beforeSeq > events[0].seq) };
      // Events are stored in seq order; `end` is the index of the first event at or past `beforeSeq`.
      let end = events.length;
      if (beforeSeq !== undefined) {
        end = 0;
        while (end < events.length && events[end].seq < beforeSeq) end++;
      }
      const start = Math.max(0, end - limit);
      return { events: events.slice(start, end), hasMore: start > 0 };
    },
    async eventCount(id) {
      const events = sessions.get(id)?.events;
      return events?.length ? events[events.length - 1].seq + 1 : 0;
    },
    async dispose() {},
  };
}
