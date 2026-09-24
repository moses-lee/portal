/**
 * The orchestrator hub: one object that holds everything the orchestrator's parts share (store,
 * settings, deps, clock, presence, event emitter) and the domain services built on them
 * (activity, jobs, world, memory, approvals); `turn.ts` builds model turns over it. It follows the AppContext pattern: services
 * are attached in order and read their siblings from the hub at call time, never at construction,
 * so the order they are built in does not matter and tests can swap any one of them.
 *
 * The interfaces below are the integration surface the runtime and the turn runner rely on. A
 * domain may offer more (its routes and tools use it), but these methods must keep their meaning.
 */
import type { LanguageModel, Tool } from "ai";
import type { Approval } from "@portal/contracts/approvals";
import type { Intent, IntentPatch, Job, JobKind, JobRun, JobSchedule, JobStatus, RunKind, RunStatus, RunTrigger, RunUsage } from "@portal/contracts/jobs";
import type { CoreDocument, MemoryEntity, MemoryRecord } from "@portal/contracts/memory";
import type { WorldState } from "@portal/contracts/world";
import type { Sql } from "postgres";
import type { Db } from "../db/client.ts";
import type { ActivityService } from "./activity/service.ts";
import type { OrchestratorDeps, OrchestratorSettingsStore } from "./deps.ts";
import type { ProviderOptions } from "./model.ts";
import type { SchedulerTimers } from "./jobs/timers.ts";
import type { ToolContext } from "./tools/context.ts";
import type { Item, ItemAction, ModelChoice, ModelRole, OrchestratorEvent, OrchestratorStore, Scope, TickReason, TickReport } from "./types.ts";

export type ToolSet = Record<string, Tool>;

export type PresenceSource = { count(): number; subscribe(listener: (count: number) => void): () => void };

/** A role's model, ready to call: what the settings chose and the key the settings store holds. */
export type ResolvedModel = { role: ModelRole; choice: ModelChoice; model: LanguageModel; providerOptions?: ProviderOptions };

/** What a turn is, for the tools that need to know (which run to attribute to, which thread to report in). */
export type TurnInfo = {
  runId: string;
  kind: RunKind;
  role: ModelRole;
  /** "chat" when the user is in the loop (a chat turn); "job" for background work nobody is watching. */
  origin: "chat" | "job";
  threadId: string | null;
  jobId: string | null;
  intentId: string | null;
  /** What the turn is about; memory retrieval narrows to it. */
  scope: Scope;
};

/** What domain tool factories receive: the classic tool context plus the hub and the turn. */
export type DomainToolContext = ToolContext & { hub: OrchestratorHub; turn: TurnInfo };

// ---------------------------------------------------------------------------------------------
// Domain services (integration surface)
// ---------------------------------------------------------------------------------------------

export type RunStart = {
  kind: RunKind;
  trigger: RunTrigger;
  jobId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  model?: ModelChoice | null;
  summary?: string | null;
};

export type RunOutcome = {
  status: Exclude<RunStatus, "running">;
  model?: ModelChoice | null;
  usage?: RunUsage | null;
  log?: string[];
  result?: JobRun["result"];
  summary?: string | null;
  error?: string | null;
};

/** A new intent as the tools (and setup_pr_reviews) ask for it: what to watch, and how often to check. */
export type IntentInput = Pick<Intent, "text" | "trigger" | "action"> & Partial<Pick<Intent, "notes" | "expiresAt" | "fireBudget" | "cooldownMs" | "threadId">> & {
  scope?: Partial<Scope>;
  check: JobSchedule;
  /** Check right away instead of one interval from now. */
  checkNow?: boolean;
  /** The model that checks it (default bookkeeping). */
  role?: ModelRole;
  /**
   * Extra fields for the check job's payload. A `review` or `pull` watch there makes the check
   * deterministic (see `jobs/review-watch.ts` and `jobs/pull-watch.ts`) instead of a model turn.
   */
  checkPayload?: Record<string, unknown>;
};

export interface JobsService {
  ready: Promise<void>;
  /** Start the worker loop (called once the whole hub is built). */
  start(): void;
  dispose(): Promise<void>;
  /** Record the start of a run of any kind (chat turns included); emits a `run` event. */
  startRun(input: RunStart): Promise<JobRun>;
  finishRun(id: string, outcome: RunOutcome): Promise<JobRun>;
  /** Runs in progress in this process, oldest first; synchronous for the status line. */
  running(): JobRun[];
  /** The next active job due, for the status line. */
  nextDue(): Promise<Job | null>;
  /**
   * Run a job now, outside its schedule (the Upcoming view's "Run now", or an approved call
   * resuming the job that asked for it). Null when the job does not exist or is not active.
   */
  runNow(jobId: string, trigger: RunTrigger): Promise<JobRun | null>;
  /** A job's approval was decided or expired: run it again, put it back on its schedule, or end it. */
  resumeAfterApproval(jobId: string, outcome: "approved" | "denied" | "expired"): Promise<void>;
  listIntents(filter?: { status?: Intent["status"][] }): Promise<Intent[]>;
  /** The job tools (schedule_job, cancel_job, create_intent, cancel_intent, run_helper, ...). */
  tools(ctx: DomainToolContext): ToolSet;

