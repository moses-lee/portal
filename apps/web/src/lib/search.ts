/**
 * Global search (docs/SEARCH.md), the pure half: local matching and ranking of
 * sessions and projects, merging the server's PR hits, highlight ranges, the recents list, and
 * the keyboard shortcut. The dialog and the `useSearch` hook hold the React state around these.
 */
import type { SearchPullHit } from "@portal/contracts/search";
import { sessionDisplayTitle } from "./session-title.ts";
import type { ProjectSummary, SessionSummary } from "./types.ts";

/** Below this many characters the server is not asked; local matching still runs from one. */
export const SERVER_MIN_CHARS = 2;
export const SESSION_CAP = 8;
export const PROJECT_CAP = 4;
export const MESSAGE_CAP = 8;
export const RECENTS_CAP = 8;
export const RECENT_SESSIONS_CAP = 6;
/** The per-device preference key the recents list lives under. */
export const RECENTS_KEY = "search.recents";

/** A local match: how well, so the best come first. */
export type Ranked<T> = { item: T; score: number };

/** True when `lower` occurs in `field` at the start of a word (the start, or after a non-alphanumeric). */
function wordStartMatch(field: string, lower: string): boolean {
  let at = field.indexOf(lower);
  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(field[at - 1])) return true;
    at = field.indexOf(lower, at + 1);
  }
  return false;
}

/**
 * How well `q` matches a row whose main text is `primary` and whose other searchable texts are
 * `others`: 3 for a prefix of the primary text, 2 for a word start anywhere, 1 for a substring
 * anywhere, 0 for no match. Case-insensitive; an empty query matches nothing.
 */
export function rankScore(primary: string, others: readonly (string | null | undefined)[], q: string): number {
  const lower = q.trim().toLowerCase();
  if (!lower) return 0;
  const title = primary.toLowerCase();
  if (title.startsWith(lower)) return 3;
  const fields = [title, ...others.flatMap((field) => (field ? [field.toLowerCase()] : []))];
  if (fields.some((field) => wordStartMatch(field, lower))) return 2;
  return fields.some((field) => field.includes(lower)) ? 1 : 0;
}

/** Best score first; ties by the newer `at` (stable, so equal rows keep their input order). */
function byScoreThen<T>(at: (item: T) => number) {
  return (a: Ranked<T>, b: Ranked<T>) => b.score - a.score || at(b.item) - at(a.item);
}

/** The pull request a session row was found through, shown as a second subtitle. */
export type RowPull = { number: number; title?: string };
export type SessionMatch = Ranked<SessionSummary> & { pull?: RowPull };

/**
 * Sessions matching `q` over their display title, project name, branch, agent, and folder, best
 * first (then most recently active), uncapped: PR hits merge in before the cap.
 */
export function matchSessions(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
  q: string,
): SessionMatch[] {
  if (!q.trim()) return [];
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const rows: SessionMatch[] = [];
  for (const session of sessions) {
    const score = rankScore(
      sessionDisplayTitle(session.title),
      [session.project?.name ?? projectNames.get(session.projectId), session.git?.branch, session.agentName, session.displayCwd],
      q,
    );
    if (score > 0) rows.push({ item: session, score });
  }
  return rows.sort(byScoreThen((session) => session.lastActiveAt));
}

/** Projects matching `q` over their name, display path, and worktree branch, best first; ties keep the input order. */
export function matchProjects(projects: readonly ProjectSummary[], q: string, cap = PROJECT_CAP): Ranked<ProjectSummary>[] {
  if (!q.trim()) return [];
  const rows: Ranked<ProjectSummary>[] = [];
  for (const project of projects) {
    const score = rankScore(project.name, [project.displayPath, project.worktree?.branch], q);
    if (score > 0) rows.push({ item: project, score });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, cap);
}

/**
 * The server's PR hits folded into the local session matches: a session already matched gains the
 * PR subtitle and ranks at least as a title prefix, one that was not joins at that rank (the server tied it to the PR the
 * query names), and a hit for a session this client does not hold is dropped. Then capped.
 */
