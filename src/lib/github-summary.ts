import type {
  CheckRun, CheckState, CheckSummary, CommitPage, CommitRow, ConflictSummary, GithubSummary, PullSummary,
} from "./types.ts";
import {
  type GhRunner, WorktreeError, defaultGh, ghFailureReason, ghSaysNoSuchPull, git, gitMaybe, gitResult, repoRootOf,
} from "./worktrees.ts";

const SLOW_TIMEOUT = 60_000;
const MERGE_TREE_TIMEOUT = 10_000;
const PAGE_SIZE = 30;
/** Own commits shown on the first page of a branch before paging takes over. */
const DEFAULT_BRANCH_LOG_CAP = 200;
const PULL_CACHE_MS = 60_000;
const DEFAULT_FETCH_INTERVAL_MS = 20_000;
/** Review threads are counted a page at a time; beyond this many pages the count is a lower bound. */
const MAX_THREAD_PAGES = 10;

type FetchResult = { fetchedAt: number | null; fetchError: string | null };
type PullResult = { pull: PullSummary | null; pullError: string | null };

/** Last fetch outcome per repository (keyed by its common git dir, so worktrees share it). */
const fetchResults = new Map<string, FetchResult & { finishedAt: number }>();
/** Running fetches keyed by repository, and by the checkout path callers passed in. */
const fetchesByRepo = new Map<string, Promise<FetchResult>>();
const fetchesInFlight = new Map<string, Promise<FetchResult>>();
const summariesInFlight = new Map<string, Promise<GithubSummary>>();
const pullCache = new Map<string, PullResult & { expires: number }>();
/** Checkout path → common git dir; resolved once per checkout. */
const repoKeys = new Map<string, string>();
let mergeTreeSupport: Promise<boolean> | null = null;