  /** By next run (unscheduled last), then newest first. */
  listJobs(filter?: { status?: JobStatus[]; kind?: JobKind[]; intentId?: string }): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  /** Apply a `JobPatch` (validated here: 400 for a bad one, 404 unknown, 409 when it cannot apply). */
  updateJob(id: string, patch: unknown, actor: "user" | "agent" | "system"): Promise<Job>;
  /** Newest first; `before` is a run id (the next page). */
  listRuns(filter?: { jobId?: string; threadId?: string; kind?: RunKind; status?: RunStatus[]; before?: string; limit?: number }): Promise<JobRun[]>;
  getRun(id: string): Promise<JobRun | null>;
  /** Abort the runs of a job in progress in this process (as cancelling the job does); answers their ids. */
  stopJobRuns(jobId: string): string[];
  /** Stop a job run or an inline helper of this process; false when it is not running here. */
  cancelRun(id: string): Promise<boolean>;
  getIntent(id: string): Promise<Intent | null>;
  /** An intent and the job that checks it. */
  createIntent(input: IntentInput, how: { actor: "user" | "agent" | "system"; runId?: string; threadId?: string | null }): Promise<{ intent: Intent; job: Job }>;
  /** The UI's intent patch: cancel it, or re-activate it. */
  updateIntent(id: string, patch: IntentPatch, actor: "user" | "agent" | "system"): Promise<Intent>;
  /** Run the tick job now and answer its report (a skipped report when a tick is already running). */
  runTick(reason: TickReason): Promise<TickReport>;
  /** The newest tick report (in memory, so synchronous). */
  lastTick(): TickReport | null;
  /** The newest tick reports, newest last. */
  listTicks(limit?: number): Promise<TickReport[]>;
  /** The seeded tick job. */
  tickJob(): Promise<Job | null>;
}

export interface WorldService {
  ready: Promise<void>;
  /** The latest built world, or null before the first build. */
  current(): Promise<WorldState | null>;
  /** Build the world now, store it as the newest snapshot, and emit `world`. */
  refresh(reason: string): Promise<WorldState>;
  /** The world as prompt text within a token budget, the parts about `scope` first. */
  render(world: WorldState, opts?: { budgetTokens?: number; scope?: Scope }): string;
  /** resolve_pull, resolve_repo, resolve_session, get_world, ... */
  tools(ctx: DomainToolContext): ToolSet;
}

export type MemoryPromptContext = {
  /** CORE.md for this turn, generated once and frozen. */
  core: CoreDocument;
  /** Records retrieved for the turn's scope and text, rendered for the prompt ("" when none). */
  retrieved: string;
};

export interface MemoryService {
  ready: Promise<void>;
  /** CORE.md plus scoped retrieval for one turn. */
  promptContext(input: { scope: Scope; query: string; threadId: string | null }): Promise<MemoryPromptContext>;
  /** Proposed records waiting for the user. */
  inboxCount(): Promise<number>;
  /** The active records of each named entity that exists (type and key as written; keys are normalized), entities in the order given. */
  recordsFor(entities: { type: MemoryEntity["type"]; key: string }[]): Promise<{ entity: MemoryEntity; records: MemoryRecord[] }[]>;
  /** Called with the record ids after every change to memory; answers the unsubscribe function. */
  subscribe(listener: (recordIds: string[]) => void): () => void;
  /** remember, propose_memory, search_memory, explain_memory, forget, ... */
  tools(ctx: DomainToolContext): ToolSet;
}

export interface ApprovalsService {
  ready: Promise<void>;
  /** `tools` with the gated ones wrapped: they check grants and ask for approval before running. */
  gate(tools: ToolSet, ctx: DomainToolContext): ToolSet;
  pending(): Promise<Approval[]>;
  /** Whether a run left an approval pending; a job run that did ends as `awaiting_approval`. */
  hasPendingFor(runId: string): Promise<boolean>;
  /**
   * Called before a server-side card action runs. Null lets it run now; an approval means the
   * action waits for it (and runs when it is approved).
   */
  guardAction(item: Item, actionIndex: number, action: ItemAction): Promise<Approval | null>;
}

// ---------------------------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------------------------

export interface OrchestratorHub {
  store: OrchestratorStore;
  settings: OrchestratorSettingsStore;
  deps: OrchestratorDeps;
  presence: PresenceSource;
  timers: SchedulerTimers;
  /** The database in the live server (for Postgres stores, LISTEN/NOTIFY); null with in-memory stores. */
  db: Db | null;
  /** The raw postgres.js client beside `db` (LISTEN/NOTIFY); null with in-memory stores. */
  sql: Sql | null;
  emit(event: OrchestratorEvent): void;
  /** The model for a role, or null when no key is stored for its provider. */
  model(role: ModelRole): Promise<ResolvedModel | null>;
  activity: ActivityService;
  jobs: JobsService;
  world: WorldService;
  memory: MemoryService;
  approvals: ApprovalsService;
}
