import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { displayPath, readGitInfo } from "./git-info.ts";
import type { BranchInfo, PullInfo } from "./types.ts";

const execFileAsync = promisify(execFile);

const LIST_TIMEOUT = 10_000;
const SLOW_TIMEOUT = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** A git or gh step failed in a way the browser should hear about, with its HTTP status. */
export class WorktreeError extends Error {
  status: number;
  /** Set when `git worktree remove` refused because the tree has changes; the UI offers a forced retry. */
  dirty?: boolean;
  constructor(message: string, status: number, dirty?: boolean) {
    super(message);
    this.name = "WorktreeError";
    this.status = status;
    if (dirty) this.dirty = true;
  }
}

/** Runs `gh` with the given arguments; injectable so tests can fake GitHub. */
export type GhRunner = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;

type ExecError = Error & { code?: string | number; stderr?: string; killed?: boolean };

/** git's stderr, a timeout note, or the error's own message. */
export function execMessage(err: unknown): string {
  const e = err as ExecError;
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr;
  if (e?.killed) return "The command timed out.";
  return e instanceof Error ? e.message : String(err);
}

/** Run git in `cwd`; failures become 409s carrying git's own stderr. */
export async function git(cwd: string, args: string[], timeout = LIST_TIMEOUT): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd, timeout, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (err) {
    throw new WorktreeError(execMessage(err), 409);
  }
}

/** Like `git`, but a non-zero exit yields null instead of throwing. */
export async function gitMaybe(cwd: string, args: string[], timeout = LIST_TIMEOUT): Promise<string | null> {
  return git(cwd, args, timeout).catch(() => null);
}

/**
 * Like `git`, but a non-zero exit is reported as `code` with the output git produced, for commands
 * whose exit status carries meaning (e.g. `merge-tree`). Only failing to run git at all throws.
 */
export async function gitResult(cwd: string, args: string[], timeout = LIST_TIMEOUT): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd, timeout, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as ExecError & { stdout?: string };
    if (typeof e?.code === "number" && !e.killed) return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    throw new WorktreeError(execMessage(err), 409);
  }
}

export const defaultGh: GhRunner = (args, { cwd }) => execFileAsync("gh", args, {
  cwd, timeout: 20_000, maxBuffer: MAX_BUFFER,
  env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
});

/** Where Portal creates worktrees: `<PORTAL_HOME or ~/.portal>/worktrees`. */
export function portalWorktreesDir(home = os.homedir()): string {
  return path.join(process.env.PORTAL_HOME || path.join(home, ".portal"), "worktrees");
}

/** Folder name for a branch: `/` and anything outside `[A-Za-z0-9._-]` become `-`. */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** The git root of `dir`, or a 409 when the folder is missing or not in a repository. */
export async function repoRootOf(dir: string): Promise<string> {
  const exists = await stat(dir).then((info) => info.isDirectory(), () => false);
  if (!exists) throw new WorktreeError(`Project folder is missing: ${displayPath(dir)}`, 409);
  const info = await readGitInfo(dir);
  if (!info) throw new WorktreeError("The project is not in a git repository.", 409);
  return info.root;
}

/** The main checkout of the repository that `dir` (a worktree or the main tree itself) belongs to. */
export async function mainWorktreeOf(dir: string): Promise<string> {
  const listing = await git(dir, ["worktree", "list", "--porcelain"]);
  const first = listing.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) throw new WorktreeError("Could not find the main working tree.", 409);
  return first.slice("worktree ".length);
}

type RawBranch = BranchInfo;

type Collected = {
  defaultBranch: string | null;
  /** Every branch, default included. */
  all: Map<string, RawBranch>;
};

/** Branch → path for checkouts that still exist on disk, from `git worktree list --porcelain`. */
async function worktreePaths(repoRoot: string): Promise<Map<string, string>> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const paths = new Map<string, string>();
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const dir = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
    const prunable = lines.some((line) => line === "prunable" || line.startsWith("prunable "));
    if (dir && branch && !prunable) paths.set(branch, dir);
  }
  return paths;
}

