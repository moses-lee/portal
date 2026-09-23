import type { GitInfo } from "./git-info.ts";
import type { BranchInfo, BranchListing, PullInfo } from "./types.ts";

/** What the start page's worktree picker holds; Start turns anything but `original` into a worktree. */
export type WorktreeChoice =
  | { kind: "original" }
  /**
   * An existing local or remote branch; `path` is the worktree it is already checked out in, when
   * known, else `repoWorktreesDir` is where the server will create one.
   */
  | { kind: "branch"; branch: string; pull?: PullInfo; path?: string; repoWorktreesDir?: string }
  | { kind: "create"; branch: string; repoWorktreesDir?: string };

export const ORIGINAL: WorktreeChoice = { kind: "original" };

export type PickerRow =
  | { kind: "original" }
  | { kind: "pull"; pull: PullInfo }
  | { kind: "branch"; branch: BranchInfo }
  | { kind: "create"; name: string };

export type RankOptions = {
  /** Offer "Create branch <query>" when nothing matches it exactly. */
  canCreate: boolean;
  /** A PR-number lookup is still in flight: hold the create row until it answers. */
  pullLookupPending?: boolean;
};

/** How many open PRs and recent branches the empty-query view shows. */
export const MAX_SECTION_ROWS = 10;

export function isPullNumberQuery(query: string) {
  return /^\d+$/.test(query.trim());
}

/**
 * Cheap client-side check that `name` could be a branch name, so the picker does not offer to
 * create something git will refuse. The server runs `git check-ref-format` for the real answer.
 */
export function isProbablyRefName(name: string) {
  if (!name || name === "@") return false;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return true;
}

/** The folder name a branch gets under `worktrees/<repo>/`; mirrors the server's rule. */
export function sanitizeBranchForPath(branch: string) {
  return branch.replace(/[^A-Za-z0-9._-]/g, "-");
}

function basename(directory: string) {
  return directory.split("/").filter(Boolean).at(-1) ?? directory;
}

/** Where Portal creates worktrees unless the server says otherwise (`BranchListing.repoWorktreesDir`). */
export const DEFAULT_WORKTREES_DIR = "~/.portal/worktrees";

/**
 * Display path of the worktree Portal would create for `branch`: under `repoWorktreesDir` when the
 * server has named the repository's folder, else the default guessed from `repoRoot`'s name (which
 * is only the repository name for the main checkout, not for a worktree).
 */
export function plannedWorktreePath(repoRoot: string, branch: string, repoWorktreesDir?: string) {
  const dir = repoWorktreesDir ?? `${DEFAULT_WORKTREES_DIR}/${basename(repoRoot)}`;
  return `${dir}/${sanitizeBranchForPath(branch)}`;
}

/** Shorten `absolute` with `~` the way the server shortened `sample.path` into `sample.displayPath`. */
export function shortenHome(absolute: string, sample: { path: string; displayPath: string }) {
  if (!sample.displayPath.startsWith("~")) return absolute;
  const home = sample.path.slice(0, sample.path.length - (sample.displayPath.length - 1));
  if (!home) return absolute;
  if (absolute === home) return "~";
  return absolute.startsWith(home + "/") ? "~" + absolute.slice(home.length) : absolute;
}

/**
 * Where a session started with `choice` would run: the existing worktree when the picker knows it,
 * else the planned folder, plus the project's subfolder inside its repository. Null for Original.
 */
export function worktreeTarget(
  project: { path: string; displayPath: string; git: GitInfo },
  choice: WorktreeChoice,
): { displayPath: string; branch: string } | null {
  if (choice.kind === "original" || !project.git) return null;
  const root = project.git.root;
  const subpath = project.path.startsWith(root + "/") ? project.path.slice(root.length) : "";
  const folder = choice.kind === "branch" && choice.path
    ? shortenHome(choice.path, project)
    : plannedWorktreePath(root, choice.branch, choice.repoWorktreesDir);
  return { displayPath: folder + subpath, branch: choice.branch };
}

function pullFields(pull: PullInfo) {
  return [`#${pull.number}`, String(pull.number), pull.title, pull.branch].map((s) => s.toLowerCase());
}

/**
 * Rows for the worktree picker. Empty query: Original, then open PRs and recent branches (capped,
 * branches already shown through a PR omitted). Otherwise prefix matches before substring matches,
 * PRs before branches within a tier, a PR looked up by number pinned first, and a "create" row last.
 */
export function rankPickerRows(
  listing: BranchListing | null,
  query: string,
  lookedUpPull: PullInfo | null,
  opts: RankOptions,
): PickerRow[] {
  const q = query.trim();
  const pulls = listing?.pulls ?? [];
  const branches = listing?.branches ?? [];

  if (!q) {
    const rows: PickerRow[] = [{ kind: "original" }];
    const shownPulls = [...pulls].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SECTION_ROWS);
    const viaPull = new Set(shownPulls.map((pull) => pull.branch));
    for (const pull of shownPulls) rows.push({ kind: "pull", pull });
    const recent = branches.filter((branch) => !viaPull.has(branch.name)).sort((a, b) => b.committedAt - a.committedAt);
    for (const branch of recent.slice(0, MAX_SECTION_ROWS)) rows.push({ kind: "branch", branch });
    return rows;
  }

  const lower = q.toLowerCase();
  const pinned = lookedUpPull && (String(lookedUpPull.number) === q || `#${lookedUpPull.number}` === q) ? lookedUpPull : null;
  const prefixPulls: PullInfo[] = [];
  const partialPulls: PullInfo[] = [];
  for (const pull of pulls) {
    if (pinned && pull.number === pinned.number) continue;
    const fields = pullFields(pull);
    if (fields.some((f) => f.startsWith(lower))) prefixPulls.push(pull);
    else if (fields.some((f) => f.includes(lower))) partialPulls.push(pull);
  }
  const viaPull = new Set([...(pinned ? [pinned] : []), ...prefixPulls, ...partialPulls].map((pull) => pull.branch));
  const prefixBranches: BranchInfo[] = [];
  const partialBranches: BranchInfo[] = [];
  for (const branch of branches) {
    if (viaPull.has(branch.name)) continue;
    const name = branch.name.toLowerCase();
    if (name.startsWith(lower)) prefixBranches.push(branch);
    else if (name.includes(lower)) partialBranches.push(branch);
  }

  const rows: PickerRow[] = [];
  if (pinned) rows.push({ kind: "pull", pull: pinned });
  for (const pull of prefixPulls) rows.push({ kind: "pull", pull });
  for (const branch of prefixBranches) rows.push({ kind: "branch", branch });
  for (const pull of partialPulls) rows.push({ kind: "pull", pull });
  for (const branch of partialBranches) rows.push({ kind: "branch", branch });

  // A number that resolved to a PR is that PR, not a branch to create.
  const exact = pinned !== null
    || listing?.defaultBranch === q
    || rows.some((row) => (row.kind === "pull" ? row.pull.branch : row.kind === "branch" ? row.branch.name : "") === q);
  if (opts.canCreate && !opts.pullLookupPending && !exact) rows.push({ kind: "create", name: q });
  return rows;
}