export function mergePullHits(
  local: readonly SessionMatch[],
  pulls: readonly SearchPullHit[],
  sessions: readonly SessionSummary[],
  cap = SESSION_CAP,
): SessionMatch[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const pullOf = new Map<string, RowPull>();
  for (const hit of pulls) {
    if (pullOf.has(hit.sessionId) || !byId.has(hit.sessionId)) continue;
    pullOf.set(hit.sessionId, hit.pull.title ? { number: hit.pull.number, title: hit.pull.title } : { number: hit.pull.number });
  }
  const rows: SessionMatch[] = local.map((row) => {
    const pull = pullOf.get(row.item.id);
    if (!pull) return row;
    pullOf.delete(row.item.id);
    // Tied to the PR the query names: at least as strong as a PR-only hit.
    return { ...row, score: Math.max(row.score, 3), pull };
  });
  for (const [id, pull] of pullOf) rows.push({ item: byId.get(id)!, score: 3, pull });
  return rows.sort(byScoreThen((session) => session.lastActiveAt)).slice(0, cap);
}

/** "PR #12 · Fix the thing", or "PR #12" when the server had no title. */
export function pullLabel(pull: RowPull): string {
  return pull.title ? `PR #${pull.number} · ${pull.title}` : `PR #${pull.number}`;
}

/** Every case-insensitive occurrence of `q` in `text` as `[start, end)` pairs, left to right, not overlapping. */
export function highlightRanges(text: string, q: string): [number, number][] {
  const lower = q.trim().toLowerCase();
  if (!lower) return [];
  const haystack = text.toLowerCase();
  // Lower-casing can change a string's length (rare in practice); then offsets would not line up.
  if (haystack.length !== text.length) return [];
  const ranges: [number, number][] = [];
  let at = haystack.indexOf(lower);
  while (at !== -1) {
    ranges.push([at, at + lower.length]);
    at = haystack.indexOf(lower, at + lower.length);
  }
  return ranges;
}

/** The newest `cap` sessions by `lastActiveAt` (the sidebar's recent rooms, search's Recent sessions), without sorting the whole list. */
export function newestSessions(sessions: readonly SessionSummary[], cap = RECENT_SESSIONS_CAP): SessionSummary[] {
  const recent: SessionSummary[] = [];
  for (const session of sessions) {
    const index = recent.findIndex((row) => session.lastActiveAt > row.lastActiveAt);
    if (index === -1) {
      if (recent.length < cap) recent.push(session);
    } else {
      recent.splice(index, 0, session);
      if (recent.length > cap) recent.pop();
    }
  }
  return recent;
}

/** Something opened from search, remembered per device. */
export type RecentItem = { kind: "session" | "project"; id: string; at: number };

/** The stored recents, keeping only well-formed entries; anything unreadable is an empty list. */
export function parseRecents(raw: string | null): RecentItem[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is RecentItem =>
        !!entry &&
        typeof entry === "object" &&
        (entry.kind === "session" || entry.kind === "project") &&
        typeof entry.id === "string" &&
        typeof entry.at === "number",
    );
  } catch {
    return [];
  }
}

/** `list` with `item` moved (or added) to the front, newest first, at most `cap` long. */
export function recentsAfterOpen(list: readonly RecentItem[], item: RecentItem, cap = RECENTS_CAP): RecentItem[] {
  return [item, ...list.filter((entry) => entry.kind !== item.kind || entry.id !== item.id)].slice(0, cap);
}

export type ResolvedRecent =
  | { kind: "session"; session: SessionSummary }
  | { kind: "project"; project: ProjectSummary };

/** `list` without the entries whose session or project is gone. */
export function pruneRecents(
  list: readonly RecentItem[],
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
): RecentItem[] {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const projectIds = new Set(projects.map((project) => project.id));
  return list.filter((entry) => (entry.kind === "session" ? sessionIds : projectIds).has(entry.id));
}

/** The recents that still exist, in order; a deleted session or removed project drops out. */
export function resolveRecents(
  list: readonly RecentItem[],
  sessions: readonly SessionSummary[],
  projects: readonly ProjectSummary[],
): ResolvedRecent[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return list.flatMap((entry): ResolvedRecent[] => {
    if (entry.kind === "session") {
      const session = sessionById.get(entry.id);
      return session ? [{ kind: "session", session }] : [];
    }
    const project = projectById.get(entry.id);
    return project ? [{ kind: "project", project }] : [];
  });
}

/** True on Apple platforms, where the shortcut is ⌘K rather than Ctrl+K. */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * ⌘K on a Mac, Ctrl+K elsewhere, with no other modifier. The physical K key counts too, so a
 * non-Latin layout (where `key` is another letter) still opens search.
 */
export function isSearchShortcut(
  event: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platformIsMac: boolean,
): boolean {
  if ((event.key.toLowerCase() !== "k" && event.code !== "KeyK") || event.altKey || event.shiftKey) return false;
  return platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