/** Forget cached gh answers, fetch history, and in-flight work; for tests. */
export function resetGithubSummaryCaches() {
  fetchResults.clear();
  fetchesByRepo.clear();
  fetchesInFlight.clear();
  summariesInFlight.clear();
  pullCache.clear();
  repoKeys.clear();
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** Drop `user[:password]@` from any URL in text git printed, so a token in a remote never reaches the browser. */
export function redactCredentials(text: string): string {
  return text.replace(/\/\/[^@/\s]+@/g, "//");
}

function errorText(err: unknown): string {
  return redactCredentials(err instanceof Error ? err.message : String(err));
}

/**
 * The key fetch state is stored under: the repository's common git dir, shared by the main checkout
 * and every linked worktree. Falls back to the checkout path when git cannot say.
 */
async function repoKey(repoRoot: string): Promise<string> {
  const known = repoKeys.get(repoRoot);
  if (known) return known;
  const common = (await gitMaybe(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))?.trim();
  const key = common || repoRoot;
  repoKeys.set(repoRoot, key);
  return key;
}

function fetchByRepo(key: string, cwd: string, minIntervalMs: number): Promise<FetchResult> {
  const running = fetchesByRepo.get(key);
  if (running) return running;
  const previous = fetchResults.get(key);
  if (previous && Date.now() - previous.finishedAt < minIntervalMs) {
    return Promise.resolve({ fetchedAt: previous.fetchedAt, fetchError: previous.fetchError });
  }
  const run = git(cwd, ["fetch", "origin", "--prune"], SLOW_TIMEOUT).then(
    (): FetchResult => ({ fetchedAt: Date.now(), fetchError: null }),
    (err): FetchResult => ({ fetchedAt: previous?.fetchedAt ?? null, fetchError: firstLine(errorText(err)) || "git fetch failed" }),
  ).then((result) => {
    fetchResults.set(key, { ...result, finishedAt: Date.now() });
    return result;
  }).finally(() => fetchesByRepo.delete(key));
  fetchesByRepo.set(key, run);
  return run;
}

/**
 * `git fetch origin --prune` for the repository containing `repoRoot`, at most once every `minIntervalMs`
 * and never twice at once: concurrent callers (from any of its worktrees) share the running fetch.
 * Failure keeps the previous `fetchedAt` and records why.
 */
export function fetchRepo(repoRoot: string, { minIntervalMs = DEFAULT_FETCH_INTERVAL_MS }: { minIntervalMs?: number } = {}): Promise<FetchResult> {
  const running = fetchesInFlight.get(repoRoot);
  if (running) return running;
  const run = repoKey(repoRoot)
    .then((key) => fetchByRepo(key, repoRoot, minIntervalMs))
    .finally(() => fetchesInFlight.delete(repoRoot));
  fetchesInFlight.set(repoRoot, run);
  return run;
}

function lastFetch(key: string): FetchResult {
  const known = fetchResults.get(key);
  return { fetchedAt: known?.fetchedAt ?? null, fetchError: known?.fetchError ?? null };
}

/** `https://github.com/<owner>/<name>` from an origin URL in ssh, scp-like, or https form; null otherwise. */
export function githubRepoUrl(remote: string): string | null {
  const url = remote.trim();
  const match = /^(?:https?:\/\/(?:[^@/]*@)?github\.com\/|ssh:\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/|(?:[^@/]*@)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (!match) return null;
  const [, owner, name] = match;
  if (!owner || !name || owner === "." || name === ".") return null;
  return `https://github.com/${owner}/${name}`;
}

async function readDefaultBranch(repoRoot: string): Promise<string | null> {
  const head = (await gitMaybe(repoRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]))?.trim();
  if (head?.startsWith("refs/remotes/origin/")) return head.slice("refs/remotes/origin/".length);
  const refs = await gitMaybe(repoRoot, [
    "for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master",
  ]) ?? "";
  return ["main", "master"].find((name) => refs.includes(`/${name}\n`)) ?? null;
}

// NUL between fields and (with -z) after each record; the subject comes last so nothing in it can shift a field.
const LOG_FIELDS = ["%H", "%h", "%an", "%ct", "%P", "%s"];
const LOG_FORMAT = `--format=${LOG_FIELDS.join("%x00")}`;

type RawCommit = { sha: string; short: string; subject: string; author: string; committedAt: number; parents: string[] };

function parseLog(out: string): RawCommit[] {
  const fields = out.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const commits: RawCommit[] = [];
  for (let i = 0; i + LOG_FIELDS.length <= fields.length; i += LOG_FIELDS.length) {
    const [sha, short, author, committed, parents, subject] = fields.slice(i, i + LOG_FIELDS.length);
    commits.push({ sha, short, author, committedAt: Number(committed) * 1000, parents: parents.split(" ").filter(Boolean), subject });
  }
  return commits;
}

async function gitLog(repoRoot: string, args: string[]): Promise<RawCommit[] | null> {
  const out = await gitMaybe(repoRoot, ["log", "-z", LOG_FORMAT, ...args]);
  return out === null ? null : parseLog(out);
}

type Marks = { headSha: string | null; remoteSha: string | null };

function toRow(commit: RawCommit, { headSha, remoteSha }: Marks, base = false): CommitRow {
  return {
    sha: commit.sha, short: commit.short, subject: commit.subject, author: commit.author, committedAt: commit.committedAt,
    head: commit.sha === headSha, remoteHead: commit.sha === remoteSha, base,
  };
}

async function readMarks(repoRoot: string): Promise<Marks> {
  const [headSha, remoteSha] = await Promise.all([
    gitMaybe(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]),
    gitMaybe(repoRoot, ["rev-parse", "--verify", "-q", "@{upstream}"]),
  ]);
  return { headSha: headSha?.trim() || null, remoteSha: remoteSha?.trim() || null };
}

/**
 * Paging cursors are opaque to the browser: `<start>:<skip>` pages `git log <start> --skip=<skip>`, and
 * `<start>:<skip>:<exclude>` pages the range `<exclude>..<start>` (a branch's own commits); when that
 * range runs out the page ends with the merge-base row and a cursor into the base's history.
 */
type Cursor = { start: string; skip: number; exclude: string | null };

const SHA = "[0-9a-f]{7,40}";
const CURSOR_PATTERN = new RegExp(`^(${SHA}):(\\d{1,9})(?::(${SHA}))?$`, "i");

function parseCursor(raw: string): Cursor | null {
  const match = CURSOR_PATTERN.exec(raw);
  return match ? { start: match[1], skip: Number(match[2]), exclude: match[3] ?? null } : null;
}

