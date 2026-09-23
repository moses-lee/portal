/**
 * World state: a generated, never curated model of everything the user can see in Portal
 * (projects and the repos behind them, worktrees, sessions, terminals, pull requests, and the
 * orchestrator's own intents, jobs, and open items). It is rebuilt on every tick and on demand,
 * rendered into roughly 1–2k tokens at the top of every prompt, and snapshotted for diffing and
 * auditing. The resolve helpers turn loose references ("PR 2367", "the monorepo", "the review
 * session") into ids deterministically, so the model never guesses.
 *
 * HTTP surface:
 *   GET  /api/portal/world            { world, rendered, tokens }   (the latest; built when none exists yet)
 *   POST /api/portal/world/refresh    { world, rendered, tokens }   (rebuild now)
 * Live: `{ type: "world", at }` after each rebuild.
 */
import type { ItemKind, PullAttention, PullRef, TickSnapshot } from "./orchestrator.ts";

export type WorldProject = {
  id: string;
  name: string;
  path: string;
  /** "owner/name" of the GitHub origin, when there is one. */
  repo: string | null;
  defaultBranch: string | null;
  /** Set for worktree projects. */
  worktree: { parentId: string; branch: string; dirty: boolean | null; merged: boolean | null } | null;
  /** The folder is gone. */
  missing: boolean;
  /** Current branch of the checkout, when known. */
  branch: string | null;
};

export type WorldSession = {
  id: string;
  title: string | null;
  projectId: string;
  agentId: string;
  agentName: string;
  activity: "idle" | "working" | "waiting" | "connecting" | "error";
  link: "live" | "connecting" | "offline";
  createdAt: number;
  lastActiveAt: number;
};

export type WorldTerminal = {
  id: string;
  cwd: string;
  /** The project whose folder contains `cwd`, when one does. */
  projectId: string | null;
  title: string | null;
};

/** A repository Portal knows, with every project checked out from it. */
export type WorldRepo = {
  repo: string;
  defaultBranch: string | null;
  /** The main checkout first, then worktrees. */
  projectIds: string[];
};

export type WorldState = {
  at: number;
  login: string | null;
  projects: WorldProject[];
  repos: WorldRepo[];
  sessions: WorldSession[];
  terminals: WorldTerminal[];
  /** Open PRs the user authored or was asked to review, plus ones that closed since the last build. */
  pulls: PullAttention[];
  intents: { id: string; text: string; status: string; lastCheckedAt: number | null }[];
  jobs: { id: string; kind: string; title: string; nextRunAt: number | null }[];
  items: { id: string; kind: ItemKind; title: string; status: string }[];
  /** Sources that could not be read this time (their previous slice was kept). */
  errors: string[];
  /** The slice the tick diffs (the digest's input), carried so one build serves both. */
  snapshot: TickSnapshot;
};

export type WorldResponse = { world: WorldState; rendered: string; tokens: number };

/** What `resolve_pull` answers: the PR, the repo it belongs to, and where Portal has it checked out. */
export type ResolvedPull = PullRef & {
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  /** The main checkout of the repo, when Portal has one. */
  projectId: string | null;
  /** A worktree already on the PR's head branch, when one exists. */
  worktreeProjectId: string | null;
};

/** A resolve answer: exactly one match, or the candidates to ask the user about. */
export type Resolution<T> =
  | { match: T; candidates?: undefined }
  | { match: null; candidates: T[]; reason: string };
