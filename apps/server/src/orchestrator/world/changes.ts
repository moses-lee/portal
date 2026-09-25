/**
 * The change log: what each full world refresh (the hourly one, a chat turn's, a manual one) found
 * changed since the refresh before it, kept for `CHANGE_LOG_KEEP_MS` for chat turns to read (see
 * `recent.ts` and the get_changes tool). Nothing here calls a model or touches items.
 *
 * One row per subject (a PR, a review request, a session, a worktree, a missing folder) holds that
 * subject's latest state. A new change to a subject replaces its row with the new state and a new
 * detection time (checks failing, then conflicts too, is one row saying both); a condition that no
 * longer holds takes its row away (a failure that went green again before a turn mentioned it is
 * never offered). So failing → passing → failing on one PR ends as one row, the latest failure,
 * and failing → passing leaves nothing. Terminal events (merged, closed) hold until pruned.
 *
 * Conditions come from `diffSnapshots` (without items: the log is about the world, not the Needs-you
 * strip), except review requests: the diff reports those per repo whenever the set changes, the log
 * one row per newly requested PR, so a request is news once and a shrinking list is not.
 */
import type { WorldState } from "@portal/contracts/world";
import { stripNul } from "../../db/sanitize.ts";
import { authoredReasons, diffSnapshots, dirtyAndIdle, mergedAndIdle } from "../digest.ts";
import { attentionReasons } from "../github-attention.ts";
import type { ItemKind, PullAttention, PullRef, TickSnapshot } from "../types.ts";

/** Rows older than this are pruned after each refresh. */
export const CHANGE_LOG_KEEP_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_CHANGE_LIMIT = 50;
export const MAX_CHANGE_LIMIT = 200;

export type ChangeRefs = { pull?: PullRef; sessionId?: string; projectId?: string };

export type WorldChange = {
  id: number;
  /** "pr:owner/name#7", "review:owner/name#7", "session:<id>", "worktree:<projectId>", "folder:<projectId>". */
  subject: string;
  /** When the refresh detected this state. */
  at: number;
  kind: ItemKind;
  /** The fingerprint an item for the change carries, so a dismissal of that item silences it. */
  fingerprint: string;
  summary: string;
  detail: string | null;
  refs: ChangeRefs;
  /** The user's own subject: a PR they authored, a session. */
  mine: boolean;
  /** When the user last acted on the subject (opened or pushed the PR; started or prompted the session). */
  activeAt: number | null;
};

/** A change as a refresh finds it, before it is stored. */
export type ChangeEntry = Omit<WorldChange, "id" | "at">;

export interface ChangeStore {
  /** Insert each entry, or replace the row of its subject, detected at `at`. */
  record(entries: ChangeEntry[], at: number): Promise<void>;
  /** Drop the rows of these subjects; resolves with how many went. */
  remove(subjects: string[]): Promise<number>;
  /** Newest first; `since` (inclusive) bounds the detection time. */
  list(filter?: { since?: number; limit?: number }): Promise<WorldChange[]>;
  /** Every row's subject and kind, for the collapse after a refresh. */
  subjects(): Promise<Pick<WorldChange, "subject" | "kind">[]>;
  /** Drop rows detected before `before`; resolves with how many went. */
  prune(before: number): Promise<number>;
}

export function clampChangeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_CHANGE_LIMIT;
  return Math.max(1, Math.min(MAX_CHANGE_LIMIT, Math.floor(limit)));
}

const newestFirst = (a: WorldChange, b: WorldChange) => b.at - a.at || b.id - a.id;

