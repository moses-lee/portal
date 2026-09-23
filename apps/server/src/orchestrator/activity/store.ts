/**
 * Persistence for the activity log: append and page, nothing else. The in-memory store backs tests;
 * `pg-store.ts` is the live one. Both answer newest first.
 */
import type { ActivityEntry } from "@portal/contracts/activity";

export type ActivityFilter = {
  /** Entries with a smaller id only (the next page). */
  before?: number;
  /** At most this many (default 100, at most 500). */
  limit?: number;
  /** Kind prefix: "memory." matches every memory entry; an exact kind matches itself. */
  kind?: string;
  threadId?: string;
  runId?: string;
};

export const DEFAULT_ACTIVITY_LIMIT = 100;
export const MAX_ACTIVITY_LIMIT = 500;

export interface ActivityStore {
  append(entry: Omit<ActivityEntry, "id">): Promise<ActivityEntry>;
  list(filter?: ActivityFilter): Promise<ActivityEntry[]>;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(limit)));
}

export function matchesKind(kind: string, prefix: string | undefined): boolean {
  return !prefix || kind === prefix || (prefix.endsWith(".") && kind.startsWith(prefix));
}

export function createMemoryActivityStore(): ActivityStore {
  const entries: ActivityEntry[] = [];
  return {
    async append(entry) {
      const stored = { ...entry, id: entries.length + 1 };
      entries.push(stored);
      return stored;
    },
    async list(filter = {}) {
      const limit = clampLimit(filter.limit);
      const found: ActivityEntry[] = [];
      for (let i = entries.length - 1; i >= 0 && found.length < limit; i--) {
        const entry = entries[i];
        if (filter.before !== undefined && entry.id >= filter.before) continue;
        if (!matchesKind(entry.kind, filter.kind)) continue;
        if (filter.threadId && entry.refs.threadId !== filter.threadId) continue;
        if (filter.runId && entry.refs.runId !== filter.runId) continue;
        found.push(entry);
      }
      return found;
    },
  };
}
