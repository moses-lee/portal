/**
 * The Activity view's logic: the kind filters (one per dotted prefix the server filters on),
 * merging live entries into a page, and the links an entry's refs turn into.
 */
import type { ActivityEntry, ActivityRefs } from "./types.ts";

export type ActivityFilter = { id: string; label: string; prefix: string | null };

/** Filter chips, in the order they read best; each prefix is what `GET /api/portal/activity?kind=` matches. */
export const activityFilters: readonly ActivityFilter[] = [
  { id: "all", label: "All", prefix: null },
  { id: "chat", label: "Chat", prefix: "chat." },
  { id: "tool", label: "Tools", prefix: "tool." },
  { id: "run", label: "Runs", prefix: "run." },
  { id: "job", label: "Jobs", prefix: "job." },
  { id: "intent", label: "Goals", prefix: "intent." },
  { id: "item", label: "Items", prefix: "item." },
  { id: "thread", label: "Threads", prefix: "thread." },
  { id: "memory", label: "Memory", prefix: "memory." },
  { id: "approval", label: "Approvals", prefix: "approval." },
  { id: "world", label: "World", prefix: "world." },
];

export function matchesPrefix(entry: Pick<ActivityEntry, "kind">, prefix: string | null): boolean {
  return prefix === null || entry.kind.startsWith(prefix);
}

/** `incoming` folded into `current`: one copy per id, newest first. Returns `current` itself when nothing changed. */
export function mergeActivity(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const known = new Set(current.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((a, b) => b.id - a.id);
}

/** "memory.approved" -> "Memory approved": the label beside a log line. */
export function describeKind(kind: string): string {
  const words = kind.replace(/[._]/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : kind;
}

export type ActivityLink =
  | { type: "thread"; id: string }
  | { type: "item"; id: string }
  | { type: "session"; id: string }
  | { type: "pull"; repo: string; number: number; url: string }
  | { type: "job"; id: string }
  | { type: "intent"; id: string }
  | { type: "run"; id: string }
  | { type: "approval"; id: string }
  | { type: "record"; id: string; entityId?: string }
  | { type: "entity"; id: string }
  | { type: "project"; id: string };

/** The links an entry offers, most useful first. A record link carries its entity so it can open in place. */
export function activityLinks(refs: ActivityRefs): ActivityLink[] {
  const links: ActivityLink[] = [];
  if (refs.threadId) links.push({ type: "thread", id: refs.threadId });
  if (refs.pull) links.push({ type: "pull", ...refs.pull });
  if (refs.sessionId) links.push({ type: "session", id: refs.sessionId });
  if (refs.itemId) links.push({ type: "item", id: refs.itemId });
  if (refs.approvalId) links.push({ type: "approval", id: refs.approvalId });
  if (refs.intentId) links.push({ type: "intent", id: refs.intentId });
  if (refs.jobId) links.push({ type: "job", id: refs.jobId });
  if (refs.recordId) links.push({ type: "record", id: refs.recordId, entityId: refs.entityId });
  else if (refs.entityId) links.push({ type: "entity", id: refs.entityId });
  if (refs.projectId && !refs.sessionId) links.push({ type: "project", id: refs.projectId });
  return links;
}