export function createMemoryChangeStore(): ChangeStore {
  const rows = new Map<string, WorldChange>();
  let nextId = 1;
  return {
    async record(entries, at) {
      // A cleaned deep copy, as a database round trip would give.
      for (const entry of entries) rows.set(entry.subject, { ...stripNul(structuredClone(entry)), id: nextId++, at });
    },
    async remove(subjects) {
      return subjects.filter((subject) => rows.delete(subject)).length;
    },
    async list(filter = {}) {
      return [...rows.values()].filter((row) => filter.since === undefined || row.at >= filter.since).sort(newestFirst)
        .slice(0, clampChangeLimit(filter.limit)).map((row) => structuredClone(row));
    },
    async subjects() {
      return [...rows.values()].map(({ subject, kind }) => ({ subject, kind }));
    },
    async prune(before) {
      let removed = 0;
      for (const [subject, row] of rows) {
        if (row.at < before && rows.delete(subject)) removed++;
      }
      return removed;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// From two snapshots to entries (pure)
// ---------------------------------------------------------------------------------------------

/** "kind:key" split at the first colon. */
function splitFingerprint(fingerprint: string): { kind: string; key: string } {
  const colon = fingerprint.indexOf(":");
  return { kind: fingerprint.slice(0, colon), key: fingerprint.slice(colon + 1) };
}

const latest = (...times: (number | null | undefined)[]) => {
  const known = times.filter((at): at is number => typeof at === "number" && Number.isFinite(at));
  return known.length ? Math.max(...known) : null;
};

const pullRefs = (pull: PullAttention): ChangeRefs => {
  const projectId = pull.worktreeProjectId ?? pull.localProjectId;
  return { pull: { repo: pull.repo, number: pull.number, url: pull.url }, ...(projectId ? { projectId } : {}) };
};

/** When the user last pushed to or opened the PR. */
export const pullActiveAt = (pull: PullAttention) => latest(pull.createdAt, pull.pushedAt);

/**
 * What changed between `prev` and the world's snapshot, as change-log entries. Pure. Nothing on the
 * first snapshot (`prev` null): everything would be "new", and none of it is news.
 */
export function changeEntries(prev: TickSnapshot | null, world: Pick<WorldState, "snapshot" | "sessions" | "projects">): ChangeEntry[] {
  if (!prev) return [];
  const next = world.snapshot;
  const entries: ChangeEntry[] = [];
  const projectName = (id: string) => world.projects.find((project) => project.id === id)?.name ?? id;
  for (const change of diffSnapshots(prev, next, [])) {
    const { kind: prefix, key } = splitFingerprint(change.fingerprint);
    const base = { kind: change.kind, fingerprint: change.fingerprint, summary: change.summary, detail: change.detail ?? null };
    switch (prefix) {
      case "session_finished":
      case "session_stopped":
      case "session_waiting":
      case "session_offline": {
        const session = next.sessions[key];
        const createdAt = world.sessions.find((entry) => entry.id === key)?.createdAt;
        entries.push({
          ...base, subject: `session:${key}`, refs: { sessionId: key, ...(session?.projectId ? { projectId: session.projectId } : {}) },
          mine: true, activeAt: latest(createdAt, session?.lastActiveAt),
        });
        break;
      }
      case "pr":
      case "pr_merged":
      case "pr_closed": {
        const pull = next.pulls[key] ?? prev.pulls[key];
        if (!pull) break;
        entries.push({ ...base, subject: `pr:${key}`, refs: pullRefs(pull), mine: pull.roles.includes("author"), activeAt: pullActiveAt(pull) });
        break;
      }
      case "worktree_merged":
      case "worktree_dirty":
        entries.push({ ...base, subject: `worktree:${key}`, refs: { projectId: key }, mine: false, activeAt: null });
        break;
      case "folder_missing":
        entries.push({ ...base, summary: `The folder of project ${projectName(key)} is missing`, subject: `folder:${key}`, refs: { projectId: key }, mine: false, activeAt: null });
        break;
      default:
        // Per-repo review lists: replaced by the per-PR requests below.
        break;
    }
  }
  const requested = (pull: PullAttention | undefined) => !!pull && attentionReasons(pull).includes("pr_review_requested");
  for (const key of Object.keys(next.pulls).sort()) {
    const pull = next.pulls[key];
    if (!requested(pull) || requested(prev.pulls[key])) continue;
    entries.push({
      kind: "pr_review_requested", fingerprint: `pr_review_requested:${pull.repo}`, subject: `review:${key}`, detail: null,
      summary: `${pull.author || "Someone"} asked for your review on ${key} "${pull.title}"`, refs: pullRefs(pull), mine: false, activeAt: pullActiveAt(pull),
    });
  }
  return entries;
}

/** Whether the state a row records still holds in `snapshot`. Terminal events (merged, closed) always do. */
export function stillHolds(change: Pick<WorldChange, "subject" | "kind">, snapshot: TickSnapshot): boolean {
  const { kind: type, key } = splitFingerprint(change.subject);
  switch (type) {
    case "session": {
      const session = snapshot.sessions[key];
      if (!session) return false;
      if (change.kind === "session_waiting") return session.activity === "waiting";
      if (change.kind === "session_offline") return session.activity === "error";
      return session.activity !== "working";
    }
    case "pr": {
      if (change.kind === "pr_merged" || change.kind === "pr_closed") return true;
      const pull = snapshot.pulls[key];
      return !!pull && pull.state === "open" && authoredReasons(pull).length > 0;
    }
    case "review": {
      const pull = snapshot.pulls[key];
      return !!pull && attentionReasons(pull).includes("pr_review_requested");
    }
    case "worktree":
      return change.kind === "worktree_merged" ? mergedAndIdle(snapshot, key) : dirtyAndIdle(snapshot, key);
    case "folder":
      return snapshot.missingProjects.includes(key);
    default:
      return true;
  }
}

/**
 * The collapse rule, pure: every entry replaces its subject's row, and a stored row that got no
 * entry is dropped once its state no longer holds.
 */
export function settleChanges(stored: Pick<WorldChange, "subject" | "kind">[], entries: ChangeEntry[], snapshot: TickSnapshot): { record: ChangeEntry[]; remove: string[] } {
  // One entry per subject (the last), so a store can upsert them in one statement.
  const record = [...new Map(entries.map((entry) => [entry.subject, entry])).values()];
  const touched = new Set(record.map((entry) => entry.subject));
  const remove = stored.filter((row) => !touched.has(row.subject) && !stillHolds(row, snapshot)).map((row) => row.subject);
  return { record, remove: [...new Set(remove)] };
}

/**
 * Apply one refresh to the log: record what changed between `prev` and the world, drop what went
 * away, prune old rows. Answers how many entries were recorded.
 */
export async function recordChanges(store: ChangeStore, prev: TickSnapshot | null, world: WorldState): Promise<number> {
  const entries = changeEntries(prev, world);
  const { record, remove } = settleChanges(await store.subjects(), entries, world.snapshot);
  if (remove.length) await store.remove(remove);
  if (record.length) await store.record(record, world.at);
  await store.prune(world.at - CHANGE_LOG_KEEP_MS);
  return record.length;
}
