/**
 * Which pull requests across all of GitHub concern the user: PRs they authored and PRs where their
 * review is requested, whether or not the repository is a Portal project. Read by the orchestrator's
 * tick through one `gh api graphql` call, so a tick costs one request however many PRs there are.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { githubRepoUrl } from "../github-summary.ts";
import { type GhRunner, WorktreeError, defaultGh, ghFailureReason, gitMaybe } from "../worktrees.ts";
import type { ItemKind, PullAttention } from "./types.ts";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 4 * 1024 * 1024;
/** A clone can take far longer than `defaultGh`'s 20s budget. */
const CLONE_TIMEOUT = 5 * 60_000;
const SEARCH_LIMIT = 50;
/** Pages fetched per search before giving up and reporting `truncated` (3 × SEARCH_LIMIT PRs each). */
export const MAX_SEARCH_PAGES = 3;
/** Wait before the single retry of a transient GitHub failure. */
const RETRY_DELAY = 1500;

type Role = PullAttention["roles"][number];

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

let cachedLogin: string | null = null;
let loginInFlight: Promise<string> | null = null;

/** Forget the cached login; for tests. */
export function resetGithubAttentionCaches() {
  cachedLogin = null;
  loginInFlight = null;
}

/** The logged-in GitHub user's login, asked of gh once per process. Throws with a short reason when gh cannot answer. */
export function getGithubLogin(gh: GhRunner = defaultGh, cwd = os.homedir()): Promise<string> {
  if (cachedLogin) return Promise.resolve(cachedLogin);
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    let stdout: string;
    try {
      ({ stdout } = await gh(["api", "user", "--jq", ".login"], { cwd }));
    } catch (err) {
      throw new WorktreeError(ghFailureReason(err), 409);
    }
    const login = stdout.trim();
    if (!login) throw new WorktreeError("gh returned unexpected output", 409);
    cachedLogin = login;
    return login;
  })().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export const AUTHORED_SEARCH = "is:pr is:open author:@me sort:updated-desc";
export const REVIEW_REQUESTED_SEARCH = "is:pr is:open review-requested:@me sort:updated-desc";

const PULL_FRAGMENT = `... on PullRequest {
      number title url isDraft state mergeable reviewDecision baseRefName headRefName updatedAt
      author { login } repository { nameWithOwner }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }`;

/** One page of a search: the count of everything that matches, the cursor to continue from, and the nodes. */
const SEARCH_FIELDS = `issueCount pageInfo { hasNextPage endCursor } nodes { ${PULL_FRAGMENT} }`;

/** Both searches in one request, aliased so a single response carries the author and reviewer sets. */
export const ATTENTION_QUERY = `query($authored:String!,$requested:String!){
  authored: search(type: ISSUE, query: $authored, first: ${SEARCH_LIMIT}){ ${SEARCH_FIELDS} }
  requested: search(type: ISSUE, query: $requested, first: ${SEARCH_LIMIT}){ ${SEARCH_FIELDS} }
}`;

/** A further page of one search, so a search that is finished is not fetched again alongside one that is not. */
export const ATTENTION_PAGE_QUERY = `query($search:String!,$after:String!){
  page: search(type: ISSUE, query: $search, first: ${SEARCH_LIMIT}, after: $after){ ${SEARCH_FIELDS} }
}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** "owner/name#number", the key `TickSnapshot.pulls` uses. */
export function pullKey(pull: Pick<PullAttention, "repo" | "number">): string {
  return `${pull.repo}#${pull.number}`;
}

function toChecks(commits: unknown): PullAttention["checks"] {
  const nodes = asRecord(commits)?.nodes;
  const head = Array.isArray(nodes) ? asRecord(nodes[0]) : null;
  const rollup = asRecord(asRecord(head?.commit)?.statusCheckRollup);
  const state = String(rollup?.state ?? "").toUpperCase();
  return state === "SUCCESS" ? "passing"
    : state === "FAILURE" || state === "ERROR" ? "failing"
    : state === "PENDING" || state === "EXPECTED" ? "pending" : null;
}