async function collectBranches(repoRoot: string): Promise<Collected> {
  const [refs, paths, originHead] = await Promise.all([
    git(repoRoot, ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)%09%(objectname)", "refs/heads", "refs/remotes/origin"]),
    worktreePaths(repoRoot),
    gitMaybe(repoRoot, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
  ]);
  const all = new Map<string, RawBranch>();
  for (const line of refs.split("\n")) {
    if (!line) continue;
    const [refname, date] = line.split("\t");
    let name: string;
    let kind: "local" | "remote";
    if (refname.startsWith("refs/heads/")) {
      name = refname.slice("refs/heads/".length);
      kind = "local";
    } else if (refname.startsWith("refs/remotes/origin/")) {
      name = refname.slice("refs/remotes/origin/".length);
      if (name === "HEAD") continue;
      kind = "remote";
    } else {
      continue;
    }
    const committedAt = Number(date) * 1000;
    const entry = all.get(name) ?? { name, local: false, remote: false, committedAt: 0, worktreePath: paths.get(name) ?? null };
    entry[kind] = true;
    entry.committedAt = Math.max(entry.committedAt, Number.isFinite(committedAt) ? committedAt : 0);
    all.set(name, entry);
  }
  let defaultBranch: string | null = null;
  const head = originHead?.trim();
  if (head?.startsWith("refs/remotes/origin/")) defaultBranch = head.slice("refs/remotes/origin/".length);
  else defaultBranch = ["main", "master"].find((name) => all.has(name)) ?? null;
  return { defaultBranch, all };
}

/** Every local and origin branch of the repository except the default, newest commit first. */
export async function listBranches(repoRoot: string): Promise<{ defaultBranch: string | null; branches: BranchInfo[] }> {
  const { defaultBranch, all } = await collectBranches(repoRoot);
  const branches = [...all.values()]
    .filter((branch) => branch.name !== defaultBranch)
    .sort((a, b) => b.committedAt - a.committedAt || a.name.localeCompare(b.name));
  return { defaultBranch, branches };
}

const PULL_FIELDS = "number,title,headRefName,updatedAt,isCrossRepository,state";

/** Short reason a gh call could not answer, e.g. "gh is not installed" or "gh is not logged in". */
export function ghFailureReason(err: unknown): string {
  const e = err as ExecError;
  if (e?.code === "ENOENT") return "gh is not installed";
  const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
  const lower = stderr.toLowerCase();
  // Checked first: gh's "none of the git remotes ... please use `gh auth login`" would otherwise read as a login problem.
  if (/no git remotes|not a git repository|could not determine|none of the git remotes/.test(lower)) {
    return "origin is not a GitHub repository";
  }
  if (/auth login|not logged/.test(lower)) return "gh is not logged in";
  return stderr.split("\n")[0] || (e instanceof Error ? e.message : String(err)) || "gh failed";
}

/** True when gh's failure means GitHub has no such PR, as opposed to gh being unable to ask. */
export function ghSaysNoSuchPull(err: unknown): boolean {
  const stderr = String((err as ExecError)?.stderr ?? "").toLowerCase();
  return /could not resolve|no pull requests found|not found/.test(stderr);
}

function toPull(raw: unknown): PullInfo | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || typeof p.number !== "number" || typeof p.headRefName !== "string") return null;
  const state = String(p.state ?? "open").toLowerCase();
  const updatedAt = typeof p.updatedAt === "string" ? Date.parse(p.updatedAt) : NaN;
  return {
    number: p.number,
    title: typeof p.title === "string" ? p.title : "",
    branch: p.headRefName,
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    fork: p.isCrossRepository === true,
  };
}

/** Open PRs newest-updated first; `pulls` is null with a short reason when gh cannot answer. */
export async function listPulls(repoRoot: string, gh: GhRunner = defaultGh): Promise<{ pulls: PullInfo[] | null; pullsError: string | null }> {
  let stdout: string;
  try {
    ({ stdout } = await gh(["pr", "list", "--state", "open", "--limit", "100", "--json", PULL_FIELDS], { cwd: repoRoot }));
  } catch (err) {
    return { pulls: null, pullsError: ghFailureReason(err) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  if (!Array.isArray(parsed)) return { pulls: null, pullsError: "gh returned unexpected output" };
  const pulls = parsed.map(toPull).filter((pull): pull is PullInfo => pull !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number);
  return { pulls, pullsError: null };
}

/** One PR by number in any state; 404 when GitHub has no such PR, 409 when gh cannot answer. */
export async function getPull(repoRoot: string, number: number, gh: GhRunner = defaultGh): Promise<PullInfo> {
  let stdout: string;
  try {
    ({ stdout } = await gh(["pr", "view", String(number), "--json", PULL_FIELDS], { cwd: repoRoot }));
  } catch (err) {
    if (ghSaysNoSuchPull(err)) throw new WorktreeError(`PR #${number} not found.`, 404);
    throw new WorktreeError(ghFailureReason(err), 409);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  const pull = toPull(parsed);
  if (!pull) throw new WorktreeError("gh returned unexpected output", 409);
  return pull;
}

/** Reject anything git would not accept as a branch name, or that it would rewrite (e.g. `@{-1}`). */
async function validateBranchName(repoRoot: string, branch: string) {
  const normalized = branch && !branch.startsWith("-") ? await gitMaybe(repoRoot, ["check-ref-format", "--branch", branch]) : null;
  if (normalized?.trim() !== branch) throw new WorktreeError(`"${branch}" is not a valid branch name.`, 400);
}

/**
 * Make sure a directory for `target` can be created: the parent exists and the path is free.
 * A leftover directory that git no longer knows about is reported rather than reused.
 */
async function prepareTarget(repoRoot: string, target: string): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true });
  const real = path.join(await realpath(path.dirname(target)), path.basename(target));
  // Drop registrations whose folders are gone so git lets the branch be checked out again.
  await git(repoRoot, ["worktree", "prune"]);
  if (await stat(real).then(() => true, () => false)) {
    throw new WorktreeError(`${real} already exists but is not a worktree of this repository.`, 409);
  }
  return real;
}

