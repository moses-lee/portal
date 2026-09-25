/**
 * The "Recent changes" section of a chat turn's system prompt: the change log (see `changes.ts`)
 * cut to what this thread should hear about. Only rows detected since the thread's previous chat
 * answer count (a thread with none looks back `RECENT_CHANGES_WINDOW_MS`), and of those a row stays
 * when any of these holds:
 *
 * - it touches this thread: its PR, session, or project is one the thread named or acted on;
 * - it is fresh and the user's own: their PR opened or pushed within `FRESH_MS`, or a session they
 *   started or prompted within it (it finished, stopped, waits on them, or lost its agent);
 * - it is a new review request for the user.
 *
 * Rows an active intent covers are dropped (its checks report on them), and so are rows whose
 * fingerprint the user dismissed. At most `RECENT_CHANGE_LINES` are shown, newest first, then a
 * "+N more (get_changes)" line. Everything here but the section's inputs is pure.
 *
 * What a thread "named or acted on" is read pragmatically from what is stored: its scope, the links
 * of the items its turns touched (`itemIds`), and the text of its messages with the inputs of its
 * tool calls (ids appear there verbatim or as the World section's prefix; a PR as owner/name#n, its URL, "#n", "PR n", or a tool's
 * `"number": n`). A bare PR number counts even without its repo: a collision between two of the
 * user's repos is rarer than a thread that says "#123" and means the obvious one.
 */
import { idMatches } from "../ids.ts";
import type { Item, OrchestratorMessage, PullRef, Scope } from "../types.ts";
import type { WorldChange } from "./changes.ts";
import { shortId } from "./render.ts";

/** Lines the section shows before "+N more (get_changes)". */
export const RECENT_CHANGE_LINES = 10;
/** How far back a thread without an earlier chat answer looks. */
export const RECENT_CHANGES_WINDOW_MS = 24 * 60 * 60_000;
/** A PR opened or pushed, or a session started or prompted, this recently is fresh. */
export const FRESH_MS = 24 * 60 * 60_000;

/** What a thread has named or acted on. */
export type ThreadRefs = {
  sessionIds: Set<string>;
  projectIds: Set<string>;
  /** "owner/name#n", lower case. */
  pulls: Set<string>;
  /** Repos the thread is about ("owner/name", lower case): every PR in them touches it. */
  repos: Set<string>;
  /** PR numbers named without a repo. */
  numbers: Set<number>;
  /** The messages' text and tool inputs, lower case, for ids named verbatim. */
  text: string;
};

const pullName = (pull: Pick<PullRef, "repo" | "number">) => `${pull.repo}#${pull.number}`.toLowerCase();

