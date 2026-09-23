/**
 * Deterministic lookups from loose references to ids: "PR 2367" to the repo and checkout it belongs
 * to, "the monorepo" to a repository, "the review session" to a session. Each answers one match, or
 * the candidates and why it could not pick, so the model asks the user only when a real ambiguity
 * remains. Pure over a `WorldState`, except that `resolvePull` asks GitHub about repos whose PRs the
 * world does not list.
 */
import type { ResolvedPull, Resolution, WorldProject, WorldSession, WorldState } from "@portal/contracts/world";
import type { OrchestratorDeps } from "../deps.ts";
import { errorStatus } from "../../lib/fs-paths.ts";
import type { PullAttention } from "../types.ts";

/** At most this many repos are asked about one PR number at the same time. */
export const PULL_LOOKUP_CONCURRENCY = 4;
/** A repo that has not answered by then counts as a failed lookup. */
export const PULL_LOOKUP_TIMEOUT_MS = 10_000;
/** Candidates returned when a reference is ambiguous. */
export const MAX_CANDIDATES = 10;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const lower = (text: string) => text.trim().toLowerCase();
/** Letters and digits only, for "mono-repo" ≈ "monorepo" ≈ "Mono Repo". */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const basename = (dir: string) => dir.split("/").filter(Boolean).at(-1) ?? dir;

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Close enough to count as a typo of each other: one edit per five characters, at least one. */
function nearly(a: string, b: string): boolean {
  if (!a || !b) return false;
  return editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 5));
}

/** The first tier that matches anything wins; its hits (deduplicated by `key`) are the answer. */
function firstTier<T>(tiers: T[][], key: (value: T) => string): T[] {
  for (const tier of tiers) {
    const seen = new Set<string>();
    const unique = tier.filter((value) => (seen.has(key(value)) ? false : (seen.add(key(value)), true)));
    if (unique.length > 0) return unique;
  }
  return [];
}

function resolution<T>(hits: T[], what: string): Resolution<T> {
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length === 0) return { match: null, candidates: [], reason: `No ${what} matches.` };
  const shown = hits.slice(0, MAX_CANDIDATES);
  return { match: null, candidates: shown, reason: `${hits.length} ${what}s match${hits.length > shown.length ? ` (first ${shown.length} shown)` : ""}; ask the user which one.` };
}

// ---------------------------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------------------------

/** A repository (or, for a folder without a GitHub origin, just its project) with its checkouts. */
export type RepoMatch = {
  /** "owner/name", or null for a project without a GitHub origin. */
  repo: string | null;
  defaultBranch: string | null;
  /** The main checkout (or the only project), when Portal has one. */
  projectId: string | null;
  projects: { id: string; name: string; branch: string | null; worktreeBranch: string | null; missing: boolean }[];
};

function repoMatches(world: WorldState): { match: RepoMatch; names: string[]; folders: string[] }[] {
  const byId = new Map(world.projects.map((p) => [p.id, p]));
  const entry = (project: WorldProject) => ({
    id: project.id, name: project.name, branch: project.branch, worktreeBranch: project.worktree?.branch ?? null, missing: project.missing,
  });
  const repos = world.repos.map((repo) => {
    const projects = repo.projectIds.map((id) => byId.get(id)).filter((p): p is WorldProject => !!p);
    const main = projects.find((p) => !p.worktree) ?? null;
    return {
      match: { repo: repo.repo, defaultBranch: repo.defaultBranch, projectId: main?.id ?? null, projects: projects.map(entry) },
      names: projects.map((p) => p.name), folders: projects.map((p) => basename(p.path)),
    };
  });
  const loose = world.projects.filter((p) => !p.repo).map((project) => ({
    match: { repo: null, defaultBranch: null, projectId: project.id, projects: [entry(project)] },
    names: [project.name], folders: [basename(project.path)],
  }));
  return [...repos, ...loose];
}