function toAttention(raw: unknown, role: Role): PullAttention | null {
  const p = asRecord(raw);
  const repo = asRecord(p?.repository)?.nameWithOwner;
  if (!p || typeof p.number !== "number" || typeof repo !== "string" || !repo) return null;
  const state = String(p.state ?? "open").toLowerCase();
  const review = String(p.reviewDecision ?? "").toUpperCase();
  const mergeable = String(p.mergeable ?? "").toUpperCase();
  const updatedAt = typeof p.updatedAt === "string" ? Date.parse(p.updatedAt) : NaN;
  return {
    repo,
    number: p.number,
    url: typeof p.url === "string" ? p.url : `https://github.com/${repo}/pull/${p.number}`,
    title: typeof p.title === "string" ? p.title : "",
    author: String(asRecord(p.author)?.login ?? ""),
    roles: [role],
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft: p.isDraft === true,
    baseBranch: typeof p.baseRefName === "string" ? p.baseRefName : "",
    headBranch: typeof p.headRefName === "string" ? p.headRefName : "",
    checks: toChecks(p.commits),
    reviewDecision: review === "APPROVED" ? "approved" : review === "CHANGES_REQUESTED" ? "changes_requested"
      : review === "REVIEW_REQUIRED" ? "review_required" : null,
    mergeable: mergeable === "MERGEABLE" ? "mergeable" : mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    localProjectId: null,
    worktreeProjectId: null,
  };
}

function mergeInto(pulls: Map<string, PullAttention>, nodes: unknown, role: Role) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    const pull = toAttention(node, role);
    if (!pull) continue;
    const key = pullKey(pull);
    const known = pulls.get(key);
    if (!known) pulls.set(key, pull);
    else if (!known.roles.includes(role)) known.roles.push(role);
  }
}

const TRANSIENT_FAILURE = /\b50[234]\b|timeout|timed out|bad gateway|gateway timeout|service unavailable/i;