/**
 * Find or create a worktree for `branch` under `worktreesDir/<repo basename>/<sanitized branch>`.
 * With `create`, the branch is started from `origin/<default>`; otherwise an existing checkout of
 * the branch is reused, a local branch is checked out, or an origin-only branch is fetched and tracked.
 */
export async function ensureWorktree({ repoRoot, branch, create = false, worktreesDir = portalWorktreesDir() }: {
  repoRoot: string; branch: string; create?: boolean; worktreesDir?: string;
}): Promise<{ path: string; created: boolean }> {
  await validateBranchName(repoRoot, branch);
  const { defaultBranch, all } = await collectBranches(repoRoot);
  const info = all.get(branch);
  const target = path.join(worktreesDir, path.basename(repoRoot), sanitizeBranchForPath(branch));

  if (create) {
    if (info) throw new WorktreeError(`Branch ${branch} already exists${info.local ? "" : " on origin"}.`, 409);
    if (!defaultBranch) throw new WorktreeError("Could not determine the default branch to start from.", 409);
    await git(repoRoot, ["fetch", "origin", defaultBranch], SLOW_TIMEOUT);
    const dir = await prepareTarget(repoRoot, target);
    await git(repoRoot, ["worktree", "add", "--no-track", "-b", branch, dir, `origin/${defaultBranch}`], SLOW_TIMEOUT);
    return { path: await realpath(dir), created: true };
  }
  if (info?.worktreePath) {
    const existing = await realpath(info.worktreePath).catch(() => null);
    if (existing) return { path: existing, created: false };
  }
  if (info?.local) {
    const dir = await prepareTarget(repoRoot, target);
    await git(repoRoot, ["worktree", "add", dir, branch], SLOW_TIMEOUT);
    return { path: await realpath(dir), created: true };
  }
  if (info?.remote) {
    await git(repoRoot, ["fetch", "origin", branch], SLOW_TIMEOUT);
    const dir = await prepareTarget(repoRoot, target);
    await git(repoRoot, ["worktree", "add", "--track", "-b", branch, dir, `origin/${branch}`], SLOW_TIMEOUT);
    return { path: await realpath(dir), created: true };
  }
  throw new WorktreeError(`Branch ${branch} does not exist.`, 404);
}

/** True when `branch` exists as a local branch or as `origin/<branch>` (exact name, not a prefix). */
export async function hasBranch(repoRoot: string, branch: string): Promise<boolean> {
  const refs = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
  // for-each-ref matches whole path components, so `feat` would also list `feat/sub`; keep exact names only.
  const out = await gitMaybe(repoRoot, ["for-each-ref", "--format=%(refname)", ...refs]);
  return !!out && out.split("\n").some((line) => refs.includes(line.trim()));
}

async function isMergedIntoDefault(repoRoot: string, branch: string): Promise<boolean> {
  const { defaultBranch } = await collectBranches(repoRoot);
  if (!defaultBranch || defaultBranch === branch) return false;
  for (const ref of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    if (await gitMaybe(repoRoot, ["merge-base", "--is-ancestor", branch, ref]) !== null) return true;
  }
  return false;
}

/**
 * Remove a worktree (or prune its registration when the folder is already gone), then delete the
 * local branch only when it is fully merged into the default branch and git agrees (`-d`, never `-D`).
 * A refusal to remove (changes in the tree) is a 409 marked `dirty` so the caller can retry with `force`.
 */
export async function removeWorktree({ repoRoot, path: dir, branch, force = false }: {
  repoRoot: string; path: string; branch: string; force?: boolean;
}): Promise<{ branchDeleted: boolean }> {
  const exists = await stat(dir).then(() => true, () => false);
  if (exists) {
    try {
      await git(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), dir], SLOW_TIMEOUT);
    } catch (err) {
      throw new WorktreeError(err instanceof Error ? err.message : String(err), 409, true);
    }
  } else {
    await git(repoRoot, ["worktree", "prune"]);
  }
  let branchDeleted = false;
  if (branch && await isMergedIntoDefault(repoRoot, branch)) {
    branchDeleted = await gitMaybe(repoRoot, ["branch", "-d", branch]) !== null;
  }
  return { branchDeleted };
}