/** "https://github.com/a/b.git", "the portal repo", "a/b" → the comparable core of the query. */
function cleanRepoQuery(query: string): string {
  return lower(query)
    .replace(/^https?:\/\/github\.com\//, "").replace(/^git@github\.com:/, "").replace(/\.git$/, "").replace(/\/$/, "")
    .replace(/^(the|my|our)\s+/, "").replace(/\s+(repo|repository|project|checkout)$/, "").trim();
}

/** A repository by owner/name, name, project name, folder name, or a close match of any of them. */
export function resolveRepo(world: WorldState, query: string): Resolution<RepoMatch> {
  const q = cleanRepoQuery(query);
  if (!q) return { match: null, candidates: [], reason: "Empty query." };
  const all = repoMatches(world);
  const name = (repo: string | null) => (repo ? lower(repo.split("/")[1] ?? repo) : "");
  const sq = squash(q);
  const fields = (entry: (typeof all)[number]) => [entry.match.repo ?? "", name(entry.match.repo), ...entry.names, ...entry.folders].map(lower).filter(Boolean);
  const hits = firstTier([
    all.filter((e) => e.match.repo && lower(e.match.repo) === q),
    all.filter((e) => name(e.match.repo) === q),
    all.filter((e) => e.names.some((n) => lower(n) === q) || e.folders.some((f) => lower(f) === q)),
    all.filter((e) => fields(e).some((f) => squash(f) === sq)),
    sq.length >= 3 ? all.filter((e) => fields(e).some((f) => squash(f).includes(sq) || (squash(f).length >= 3 && sq.includes(squash(f))))) : [],
    all.filter((e) => fields(e).some((f) => nearly(squash(f), sq))),
  ], (e) => e.match.repo ? `r:${lower(e.match.repo)}` : `p:${e.match.projectId}`);
  return resolution(hits.map((e) => e.match), "repo");
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export type SessionMatch = {
  id: string;
  title: string | null;
  projectId: string;
  projectName: string | null;
  activity: WorldSession["activity"];
  lastActiveAt: number;
};

const activities: Record<string, WorldSession["activity"]> = {
  waiting: "waiting", blocked: "waiting", permission: "waiting", working: "working", busy: "working", running: "working",
  idle: "idle", error: "error", lost: "error", failed: "error", connecting: "connecting",
};

/** A session by id (or its prefix), title, project, activity, or words of its title. */
export function resolveSession(world: WorldState, query: string): Resolution<SessionMatch> {
  const q = lower(query).replace(/^(the|my)\s+/, "").replace(/\s+session$/, "").trim();
  if (!q) return { match: null, candidates: [], reason: "Empty query." };
  const projects = new Map(world.projects.map((p) => [p.id, p]));
  const sessions = [...world.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id));
  const title = (s: WorldSession) => lower(s.title ?? "");
  const project = (s: WorldSession) => projects.get(s.projectId);
  const words = q.split(/\s+/).filter((w) => w.length >= 3);
  const activity = activities[q];
  const hits = firstTier([
    sessions.filter((s) => s.id === query.trim()),
    q.length >= 4 ? sessions.filter((s) => s.id.toLowerCase().startsWith(q)) : [],
    sessions.filter((s) => title(s) === q),
    activity ? sessions.filter((s) => s.activity === activity) : [],
    sessions.filter((s) => s.title && title(s).includes(q)),
    sessions.filter((s) => { const p = project(s); return !!p && (lower(p.name) === q || squash(p.name) === squash(q) || lower(p.repo ?? "") === q); }),
    words.length ? sessions.filter((s) => words.every((w) => title(s).includes(w))) : [],
    words.length ? sessions.filter((s) => words.some((w) => title(s).includes(w))) : [],
  ], (s) => s.id);
  return resolution(hits.map((s) => ({
    id: s.id, title: s.title, projectId: s.projectId, projectName: project(s)?.name ?? null, activity: s.activity, lastActiveAt: s.lastActiveAt,
  })), "session");
}

// ---------------------------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------------------------

export type PullLookupOptions = { concurrency?: number; timeoutMs?: number };

export type PullResolution = Resolution<ResolvedPull> & {
  /** Where the answer came from: the world's attention list, or asking GitHub per repo. */
  source: "world" | "github" | "none";
  /** Repos that could not be asked, with why; the PR may live there. */
  failed?: string[];
};

function fromAttention(pull: PullAttention): ResolvedPull {
  return {
    repo: pull.repo, number: pull.number, url: pull.url, title: pull.title, author: pull.author, state: pull.state,
    headBranch: pull.headBranch, baseBranch: pull.baseBranch, projectId: pull.localProjectId, worktreeProjectId: pull.worktreeProjectId,
  };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  }));
  return results;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A PR by number: first among the world's PRs (the user authored it or was asked to review it, in
 * any repo on GitHub), then by asking GitHub for that number in every repo Portal has checked out.
 * `repo` narrows the search to repos matching it (resolved like `resolve_repo`).
 */