/** A failure GitHub is likely to have got over by the time we ask again: a 5xx, or a timeout on either side. */
export function isTransientGhFailure(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: boolean; stderr?: unknown };
  if (e?.code === "ENOENT") return false;
  if (e?.killed) return true; // execFile's own timeout
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  return TRANSIENT_FAILURE.test(`${stderr}\n${ghFailureReason(err)}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run gh once, and once more after `retryDelayMs` when the failure looks transient. Anything else is rethrown at once. */
async function ghWithRetry(gh: GhRunner, args: string[], cwd: string, retryDelayMs: number): Promise<string> {
  try {
    return (await gh(args, { cwd })).stdout;
  } catch (err) {
    if (!isTransientGhFailure(err)) throw err;
    await sleep(retryDelayMs);
    return (await gh(args, { cwd })).stdout;
  }
}

/** The `data` object and the first error message (first line) of a GraphQL response body, whichever are present. */
function parseGraphqlBody(text: unknown): { data: Record<string, unknown> | null; message: string | null } {
  let parsed: unknown = null;
  if (typeof text === "string") {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  const body = asRecord(parsed);
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const message = asRecord(errors[0])?.message;
  return { data: asRecord(body?.data), message: typeof message === "string" && message ? message.split("\n")[0] : null };
}

type GraphqlOutcome = { data: Record<string, unknown> | null; error: string | null; warning: string | null };

/**
 * One GraphQL request through gh. `gh api graphql` exits 1 whenever the response carries `errors`,
 * but a partial response (`data` for the parts that worked, e.g. one search timing out and the other
 * not) is still printed to stdout, so a rejection is parsed before it is treated as a failure: data
 * with errors comes back as a `warning`, no data at all as an `error`.
 */
async function runGraphql(gh: GhRunner, cwd: string, query: string, variables: Record<string, string>, retryDelayMs: number): Promise<GraphqlOutcome> {
  const args = ["api", "graphql", "-f", `query=${query}`, ...Object.entries(variables).flatMap(([name, value]) => ["-f", `${name}=${value}`])];
  let stdout: string;
  try {
    stdout = await ghWithRetry(gh, args, cwd, retryDelayMs);
  } catch (err) {
    const partial = parseGraphqlBody((err as { stdout?: unknown })?.stdout);
    if (partial.data) return { data: partial.data, error: null, warning: partial.message ?? ghFailureReason(err) };
    return { data: null, error: partial.message ?? ghFailureReason(err), warning: null };
  }
  const parsed = parseGraphqlBody(stdout);
  if (!parsed.data) return { data: null, error: parsed.message ?? "gh returned unexpected output", warning: null };
  return { data: parsed.data, error: null, warning: parsed.message };
}

export type AttentionSearchOptions = {
  gh?: GhRunner;
  cwd?: string;
  /**
   * Only PRs updated at or after this time (epoch ms). GitHub search filters by UTC day, so this
   * becomes `updated:>=YYYY-MM-DD` on both searches and may include a little more than asked.
   */
  updatedSince?: number;
  /** Wait before the single retry of a transient failure; tests shorten it. */
  retryDelayMs?: number;
};

export type AttentionSearchResult = {
  pulls: PullAttention[];
  /** Why nothing could be fetched; null when the searches ran (even with a `warning`). */
  error: string | null;
  /** Something went wrong short of losing everything: a partial GraphQL response, or a later page that failed. `pulls` is what did arrive. */
  warning: string | null;
  /** True when either search had more matches than the pages fetched (MAX_SEARCH_PAGES × 50) or a later page failed. */
  truncated: boolean;
  /** GitHub's `issueCount` per search: how many PRs match, fetched or not. */
  total: { authored: number; requested: number };
};

/** Everything one search produced across its pages. */
type SearchPages = { nodes: unknown[]; total: number; truncated: boolean; warnings: string[] };

/** Page through one search starting from its first page, stopping at MAX_SEARCH_PAGES. Never throws. */
async function collectPages(first: unknown, search: string, gh: GhRunner, cwd: string, retryDelayMs: number): Promise<SearchPages> {
  const result: SearchPages = { nodes: [], total: 0, truncated: false, warnings: [] };
  let page = asRecord(first);
  result.total = typeof page?.issueCount === "number" ? page.issueCount : 0;
  for (let fetched = 1; ; fetched++) {
    if (Array.isArray(page?.nodes)) result.nodes.push(...page.nodes);
    const info = asRecord(page?.pageInfo);
    if (info?.hasNextPage !== true || typeof info.endCursor !== "string") return result;
    if (fetched >= MAX_SEARCH_PAGES) {
      result.truncated = true;
      return result;
    }
    // The variable is `search`, not `query`: `gh api graphql -f query=` is the document itself.
    const next = await runGraphql(gh, cwd, ATTENTION_PAGE_QUERY, { search, after: info.endCursor }, retryDelayMs);
    if (next.warning) result.warnings.push(next.warning);
    page = next.data ? asRecord(next.data.page) : null;
    if (!page) {
      // The earlier pages are still worth having; say that the list stops short.
      result.warnings.push(next.error ?? "gh returned unexpected output");
      result.truncated = true;
      return result;
    }
  }
}

/**
 * Open PRs the user authored or was asked to review, newest-updated first, with `roles` merged for
 * PRs found by both searches. Never throws: when gh cannot answer (not installed, signed out, offline,
 * rate limited) the list is empty and `error` says why; a transient failure is retried once first.
 * Each search is paged up to MAX_SEARCH_PAGES; `truncated` and `total` say when that was not enough
 * (a long-standing account can have hundreds of review requests), and `updatedSince` narrows the
 * searches so a tick that only wants recent changes never hits the cap. `localProjectId` /
 * `worktreeProjectId` are null here; `attachLocalProjects` fills them in.
 */
export async function searchAttentionPulls({
  gh = defaultGh, cwd = os.homedir(), updatedSince, retryDelayMs = RETRY_DELAY,
}: AttentionSearchOptions = {}): Promise<AttentionSearchResult> {
  const since = updatedSince === undefined ? "" : ` updated:>=${new Date(updatedSince).toISOString().slice(0, 10)}`;
  const searches = { authored: AUTHORED_SEARCH + since, requested: REVIEW_REQUESTED_SEARCH + since };
  const first = await runGraphql(gh, cwd, ATTENTION_QUERY, searches, retryDelayMs);
  if (!first.data) return { pulls: [], error: first.error, warning: null, truncated: false, total: { authored: 0, requested: 0 } };

  // Later pages of the two searches are fetched side by side, then merged in a fixed order so
  // `roles` reads ["author", "reviewer"] however the requests interleave.
  const [authored, requested] = await Promise.all([
    collectPages(first.data.authored, searches.authored, gh, cwd, retryDelayMs),
    collectPages(first.data.requested, searches.requested, gh, cwd, retryDelayMs),
  ]);
  const pulls = new Map<string, PullAttention>();
  mergeInto(pulls, authored.nodes, "author");
  mergeInto(pulls, requested.nodes, "reviewer");
  const list = [...pulls.values()].sort((a, b) => b.updatedAt - a.updatedAt || pullKey(a).localeCompare(pullKey(b)));
  const warnings = [first.warning, ...authored.warnings, ...requested.warnings].filter((w): w is string => !!w);
  return {
    pulls: list,
    error: null,
    warning: warnings[0] ?? null,
    truncated: authored.truncated || requested.truncated,
    total: { authored: authored.total, requested: requested.total },
  };
}

// ---------------------------------------------------------------------------------------------
// Local projects
// ---------------------------------------------------------------------------------------------

/** What `attachLocalProjects` needs to know about a Portal project. */
export type LocalProject = {
  id: string;
  path: string;
  /** The checkout's origin URL (see `readOriginUrl`), or null when it has none. */
  remoteUrl: string | null;
  /** Set for worktree projects: the main checkout's project id and the branch checked out. */
  worktree?: { parentId: string; branch: string };
};

/** The origin URL of the checkout at `dir`, or null when there is none (or `dir` is not a repository). */
export async function readOriginUrl(dir: string): Promise<string | null> {
  const out = await gitMaybe(dir, ["remote", "get-url", "origin"]);
  return out?.trim() || null;
}

function repoUrlKey(repo: string): string {
  return `https://github.com/${repo}`.toLowerCase();
}

