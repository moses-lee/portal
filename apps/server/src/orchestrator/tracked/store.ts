/**
 * Persistence for tracked sessions: the explicit set of sessions the user and Portal keep an eye on.
 * The in-memory store backs tests and disposable runtimes; `pg-store.ts` is the live one
 * (`tracked_sessions`, whose rows go when their session is deleted), and one behaviour test runs
 * against both.
 *
 * Tracking is idempotent: tracking a tracked session keeps the first row (who tracked it and when).
 */
import type { TrackedSession } from "@portal/contracts/orchestrator";

export type TrackedBy = TrackedSession["trackedBy"];

export interface TrackedStore {
  /** Oldest first (the order they were tracked). */
  list(): Promise<TrackedSession[]>;
  isTracked(sessionId: string): Promise<boolean>;
  /**
   * Track the session, or answer the row it already has (`created: false`). Null when no such
   * session exists.
   */
  track(sessionId: string, trackedBy: TrackedBy, at: number): Promise<{ session: TrackedSession; created: boolean } | null>;
  /** Whether there was a row to remove. */
  untrack(sessionId: string): Promise<boolean>;
}

/** No session id holds U+0000 (Postgres cannot store it); such an id is simply unknown. */
export const hasNul = (id: string) => id.includes("\u0000");

export const isTrackedBy = (value: unknown): value is TrackedBy => value === "user" || value === "portal";

/** Oldest first, ties by id, as the Postgres store orders them. */
export function byTrackedAt(a: TrackedSession, b: TrackedSession): number {
  return a.trackedAt - b.trackedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

/** `sessionExists` stands in for the foreign key; every id exists unless it says otherwise. */
export function createMemoryTrackedStore({ sessionExists = () => true }: { sessionExists?: (id: string) => boolean } = {}): TrackedStore {
  const rows = new Map<string, TrackedSession>();
  return {
    async list() {
      return [...rows.values()].sort(byTrackedAt);
    },
    async isTracked(sessionId) {
      return rows.has(sessionId);
    },
    async track(sessionId, trackedBy, at) {
      const existing = rows.get(sessionId);
      if (existing) return { session: existing, created: false };
      if (hasNul(sessionId) || !sessionExists(sessionId)) return null;
      const session = { sessionId, trackedAt: at, trackedBy };
      rows.set(sessionId, session);
      return { session, created: true };
    },
    async untrack(sessionId) {
      return rows.delete(sessionId);
    },
  };
}
