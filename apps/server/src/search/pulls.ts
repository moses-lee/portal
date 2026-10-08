/**
 * Global search's pull request half (docs/SEARCH.md), pure: which known PRs a query names, and
 * which sessions each of them is associated with. A PR is never a result of its own; it is a way to
 * find the sessions that worked on it.
 *
 * Query: a bare number or `#123` names PR 123 in any repo; `name#123` or `owner/name#123` names it
 * in that repo; anything else matches PR titles and head branches as a case-insensitive substring.
 *
 * Association, strongest first (a session linked several ways reports the strongest):
 *   item    an orchestrator item links the session and the PR;
 *   title   the session's title names the PR (`#123`, `name#123`, `owner/name#123`; a bare `#123`
 *           counts only when the session's project is not known to belong to another repo);
 *   branch  the session's project is a worktree on the PR's head branch, in the PR's repo. Never
 *           the branch a main checkout happens to be on now: that would tie every session ever
 *           run there to whatever PR the checkout last switched to. Sessions store no branch of
 *           their own from the time they ran.
 */
import type { PullRef } from "@portal/contracts/orchestrator";
import type { SearchPullHit } from "@portal/contracts/search";

/**
 * A PR Portal has seen: the world's list carries all of it, the change log the ref and title, an
 * orchestrator item's link only the ref.
 */
export type CatalogPull = PullRef & { title?: string; headBranch?: string; updatedAt?: number };

export type PullQuery = { number: number; repo: string | null } | { text: string };

export type SearchSession = { id: string; title: string | null; projectId: string; lastActiveAt: number };

export type PullSearchInput = {
  pulls: CatalogPull[];
  sessions: SearchSession[];
  /** Orchestrator items' links that name both a session and a PR. */
  itemLinks: { sessionId: string; repo: string; number: number }[];
  /** "owner/name" (lowercased) of the repo a project belongs to, when known. */
  repoOf(projectId: string): string | null;
  /** The worktree branch of a project, or null for a main checkout or an unknown project. */
  worktreeBranch(projectId: string): string | null;
};

/** The most session hits one search answers. */
export const PULL_HITS_MAX = 20;

const REF = /^(?:([\w.-]+(?:\/[\w.-]+)?)#|#)?(\d{1,9})$/;
const TITLE_REF = /(?:([\w.-]+(?:\/[\w.-]+)?))?#(\d{1,9})\b/g;

export function parsePullQuery(q: string): PullQuery {
  const ref = REF.exec(q.trim());
  if (ref) return { number: Number(ref[2]), repo: ref[1]?.toLowerCase() ?? null };
  return { text: q.trim().toLowerCase() };
}

/** Whether `name` ("owner/name" or just "name", any case) names `repo` ("owner/name"). */
export function namesRepo(name: string, repo: string): boolean {
  const wanted = name.toLowerCase();
  const full = repo.toLowerCase();
  return wanted === full || wanted === full.slice(full.indexOf("/") + 1);
}

/** The PR references in a session title. */
export function titleRefs(title: string | null): { repo: string | null; number: number }[] {
  if (!title) return [];
  return [...title.matchAll(TITLE_REF)].map((match) => ({ repo: match[1] ?? null, number: Number(match[2]) }));
}

export function matchPulls(pulls: CatalogPull[], query: PullQuery): CatalogPull[] {
  if ("number" in query) return pulls.filter((pull) => pull.number === query.number && (query.repo === null || namesRepo(query.repo, pull.repo)));
  const text = query.text;
  if (!text) return [];
  return pulls.filter((pull) => pull.title?.toLowerCase().includes(text) || pull.headBranch?.toLowerCase().includes(text));
}

/**
 * The catalog as one entry per PR: the world's entries win, a change-log title fills in where the
 * world has none, and a PR only an item links (the change log prunes old rows) still matches by
 * number. Newest activity first, then highest number.
 */
export function mergeCatalog(world: CatalogPull[], changes: CatalogPull[], items: CatalogPull[] = []): CatalogPull[] {
  const byKey = new Map<string, CatalogPull>();
  const key = (pull: CatalogPull) => `${pull.repo.toLowerCase()}#${pull.number}`;
  for (const pull of items) if (!byKey.has(key(pull))) byKey.set(key(pull), pull);
  for (const pull of changes) {
    const seen = byKey.get(key(pull));
    byKey.set(key(pull), seen ? { ...pull, updatedAt: Math.max(pull.updatedAt ?? 0, seen.updatedAt ?? 0) } : pull);
  }
  for (const pull of world) {
    const seen = byKey.get(key(pull));
    byKey.set(key(pull), { ...pull, title: pull.title || seen?.title });
  }
  return [...byKey.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.number - a.number);
}

const RANK: Record<SearchPullHit["via"], number> = { item: 0, title: 1, branch: 2 };

/** The sessions associated with each PR the query names, PRs in catalog order, sessions newest first within each. */
export function searchPulls(q: string, input: PullSearchInput): SearchPullHit[] {
  const matched = matchPulls(input.pulls, parsePullQuery(q));
  const hits: SearchPullHit[] = [];
  for (const pull of matched) {
    const repo = pull.repo.toLowerCase();
    const via = new Map<string, SearchPullHit["via"]>();
    const link = (sessionId: string, how: SearchPullHit["via"]) => {
      const had = via.get(sessionId);
      if (!had || RANK[how] < RANK[had]) via.set(sessionId, how);
    };
    for (const item of input.itemLinks) {
      if (item.number === pull.number && item.repo.toLowerCase() === repo) link(item.sessionId, "item");
    }
    for (const session of input.sessions) {
      const sessionRepo = input.repoOf(session.projectId);
      const named = titleRefs(session.title).some((ref) => ref.number === pull.number
        && (ref.repo ? namesRepo(ref.repo, pull.repo) : sessionRepo === null || sessionRepo === repo));
      if (named) link(session.id, "title");
    }
    if (pull.headBranch) {
      for (const session of input.sessions) {
        if (input.repoOf(session.projectId) === repo && input.worktreeBranch(session.projectId) === pull.headBranch) link(session.id, "branch");
      }
    }
    const known = new Map(input.sessions.map((session) => [session.id, session]));
    const ids = [...via.keys()].filter((id) => known.has(id)).sort((a, b) => known.get(b)!.lastActiveAt - known.get(a)!.lastActiveAt);
    const ref = { repo: pull.repo, number: pull.number, url: pull.url, ...(pull.title ? { title: pull.title } : {}) };
    for (const sessionId of ids) hits.push({ sessionId, pull: ref, via: via.get(sessionId)! });
    if (hits.length >= PULL_HITS_MAX) break;
  }
  return hits.slice(0, PULL_HITS_MAX);
}
