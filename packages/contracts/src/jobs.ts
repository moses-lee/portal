/**
 * Jobs, runs, and intents: the orchestrator's scheduled background work.
 *
 * A **job** is a row with a schedule; a worker claims due jobs from Postgres (`FOR UPDATE SKIP
 * LOCKED`, woken by LISTEN/NOTIFY, with a polling fallback) and executes them. The seeded `tick`
 * job is Portal's own hourly world refresh: no model, never listed, never changed by anyone. The
 * agent creates the rest (a PR check every two minutes, a helper turn now) and picks their cadence;
 * the nightly curation pass is seeded too.
 *
 * A **run** is one execution of anything that calls a model or does background work: a chat turn,
 * a job firing, a helper sub-turn. Every run records its model and token usage.
 *
 * An **intent** is a standing "when X, do Y" the user gave (it replaces the old watches). It is
 * checked by a job of kind `intent_check` whose cadence the agent picks, fires at most `fireBudget`
 * times with `cooldownMs` between firings, expires at `expiresAt`, and is cancelled explicitly.
 *
 * HTTP surface:
 *   GET    /api/portal/jobs?status=<s>          { jobs }      (Upcoming: active jobs by nextRunAt; never the world refresh)
 *   PATCH  /api/portal/jobs/:id                 body JobPatch -> { job }   (404 for the world refresh)
 *   POST   /api/portal/jobs/:id/run             -> { run }    (run now; the job's schedule is unchanged; 404 for the world refresh)
 *   GET    /api/portal/runs?jobId=&threadId=&kind=&before=&limit=   { runs } (newest first; the world refresh's runs are left out)
 *   GET    /api/portal/runs/:id                 { run }
 *   POST   /api/portal/runs/:id/cancel          -> 204
 *   GET    /api/portal/intents?status=<s>       { intents }
 *   PATCH  /api/portal/intents/:id              body IntentPatch -> { intent }
 * Live: `jobs` (invalidate), `intents` (full list of active ones), and `run` events (none for the world refresh).
 */
import type { ModelChoice, Scope } from "./orchestrator.ts";

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export type JobSchedule =
  /** Every `everyMs`; while no browser is connected, every `idleEveryMs` when given. */
  | { type: "every"; everyMs: number; idleEveryMs?: number }
  /** A five-field cron expression, evaluated in `tz` (IANA, default the server's zone). */
  | { type: "cron"; expr: string; tz?: string }
  /** Once, at `at`; the job is `done` after it ran. */
  | { type: "at"; at: number };

/**
 * - `tick`: the silent world refresh, hourly: rebuild the world (GitHub included), diff it against
 *   the previous snapshot into the change log, release dismissals whose condition cleared, and wake
 *   expired snoozes. No model, no thread post, no items. Hidden from every listing and tool.
 * - `intent_check`: evaluate one intent (`payload.intentId`) and act on it when its trigger holds.
 * - `helper`: a bounded sub-turn (`payload` is a `HelperPayload`), e.g. research or summarizing.
 * - `consolidate`: the memory curation pass (phase 3).
 */
export type JobKind = "tick" | "intent_check" | "helper" | "consolidate";

export type JobStatus = "active" | "paused" | "done" | "cancelled" | "failed";

export type Job = {
  id: string;
  kind: JobKind;
  /** Short, human: "Check owner/name#42 until merged". */
  title: string;
  schedule: JobSchedule;
  payload: Record<string, unknown>;
  status: JobStatus;
  /** When the worker should next claim it; null when not scheduled (paused, done, cancelled). */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunId: string | null;
  intentId: string | null;
  /** Where the job reports: messages it posts go to this thread (the main thread when null). */
  threadId: string | null;
  createdBy: "system" | "agent" | "user";
  /** Consecutive failed runs; the worker backs off and eventually marks the job `failed`. */
  failures: number;
  createdAt: number;
  updatedAt: number;
};

/** What the user may change from the UI (pause/resume/cancel, reschedule). */
export type JobPatch = Partial<Pick<Job, "status" | "schedule" | "title">>;

/** Payload of a `helper` job. */
export type HelperPayload = {
  /** The instruction for the sub-turn, written by the agent. */
  prompt: string;
  /** Which model role runs it (default "chat"). */
  role?: "chat" | "bookkeeping";
  /** Tool names the helper may use; defaults to the read-only set. Gated tools still need approval. */
  tools?: string[];
  /** Step cap for the sub-turn (default 12, at most 24). */
  maxSteps?: number;
  /** Post the helper's final text to its job's thread when done (default true). */
  report?: boolean;
};

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export type RunKind = "chat" | JobKind;
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "awaiting_approval";
/** What started a run. */
export type RunTrigger = "user" | "schedule" | "manual" | "agent" | "approval";

export type RunUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};

export type JobRun = {
  id: string;
  /** Null for chat turns. */
  jobId: string | null;
  kind: RunKind;
  threadId: string | null;
  /** The run that started this one (a helper started from a chat turn). */
  parentRunId: string | null;
  status: RunStatus;
  trigger: RunTrigger;
  startedAt: number;
  finishedAt: number | null;
  /** Null when no model was called (the world refresh, a deterministic check). */
  model: ModelChoice | null;
  usage: RunUsage | null;
  /** One line per step worth auditing, capped. */
  log: string[];
  /** Kind-specific outcome, e.g. the world refresh's report of what it diffed. */
  result: Record<string, unknown> | null;
  /** One or two sentences for the Activity and Upcoming views. */
  summary: string | null;
  error: string | null;
};

// ---------------------------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------------------------

export type IntentStatus = "active" | "done" | "cancelled" | "expired";

export type Intent = {
  id: string;
  /** What the user asked for, in their words: "monitor #42 until it merges". */
  text: string;
  /** The condition that makes it fire, stated precisely by the agent: "PR owner/name#42 is merged or closed". */
  trigger: string;
  /** What to do when it fires: "tell me, then remove the worktree after I approve". */
  action: string;
  /** The agent's evolving understanding and plan (Markdown); rewritten as things progress. */
  notes: string;
  /** What the intent is about; drives memory retrieval and links in the UI. */
  scope: Scope;
  status: IntentStatus;
  expiresAt: number | null;
  /** Firings left before the intent is done; null for unlimited. */
  fireBudget: number | null;
  fires: number;
  /** Least time between two firings. */
  cooldownMs: number;
  lastFiredAt: number | null;
  /** The last firing's title: the server refuses a firing that only repeats it. */
  lastFiredTitle: string | null;
  lastCheckedAt: number | null;
  /** The thread it was created from and reports to. */
  threadId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** The UI may only cancel (or re-activate) an intent; the agent edits the rest through tools. */
export type IntentPatch = Partial<Pick<Intent, "status">>;