function formatCursor({ start, skip, exclude }: Cursor): string {
  return exclude ? `${start}:${skip}:${exclude}` : `${start}:${skip}`;
}

/**
 * One page of the log described by `cursor`, reading one extra commit to learn whether more follow.
 * A range page that reaches the end of the range appends the merge-base row and continues into base history.
 */
async function logPage(repoRoot: string, cursor: Cursor, marks: Marks, size = PAGE_SIZE): Promise<CommitPage> {
  const rev = cursor.exclude ? `${cursor.exclude}..${cursor.start}` : cursor.start;
  const found = await gitLog(repoRoot, [rev, `--skip=${cursor.skip}`, "-n", String(size + 1)]) ?? [];
  const commits = found.slice(0, size).map((commit) => toRow(commit, marks));
  if (found.length > size) return { commits, cursor: formatCursor({ ...cursor, skip: cursor.skip + size }) };
  if (!cursor.exclude) return { commits, cursor: null };
  const mergeBase = (await gitMaybe(repoRoot, ["merge-base", cursor.exclude, cursor.start]))?.trim();
  const [anchor] = mergeBase ? await gitLog(repoRoot, ["-n", "1", mergeBase]) ?? [] : [];
  if (!anchor || !mergeBase) return { commits, cursor: null };
  commits.push(toRow(anchor, marks, true));
  return { commits, cursor: formatCursor({ start: mergeBase, skip: 1, exclude: null }) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

function toCheck(raw: unknown): CheckRun | null {
  const node = asRecord(raw);
  if (!node) return null;
  if (node.__typename === "StatusContext") {
    const state = String(node.state ?? "").toUpperCase();
    const mapped: CheckState = state === "SUCCESS" ? "passing" : state === "PENDING" || state === "EXPECTED" ? "pending"
      : state === "ERROR" || state === "FAILURE" ? "failing" : "pending";
    return { name: String(node.context ?? ""), state: mapped, url: typeof node.targetUrl === "string" ? node.targetUrl : null };
  }
  if (node.__typename === "CheckRun" || typeof node.name === "string") {
    const status = String(node.status ?? "").toUpperCase();
    const conclusion = String(node.conclusion ?? "").toUpperCase();
    const mapped: CheckState = status !== "COMPLETED" ? "pending"
      : conclusion === "SUCCESS" || conclusion === "NEUTRAL" ? "passing"
      : conclusion === "SKIPPED" ? "skipped"
      : FAILING_CONCLUSIONS.has(conclusion) ? "failing" : "pending";
    return { name: String(node.name ?? ""), state: mapped, url: typeof node.detailsUrl === "string" ? node.detailsUrl : null };
  }
  return null;
}

function toChecks(raw: unknown): CheckSummary | null {
  if (!Array.isArray(raw)) return null;
  const checks = raw.map(toCheck).filter((check): check is CheckRun => check !== null);
  if (checks.length === 0) return null;
  const count = (state: CheckState) => checks.filter((check) => check.state === state).length;
  const failing = count("failing");
  const pending = count("pending");
  const passing = count("passing");
  return { state: failing ? "failing" : pending ? "pending" : "passing", passing, failing, pending, checks };
}

function toPullSummary(raw: unknown): PullSummary | null {
  const p = asRecord(raw);
  if (!p || typeof p.number !== "number") return null;
  const state = String(p.state ?? "open").toLowerCase();
  const review = String(p.reviewDecision ?? "").toUpperCase();
  const mergeable = String(p.mergeable ?? "").toUpperCase();
  return {
    number: p.number,
    title: typeof p.title === "string" ? p.title : "",
    author: String(asRecord(p.author)?.login ?? ""),
    url: typeof p.url === "string" ? p.url : "",
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft: p.isDraft === true,
    baseBranch: typeof p.baseRefName === "string" ? p.baseRefName : "",
    headSha: typeof p.headRefOid === "string" ? p.headRefOid : "",
    reviewDecision: review === "APPROVED" ? "approved" : review === "CHANGES_REQUESTED" ? "changes_requested"
      : review === "REVIEW_REQUIRED" ? "review_required" : null,
    unresolvedThreads: null,
    comments: null,
    checks: toChecks(p.statusCheckRollup),
    mergeable: mergeable === "MERGEABLE" ? "mergeable" : mergeable === "CONFLICTING" ? "conflicting" : "unknown",
  };
}

const PULL_FIELDS = "number,title,author,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup";

const COUNTS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    comments{ totalCount }
    reviewThreads(first:100,after:$after){ totalCount pageInfo{ hasNextPage endCursor } nodes{ isResolved } }
  } } }`;

/** Conversation-comment and unresolved-thread counts; null for both when GraphQL could not answer. */
async function readCounts(repoRoot: string, number: number, gh: GhRunner): Promise<{ comments: number | null; unresolvedThreads: number | null }> {
  let comments: number | null = null;
  let unresolved = 0;
  let after: string | null = null;
  try {
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const args = ["api", "graphql", "-f", `query=${COUNTS_QUERY}`, "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${number}`];
      if (after) args.push("-f", `after=${after}`);
      const { stdout } = await gh(args, { cwd: repoRoot });
      const pr = asRecord(asRecord(asRecord(asRecord(JSON.parse(stdout))?.data)?.repository)?.pullRequest);
      if (!pr) throw new Error("gh returned unexpected output");
      const total = asRecord(pr.comments)?.totalCount;
      if (typeof total === "number") comments = total;
      const threads = asRecord(pr.reviewThreads);
      const nodes = Array.isArray(threads?.nodes) ? threads.nodes : [];
      unresolved += nodes.filter((node) => asRecord(node)?.isResolved === false).length;
      const info = asRecord(threads?.pageInfo);
      if (info?.hasNextPage !== true || typeof info.endCursor !== "string") break;
      after = info.endCursor;
    }
  } catch {
    return { comments: null, unresolvedThreads: null };
  }
  return { comments, unresolvedThreads: unresolved };
}

