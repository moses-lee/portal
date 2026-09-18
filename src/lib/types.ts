import type {
  AvailableCommand,
  PermissionOption,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { GitInfo } from "./git-info";

export type AgentInfo = { id: string; name: string };

/** Marks a project as a git worktree Portal created for `branch` under the `parentId` project. */
export type WorktreeMeta = { parentId: string; branch: string };

/** A folder the user added to Portal. Every session belongs to one and starts in its `path`. */
export type Project = {
  id: string;
  name: string;
  /** Absolute, realpath'd directory. */
  path: string;
  createdAt: number;
  /** Present when this project is a worktree of another project. */
  worktree?: WorktreeMeta;
};

/** One branch of a project's repository, merged across the local branch and `origin/<name>`. */
export type BranchInfo = {
  /** Short name, e.g. "feat/foo". */
  name: string;
  local: boolean;
  remote: boolean;
  /** Epoch ms of the latest commit across the local and remote tips. */
  committedAt: number;
  /** Absolute path of the worktree (or main checkout) where the branch is checked out, else null. */
  worktreePath: string | null;
};

/** A GitHub pull request as reported by `gh`. */
export type PullInfo = {
  number: number;
  title: string;
  /** Head branch name. */
  branch: string;
  state: "open" | "closed" | "merged";
  /** Epoch ms. */
  updatedAt: number;
  /** True for cross-repository (fork) PRs, which Portal cannot check out. */
  fork: boolean;
};

/** Response of `GET /api/projects/<id>/branches`. */
export type BranchListing = {
  /** From `origin/HEAD`, falling back to main then master; null when none exist. */
  defaultBranch: string | null;
  /** Every local and origin branch except the default, newest commit first. */
  branches: BranchInfo[];
  /** Open PRs newest-updated first, or null when `gh` could not answer. */
  pulls: PullInfo[] | null;
  /** Short reason when `pulls` is null. */
  pullsError: string | null;
  /** Display path of the folder Portal creates this repository's worktrees under, e.g. "~/.portal/worktrees/portal". */
  repoWorktreesDir: string;
};

/** Project as served to the browser, with presentation and the folder's current state. */
export type ProjectSummary = Project & {
  displayPath: string;
  git: GitInfo;
  /** False when the folder no longer exists on the host. */
  exists: boolean;
};

/** One row of `GET /api/fs/dirs`. */
export type DirEntry = { name: string; path: string; isGitRepo: boolean };

/** Response of `GET /api/fs/dirs`. */
export type DirListing = { path: string; parent: string | null; entries: DirEntry[] };

/**
 * Agent-side session state announced over ACP. Replaced wholesale whenever the agent
 * sends `current_mode_update`, `config_option_update`, or `available_commands_update`,
 * or answers `session/set_config_option` / `session/set_mode`.
 */
export type SessionState = {
  /** Session modes from `session/new`; null when the agent exposes none. */
  modes: SessionModeState | null;
  /** Config options (mode, model, thought level, …) from `session/new` and later updates. */
  configOptions: SessionConfigOption[];
  /** Slash commands and skills the agent currently accepts, as pushed by the agent. */
  commands: AvailableCommand[];
};

/**
 * Whether Portal currently holds a live ACP session for this conversation. Persisted sessions
 * start `offline` after a server restart and become `live` once `session/resume` succeeds.
 */
export type SessionLink =
  | { status: "live" }
  | { status: "connecting" }
  | { status: "offline"; error: string | null };

export type SessionMeta = {
  id: string;
  agentId: string;
  agentName: string;
  cwd: string;
  /** Portal metadata only; never sent over ACP. Empty for sessions created without a project. */
  projectId: string;
  createdAt: number;
  /** Epoch ms of the last user prompt (or creation). Drives sidebar order. */
  lastActiveAt: number;
  /** First user prompt, trimmed; null until the first message. */
  title: string | null;
  busy: boolean;
  link: SessionLink;
  state: SessionState;
};

/** Session metadata as served to the browser, with the directory's current git state. */
export type SessionSummary = SessionMeta & {
  displayCwd: string;
  git: GitInfo;
  /** The owning project, or null when it has since been removed. */
  project: { id: string; name: string } | null;
  /** True when `cwd` no longer exists on the host. */
  cwdMissing: boolean;
};

/** Payload of the SSE `meta` event on `/api/sessions/[id]/stream`. */
export type SessionMetaEvent = {
  busy: boolean;
  link: SessionLink;
  title: string | null;
  cwd: string;
  agentId: string;
  agentName: string;
  git: GitInfo;
  state: SessionState;
  project: { id: string; name: string } | null;
  cwdMissing: boolean;
};

export type PortalEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "user"; text: string }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason: StopReason }
  /** The agent asked for permission; the request stays open until a `permission_response` with the same `requestId`. */
  | { type: "permission_request"; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  /** A viewer answered (`selected`), or the request was cancelled by Stop, agent failure, or the turn ending. */
  | { type: "permission_response"; requestId: string; outcome: "selected"; optionId: string; optionName: string }
  | { type: "permission_response"; requestId: string; outcome: "cancelled" }
  | { type: "error"; message: string };

/** A logged event with its position in the session's log (dense from 0) and epoch ms timestamp. */
export type StoredEvent = PortalEvent & { seq: number; ts: number };

/** Response of `GET /api/sessions/[id]/events`: one page of the log, oldest first. */
export type EventPage = {
  events: StoredEvent[];
  /** True when events exist before `events[0]`; fetch them with `?before=<events[0].seq>`. */
  hasMore: boolean;
  /** Sequence number the next appended event will get; `events.at(-1).seq + 1` for the latest page. */
  nextSeq: number;
};

/** Body of `POST /api/sessions/[id]/config`. */
export type SetConfigRequest =
  | { configId: string; value: string | boolean }
  | { modeId: string };

/** Body of `POST /api/sessions/[id]/permission`. `optionId: null` cancels the request. */
export type PermissionAnswerRequest = { requestId: string; optionId: string | null };

/** One row of the GitHub panel's commit log. */
export type CommitRow = {
  sha: string;
  /** Abbreviated sha, e.g. "72b845f". */
  short: string;
  subject: string;
  author: string;
  /** Epoch ms of the committer date. */
  committedAt: number;
  /** True for the local HEAD commit. */
  head: boolean;
  /** True for the commit the branch's upstream (`origin/<branch>`) points at. */
  remoteHead: boolean;
  /** True for the merge-base row that anchors the branch's own commits to the base branch. */
  base: boolean;
};

/** Response of `GET /api/projects/<id>/github/log?before=<cursor>`: one page further back in history. */
export type CommitPage = {
  commits: CommitRow[];
  /** Opaque cursor to pass back as `before` for the next page, or null when there is nothing older. */
  cursor: string | null;
};

export type CheckState = "passing" | "failing" | "pending" | "skipped";

/** One CI check or commit status from the PR's status rollup. */
export type CheckRun = {
  name: string;
  state: CheckState;
  url: string | null;
};

/** The PR head's CI status, from `gh pr view --json statusCheckRollup`. */
export type CheckSummary = {
  /** Worst state across `checks`: failing beats pending beats passing. */
  state: "passing" | "failing" | "pending";
  passing: number;
  failing: number;
  pending: number;
  checks: CheckRun[];
};

/** The pull request whose head is the panel's branch, in any state. */
export type PullSummary = {
  number: number;
  title: string;
  /** GitHub login of the author. */
  author: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  /** Sha of the PR head as GitHub knows it; the matching commit row shows the CI dot. */
  headSha: string;
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  /** Unresolved review threads, or null when the GraphQL lookup failed. */
  unresolvedThreads: number | null;
  /** Issue (conversation) comments, excluding review comments; null when unknown. */
  comments: number | null;
  /** Null when the PR has no checks. */
  checks: CheckSummary | null;
  /** GitHub's own merge verdict, used for conflicts when the local check is unavailable. */
  mergeable: "mergeable" | "conflicting" | "unknown";
};

/** Whether the branch merges cleanly into its base (the PR base, else the default branch). */
export type ConflictSummary =
  | { status: "clean"; base: string; source: "local" | "github" }
  | { status: "conflicts"; base: string; source: "local" | "github"; files: string[] }
  | { status: "unknown"; base: string | null; reason: string };

/** Response of `GET /api/projects/<id>/github`: everything the sidebar's GitHub panel shows. */
export type GithubSummary = {
  /** Checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** From `origin/HEAD`, falling back to main then master; null when none exist. */
  defaultBranch: string | null;
  /** `origin/<name>` the branch tracks, or null when it has no upstream ("not published"). */
  upstream: string | null;
  /** Commits on HEAD that the upstream lacks. 0 without an upstream. */
  ahead: number;
  /** Commits on the upstream that HEAD lacks. 0 without an upstream. */
  behind: number;
  /** Epoch ms of the last `git fetch` Portal ran for this repository, or null when it never has. */
  fetchedAt: number | null;
  /** git's message when the last fetch failed; null after a success. */
  fetchError: string | null;
  /** `https://github.com/<owner>/<name>` from the origin URL, or null when origin is not GitHub. */
  repoUrl: string | null;
  /** The ref the log is relative to (`origin/<base>`), or null when `commits` is just HEAD's history. */
  logBase: string | null;
  /**
   * Newest first. With `logBase`, the branch's own commits followed by the merge-base row; a branch with
   * more own commits than fit on the first page defers the merge-base row to the page that reaches it.
   */
  commits: CommitRow[];
  /** Opaque cursor to pass to `/github/log?before=` for older commits, or null when there is nothing older. */
  cursor: string | null;
  /** The branch's PR, or null when there is none or gh could not answer (see `pullError`). */
  pull: PullSummary | null;
  /** Short reason when gh could not answer, e.g. "gh is not logged in"; null when it simply found no PR. */
  pullError: string | null;
  /** Null on a detached HEAD or when there is no base to compare against. */
  conflicts: ConflictSummary | null;
  /** Epoch ms when this snapshot was taken. */
  at: number;
};