/**
 * Fill `localProjectId` (the main checkout of the PR's repository) and `worktreeProjectId` (a worktree
 * project already on the PR's head branch) by matching each project's origin against the PR's repo.
 * Pure: returns new pull objects, first matching project wins.
 */
export function attachLocalProjects(pulls: PullAttention[], projects: LocalProject[]): PullAttention[] {
  const mains = new Map<string, string>();
  const worktrees = new Map<string, string>();
  for (const project of projects) {
    const url = project.remoteUrl ? githubRepoUrl(project.remoteUrl)?.toLowerCase() : null;
    if (!url) continue;
    if (project.worktree) {
      const key = `${url}\n${project.worktree.branch}`;
      if (!worktrees.has(key)) worktrees.set(key, project.id);
    } else if (!mains.has(url)) {
      mains.set(url, project.id);
    }
  }
  return pulls.map((pull) => {
    const url = repoUrlKey(pull.repo);
    return {
      ...pull,
      roles: [...pull.roles],
      localProjectId: mains.get(url) ?? null,
      worktreeProjectId: worktrees.get(`${url}\n${pull.headBranch}`) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------------------------

/** Where Portal clones repositories it does not have yet: `<PORTAL_HOME or ~/.portal>/repos`. */
export function portalReposDir(home = os.homedir()): string {
  return path.join(process.env.PORTAL_HOME || path.join(home, ".portal"), "repos");
}

/** `defaultGh` with a budget fit for cloning. */
const cloneGh: GhRunner = (args, { cwd }) => execFileAsync("gh", args, {
  cwd, timeout: CLONE_TIMEOUT, maxBuffer: MAX_BUFFER,
  env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
});

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * `gh repo clone owner/name <reposDir>/<name>`, returning the checkout path. A directory already there
 * is reused when it is a clone of the same repository and rejected with a clear 409 otherwise.
 */
export async function cloneRepo({ repo, gh = cloneGh, reposDir = portalReposDir() }: { repo: string; gh?: GhRunner; reposDir?: string }): Promise<string> {
  const [owner, name] = repo.split("/");
  if (!REPO_PATTERN.test(repo) || [owner, name].some((part) => part === "." || part === "..")) {
    throw new WorktreeError(`"${repo}" is not an owner/name repository.`, 400);
  }
  const target = path.join(reposDir, name);
  const existing = await stat(target).then((info) => info.isDirectory() ? "directory" : "file", () => null);
  if (existing) {
    const origin = existing === "directory" ? await readOriginUrl(target) : null;
    const url = origin ? githubRepoUrl(origin) : null;
    if (url && url.toLowerCase() === repoUrlKey(repo)) return target;
    throw new WorktreeError(url
      ? `${target} already exists but is a clone of ${url}, not ${repo}.`
      : `${target} already exists but is not a clone of ${repo}.`, 409);
  }
  await mkdir(reposDir, { recursive: true });
  try {
    await gh(["repo", "clone", repo, target], { cwd: reposDir });
  } catch (err) {
    // git writes origin before it fetches, so a failed or timed-out clone leaves a half-checkout the
    // next call would take for a finished one. Nothing was there before, so nothing is lost by removing it.
    await rm(target, { recursive: true, force: true }).catch(() => {});
    throw new WorktreeError(`Could not clone ${repo}: ${ghFailureReason(err)}`, 409);
  }
  return target;
}

// ---------------------------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------------------------

/**
 * Which item kinds an open PR warrants: as author, failing checks, requested changes, and conflicts;
 * as reviewer, a pending review request unless the PR is still a draft.
 */
export function attentionReasons(pull: PullAttention): ItemKind[] {
  const reasons: ItemKind[] = [];
  if (pull.state !== "open") return reasons;
  if (pull.roles.includes("author")) {
    if (pull.checks === "failing") reasons.push("pr_checks_failing");
    if (pull.reviewDecision === "changes_requested") reasons.push("pr_changes_requested");
    if (pull.mergeable === "conflicting") reasons.push("pr_conflicts");
  }
  if (pull.roles.includes("reviewer") && !pull.draft) reasons.push("pr_review_requested");
  return reasons;
}