/** The PR whose head is `branch`. gh would read a numeric name as a PR number, so the head is verified. */
async function readPull(repoRoot: string, branch: string, gh: GhRunner): Promise<PullResult> {
  let stdout: string;
  try {
    ({ stdout } = await gh(["pr", "view", branch, "--json", PULL_FIELDS], { cwd: repoRoot }));
  } catch (err) {
    if (ghSaysNoSuchPull(err)) return { pull: null, pullError: null };
    return { pull: null, pullError: ghFailureReason(err) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  if (asRecord(parsed)?.headRefName !== branch) return { pull: null, pullError: null };
  const pull = toPullSummary(parsed);
  if (!pull) return { pull: null, pullError: "gh returned unexpected output" };
  const counts = await readCounts(repoRoot, pull.number, gh);
  return { pull: { ...pull, ...counts }, pullError: null };
}

async function cachedPull(repoRoot: string, branch: string, gh: GhRunner, now: number, bypass: boolean): Promise<PullResult> {
  // gh has no `--` separator: a name that looks like a flag cannot be looked up safely.
  if (branch.startsWith("-")) return { pull: null, pullError: null };
  const key = `${repoRoot}|${branch}`;
  const hit = pullCache.get(key);
  if (hit && !bypass && hit.expires > now) return { pull: hit.pull, pullError: hit.pullError };
  const result = await readPull(repoRoot, branch, gh);
  pullCache.set(key, { ...result, expires: now + PULL_CACHE_MS });
  return result;
}

/** Whether `git merge-tree --write-tree` (git 2.38+) is available; probed once per process. */
function supportsMergeTree(repoRoot: string): Promise<boolean> {
  mergeTreeSupport ??= gitMaybe(repoRoot, ["--version"]).then((out) => {
    const match = /(\d+)\.(\d+)/.exec(out ?? "");
    if (!match) return false;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    return major > 2 || (major === 2 && minor >= 38);
  });
  return mergeTreeSupport;
}

async function mergeCheck(repoRoot: string, base: string, headSha: string, pull: PullSummary | null): Promise<ConflictSummary> {
  const baseRef = `origin/${base}`;
  const baseSha = (await gitMaybe(repoRoot, ["rev-parse", "--verify", "-q", `${baseRef}^{commit}`]))?.trim();
  if (!baseSha) return { status: "unknown", base, reason: `${baseRef} does not exist locally; fetch to compare.` };
  if (!(await supportsMergeTree(repoRoot))) {
    if (!pull) return { status: "unknown", base, reason: "git 2.38 or newer is needed for the local conflict check" };
    if (pull.mergeable === "mergeable") return { status: "clean", base, source: "github" };
    if (pull.mergeable === "conflicting") return { status: "conflicts", base, source: "github", files: [] };
    return { status: "unknown", base, reason: "GitHub has not computed mergeability yet" };
  }
  // Already merged (or nothing to merge): trivially clean.
  if (baseSha === headSha || await gitMaybe(repoRoot, ["merge-base", "--is-ancestor", headSha, baseSha]) !== null) {
    return { status: "clean", base, source: "local" };
  }
  const result = await gitResult(repoRoot, ["merge-tree", "--write-tree", "--name-only", "--no-messages", baseSha, headSha], MERGE_TREE_TIMEOUT);
  if (result.code === 0) return { status: "clean", base, source: "local" };
  if (result.code === 1) {
    // The tree oid comes first, then one conflicted path per line; a blank line ends the list.
    const lines = result.stdout.split("\n").slice(1);
    const end = lines.indexOf("");
    const files = [...new Set((end === -1 ? lines : lines.slice(0, end)).map((line) => line.trim()).filter(Boolean))];
    return { status: "conflicts", base, source: "local", files };
  }
  return { status: "unknown", base, reason: firstLine(redactCredentials(result.stderr)) || `git merge-tree exited with ${result.code}` };
}

/**
 * Would HEAD merge cleanly into `origin/<base>`? Uses `git merge-tree --write-tree`, which merges in
 * memory and never touches the working tree or index, falling back to GitHub's verdict on older git.
 * Never throws: a timeout or git failure is reported as `unknown`.
 */
async function readConflicts(repoRoot: string, base: string, headSha: string, pull: PullSummary | null): Promise<ConflictSummary> {
  try {
    return await mergeCheck(repoRoot, base, headSha, pull);
  } catch (err) {
    return { status: "unknown", base, reason: firstLine(errorText(err)) || "The conflict check failed." };
  }
}

type ReadOptions = { gh: GhRunner; fetch: boolean; now: () => number; noPullCache: boolean; logCap: number };

async function buildSummary(repoRoot: string, { gh, fetch, now, noPullCache, logCap }: ReadOptions): Promise<GithubSummary> {
  if (fetch) await fetchRepo(repoRoot);
  const fetched = lastFetch(await repoKey(repoRoot));

  const [symbolic, defaultBranch, upstreamName, marks, remote] = await Promise.all([
    gitMaybe(repoRoot, ["symbolic-ref", "-q", "HEAD"]),
    readDefaultBranch(repoRoot),
    gitMaybe(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    readMarks(repoRoot),
    gitMaybe(repoRoot, ["remote", "get-url", "origin"]),
  ]);
  const ref = symbolic?.trim() ?? "";
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  const detached = branch === null;
  const upstream = detached ? null : upstreamName?.trim() || null;
  let ahead = 0;
  let behind = 0;
  if (upstream && marks.headSha) {
    const counts = (await gitMaybe(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))?.trim().split(/\s+/);
    if (counts?.length === 2) [ahead, behind] = [Number(counts[0]) || 0, Number(counts[1]) || 0];
  }
  const repoUrl = remote ? githubRepoUrl(remote) : null;

  const { pull, pullError } = branch === null ? { pull: null, pullError: null } : await cachedPull(repoRoot, branch, gh, now(), fetch || noPullCache);

  const base = (pull?.state === "open" && pull.baseBranch) || defaultBranch;
  let logBase: string | null = null;
  let commits: CommitRow[] = [];
  let cursor: string | null = null;
  let conflicts: ConflictSummary | null = null;
  if (marks.headSha && (detached || !base || branch === base)) {
    ({ commits, cursor } = await logPage(repoRoot, { start: marks.headSha, skip: 0, exclude: null }, marks));
  } else if (marks.headSha && base) {
    const baseSha = (await gitMaybe(repoRoot, ["rev-parse", "--verify", "-q", `origin/${base}^{commit}`]))?.trim();
    if (baseSha) {
      logBase = `origin/${base}`;
      ({ commits, cursor } = await logPage(repoRoot, { start: marks.headSha, skip: 0, exclude: baseSha }, marks, logCap));
    } else {
      ({ commits, cursor } = await logPage(repoRoot, { start: marks.headSha, skip: 0, exclude: null }, marks));
    }
    conflicts = await readConflicts(repoRoot, base, marks.headSha, pull);
  } else if (!detached && base && branch !== base) {
    conflicts = { status: "unknown", base, reason: "The branch has no commits yet." };
  }

  return {
    branch, detached, defaultBranch, upstream, ahead, behind,
    fetchedAt: fetched.fetchedAt, fetchError: fetched.fetchError,
    repoUrl, logBase, commits, cursor, pull, pullError, conflicts, at: now(),
  };
}

/**
 * Everything the GitHub panel shows for the project at `dir`. The git half is always read fresh; the gh
 * half is cached for a minute per branch (bypassed with `fetch`). Concurrent calls for one directory
 * share a single read. With `fetch`, `git fetch origin --prune` runs first (throttled by `fetchRepo`).
 * `logCap` (the first page's own-commit limit) and `noPullCache` exist for tests and the pull.
 */
export function readGithubSummary(dir: string, opts: { gh?: GhRunner; fetch?: boolean; now?: () => number; noPullCache?: boolean; logCap?: number } = {}): Promise<GithubSummary> {
  const options: ReadOptions = {
    gh: opts.gh ?? defaultGh, fetch: opts.fetch === true, now: opts.now ?? Date.now,
    noPullCache: opts.noPullCache === true, logCap: opts.logCap ?? DEFAULT_BRANCH_LOG_CAP,
  };
  const key = `${dir}|${options.fetch ? "fetch" : "read"}|${options.noPullCache ? "fresh" : "cached"}|${options.logCap}`;
  const running = summariesInFlight.get(key);
  if (running) return running;
  const run = repoRootOf(dir)
    .then((repoRoot) => buildSummary(repoRoot, options))
    .finally(() => summariesInFlight.delete(key));
  summariesInFlight.set(key, run);
  return run;
}

/** git's refusal from the first `fatal:`/`error:` line on, without the fetch progress that precedes it. */
function gitRefusal(err: unknown): string {
  const message = errorText(err);
  const lines = message.split("\n");
  const start = lines.findIndex((line) => /^(fatal|error):/.test(line));
  return start > 0 ? lines.slice(start).join("\n") : message;
}

/**
 * `git pull --ff-only` in the checkout at `dir`; git's own refusal (diverged, dirty tree, no upstream)
 * becomes a 409. Afterwards the repository is fetched (pruned) and the summary re-read with fresh gh answers.
 */
export async function pullFastForward(dir: string, opts: { gh?: GhRunner } = {}): Promise<GithubSummary> {
  const repoRoot = await repoRootOf(dir);
  try {
    await git(dir, ["pull", "--ff-only"], SLOW_TIMEOUT);
  } catch (err) {
    throw new WorktreeError(gitRefusal(err), 409);
  }
  await fetchRepo(repoRoot, { minIntervalMs: 0 });
  return readGithubSummary(dir, { gh: opts.gh, fetch: false, noPullCache: true });
}

/** One page of history from an opaque `cursor` handed out by a summary or an earlier page. */
export async function readCommitPage(dir: string, cursor: string): Promise<CommitPage> {
  const parsed = parseCursor(cursor);
  if (!parsed) throw new WorktreeError("before must be a log cursor from a previous page.", 400);
  const repoRoot = await repoRootOf(dir);
  const start = (await gitMaybe(repoRoot, ["rev-parse", "--verify", "-q", `${parsed.start}^{commit}`]))?.trim();
  if (!start) throw new WorktreeError(`Commit ${parsed.start} does not exist.`, 404);
  const exclude = parsed.exclude ? (await gitMaybe(repoRoot, ["rev-parse", "--verify", "-q", `${parsed.exclude}^{commit}`]))?.trim() : null;
  if (parsed.exclude && !exclude) throw new WorktreeError(`Commit ${parsed.exclude} does not exist.`, 404);
  return logPage(repoRoot, { start, skip: parsed.skip, exclude: exclude ?? null }, await readMarks(repoRoot));
}