export async function resolvePull(
  world: WorldState, deps: Pick<OrchestratorDeps, "git">, { number, repo }: { number: number; repo?: string },
  { concurrency = PULL_LOOKUP_CONCURRENCY, timeoutMs = PULL_LOOKUP_TIMEOUT_MS }: PullLookupOptions = {},
): Promise<PullResolution> {
  // The repos the answer may come from: all of them, or those matching `repo`.
  let repos = world.repos.map((r) => r.repo);
  let outside: string | null = null;
  if (repo?.trim()) {
    const wanted = resolveRepo(world, repo);
    const found = (wanted.match ? [wanted.match] : wanted.candidates).map((m) => m.repo).filter((r): r is string => !!r);
    if (found.length > 0) repos = found;
    else if (/^[\w.-]+\/[\w.-]+$/.test(repo.trim())) {
      repos = [];
      outside = repo.trim();
    } else {
      return { match: null, candidates: [], reason: `No repo in Portal matches "${repo}".`, source: "none" };
    }
  }
  const allowed = new Set(repos.map(lower));
  // The world's PRs are the user's across all of GitHub: without a repo named, any of them may match.
  const narrowed = !!repo?.trim();
  const inWorld = world.pulls.filter((p) => p.number === number && (outside ? lower(p.repo) === lower(outside) : !narrowed || allowed.has(lower(p.repo))));
  if (inWorld.length === 1) return { match: fromAttention(inWorld[0]), source: "world" };
  if (inWorld.length > 1) {
    return { match: null, candidates: inWorld.map(fromAttention), reason: `PR #${number} is open in ${inWorld.length} of your repos; ask the user which one.`, source: "world" };
  }
  if (outside) {
    return { match: null, candidates: [], reason: `${outside} has no Portal project, so PR #${number} there cannot be looked up; add or clone the repo first.`, source: "none" };
  }

  // Ask GitHub, once per repo, through any checkout of it that still exists.
  const projects = new Map(world.projects.map((p) => [p.id, p]));
  const targets = world.repos.filter((r) => allowed.has(lower(r.repo))).map((r) => {
    const members = r.projectIds.map((id) => projects.get(id)).filter((p): p is WorldProject => !!p);
    return { repo: r.repo, members, checkout: members.find((p) => !p.missing) ?? null, main: members.find((p) => !p.worktree) ?? null };
  });
  const failed: string[] = [];
  const outcomes = await pool(targets, concurrency, async (target): Promise<ResolvedPull | null> => {
    if (!target.checkout) {
      failed.push(`${target.repo}: no checkout on disk`);
      return null;
    }
    try {
      const pull = await withTimeout((async () => deps.git.getPull(await deps.git.repoRootOf(target.checkout!.path), number))(), timeoutMs);
      const worktree = target.members.find((p) => p.worktree && p.worktree.branch === pull.branch && !p.missing);
      return {
        repo: target.repo, number, url: `https://github.com/${target.repo}/pull/${number}`, title: pull.title, author: pull.author ?? "", state: pull.state,
        headBranch: pull.branch, baseBranch: pull.baseBranch ?? "", projectId: target.main?.id ?? target.checkout.id, worktreeProjectId: worktree?.id ?? null,
      };
    } catch (err) {
      if (errorStatus(err) !== 404) failed.push(`${target.repo}: ${errorMessage(err)}`);
      return null;
    }
  });
  const hits = outcomes.filter((hit): hit is ResolvedPull => !!hit);
  failed.sort();
  const extra = failed.length ? { failed } : {};
  if (hits.length === 1) return { match: hits[0], source: "github", ...extra };
  if (hits.length > 1) {
    // Open PRs first, then by repo name.
    hits.sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open") || a.repo.localeCompare(b.repo));
    return { match: null, candidates: hits, reason: `PR #${number} exists in ${hits.length} of your repos; ask the user which one.`, source: "github", ...extra };
  }
  const reason = targets.length === 0
    ? "Portal has no GitHub repos to look in."
    : `No repo in Portal has PR #${number}${failed.length ? `; ${failed.length} repo(s) could not be checked` : ""}.`;
  return { match: null, candidates: [], reason, source: "none", ...extra };
}