/** "#123", "PR 123", "pull 123", "pull request #123", and a tool input's `"number":123`. */
const NUMBER_PATTERN = /(?:#|\bpr\s*#?|\bpull(?:\s+request)?\s*#?|"number":\s*)(\d{1,7})\b/gi;
/** owner/name#123 and GitHub PR URLs. */
const PULL_PATTERN = /([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d{1,7})\b/g;

function isToolPart(part: OrchestratorMessage["parts"][number]): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/** The text a message contributes: its text parts and its tool calls' inputs. */
function messageCorpus(message: OrchestratorMessage): string {
  const pieces: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") pieces.push(part.text);
    else if (isToolPart(part)) {
      const input = (part as { input?: unknown }).input;
      if (input !== undefined) {
        try {
          pieces.push(JSON.stringify(input));
        } catch {
          // An input that cannot be written out names nothing we could match.
        }
      }
    }
  }
  return pieces.join("\n");
}

/** What the thread named or acted on, from its scope, its messages, and the items its turns touched. */
export function threadRefs({ scope, messages, items }: { scope: Scope; messages: OrchestratorMessage[]; items: Pick<Item, "id" | "links">[] }): ThreadRefs {
  const refs: ThreadRefs = {
    sessionIds: new Set(scope.sessionIds), projectIds: new Set(scope.projectIds), pulls: new Set(scope.pulls.map(pullName)),
    repos: new Set(scope.repos.map((repo) => repo.toLowerCase())), numbers: new Set(), text: "",
  };
  const byId = new Map(items.map((item) => [item.id, item]));
  const corpus: string[] = [];
  for (const message of messages) {
    for (const id of message.metadata?.itemIds ?? []) {
      const links = byId.get(id)?.links;
      if (links?.sessionId) refs.sessionIds.add(links.sessionId);
      if (links?.projectId) refs.projectIds.add(links.projectId);
      if (links?.pull) refs.pulls.add(pullName(links.pull));
    }
    corpus.push(messageCorpus(message));
  }
  refs.text = corpus.join("\n").toLowerCase();
  for (const match of refs.text.matchAll(PULL_PATTERN)) refs.pulls.add(`${match[1]}#${Number(match[2])}`);
  for (const match of refs.text.matchAll(NUMBER_PATTERN)) refs.numbers.add(Number(match[1]));
  return refs;
}

/** Whether the thread's text names `id`, in full or by the prefix the World section shows. */
const named = (text: string, id: string | undefined) => !!id && text.includes(shortId(id).toLowerCase());
/** Whether `ids` (a scope's or links', maybe prefixes stored before ids were kept full) hold the full id `id`. */
const holds = (ids: Iterable<string>, id: string) => [...ids].some((ref) => idMatches(ref, id));

/** Whether a change is about something the thread named or acted on. */
export function touchesThread(change: Pick<WorldChange, "subject" | "refs">, refs: ThreadRefs): boolean {
  const { pull, sessionId, projectId } = change.refs;
  if (pull && (refs.pulls.has(pullName(pull)) || refs.repos.has(pull.repo.toLowerCase()) || refs.numbers.has(pull.number))) return true;
  if (sessionId && (holds(refs.sessionIds, sessionId) || named(refs.text, sessionId))) return true;
  // A project only speaks for changes about the project itself (its worktree, its folder), not for every session in it.
  const aboutProject = change.subject.startsWith("worktree:") || change.subject.startsWith("folder:");
  return aboutProject && !!projectId && (holds(refs.projectIds, projectId) || named(refs.text, projectId));
}

/** The user's own subject, acted on within `FRESH_MS` of `now`. */
export function freshAndMine(change: Pick<WorldChange, "subject" | "mine" | "activeAt">, now: number): boolean {
  if (!change.mine || change.activeAt === null) return false;
  if (!change.subject.startsWith("pr:") && !change.subject.startsWith("session:")) return false;
  return now - change.activeAt <= FRESH_MS;
}

/** Whether an active intent is about the change's subject; its checks already report on it. */
export function coveredByIntent(change: Pick<WorldChange, "subject" | "refs">, intents: { scope: Scope }[]): boolean {
  const { pull, sessionId, projectId } = change.refs;
  const aboutProject = change.subject.startsWith("worktree:") || change.subject.startsWith("folder:");
  return intents.some(({ scope }) => (!!pull && scope.pulls.some((ref) => pullName(ref) === pullName(pull)))
    || (!!sessionId && holds(scope.sessionIds, sessionId))
    || (aboutProject && !!projectId && holds(scope.projectIds, projectId)));
}

export type RecentChangesInput = {
  /** Change-log rows, any order. */
  rows: WorldChange[];
  now: number;
  /** Only rows detected after this count: the thread's previous chat answer. */
  since: number;
  refs: ThreadRefs;
  /** Active intents. */
  intents: { scope: Scope }[];
  /** Fingerprints of dismissed items. */
  dismissed: ReadonlySet<string>;
  limit?: number;
};

/** The rows the section shows, newest first, and how many more qualified. Pure. */
export function selectRecentChanges({ rows, now, since, refs, intents, dismissed, limit = RECENT_CHANGE_LINES }: RecentChangesInput): { shown: WorldChange[]; more: number } {
  const kept = rows
    .filter((row) => row.at > since && !dismissed.has(row.fingerprint) && !coveredByIntent(row, intents))
    .filter((row) => touchesThread(row, refs) || freshAndMine(row, now) || row.kind === "pr_review_requested")
    .sort((a, b) => b.at - a.at || b.id - a.id);
  return { shown: kept.slice(0, limit), more: Math.max(0, kept.length - limit) };
}

/** "just now", "5m ago", "3h ago", "2d ago". */
function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** The section's lines, or "" when nothing qualifies (the section is then left out). */
export function renderRecentChanges({ shown, more }: { shown: WorldChange[]; more: number }, now: number): string {
  if (shown.length === 0) return "";
  const lines = shown.map((row) => `- ${ago(row.at, now)}: ${row.summary.replace(/\s+/g, " ").trim()}`);
  if (more > 0) lines.push(`- +${more} more (get_changes)`);
  return lines.join("\n");
}

/**
 * When the thread's previous chat answer was given: the newest assistant message of a chat run
 * (or of no recorded run, from before runs were recorded) before the newest user message. Null
 * when the thread has none.
 */
export function previousAnswerAt(messages: OrchestratorMessage[]): number | null {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  for (let i = (lastUser === -1 ? messages.length : lastUser) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" || message.metadata?.tick) continue;
    const kind = message.metadata?.run?.kind;
    if (kind === undefined || kind === "chat") return message.metadata?.at ?? null;
  }
  return null;
}
