/**
 * Persistence for jobs, runs, and intents: the interface both backends implement, the record rules
 * they share (validation, building and patching records), and the in-memory backend that tests and
 * disposable runtimes use. `pg-store.ts` is the live one; one behaviour test runs against both.
 *
 * Claiming is the store's job so it can be atomic: a claimed job carries a lease (`locked_until`)
 * until its worker releases it with the next run time. A worker that died loses its claim once the
 * lease runs out, and the job becomes claimable again.
 */
import type { Intent, IntentStatus, Job, JobKind, JobRun, JobSchedule, JobStatus, RunKind, RunStatus } from "@portal/contracts/jobs";
import { httpError } from "../ops.ts";
import { newId, normalizeScope } from "../store.ts";
import type { Scope } from "../types.ts";

/** Runs kept: the newest, whatever their job. */
export const MAX_RUNS = 5000;
/** Runs a listing returns unless asked for fewer; and at most. */
export const DEFAULT_RUN_LIMIT = 50;
export const MAX_RUN_LIMIT = 200;
/** Lines a run's log keeps, and characters per line. */
export const MAX_RUN_LOG_LINES = 200;
export const MAX_RUN_LOG_LINE = 500;
/** Longest job title, in characters. */
export const MAX_TITLE = 200;

export const jobKinds: readonly JobKind[] = ["tick", "intent_check", "helper", "consolidate"];
export const jobStatuses: readonly JobStatus[] = ["active", "paused", "done", "cancelled", "failed"];
export const intentStatuses: readonly IntentStatus[] = ["active", "done", "cancelled", "expired"];
export const runKinds: readonly RunKind[] = ["chat", ...jobKinds];
export const runStatuses: readonly RunStatus[] = ["running", "succeeded", "failed", "cancelled", "awaiting_approval"];

export type NewJob = {
  /** A fixed id (the seeded "tick" job, a migrated check job); a fresh short id otherwise. */
  id?: string;
  kind: JobKind;
  title: string;
  schedule: JobSchedule;
  payload?: Record<string, unknown>;
  status?: JobStatus;
  nextRunAt: number | null;
  intentId?: string | null;
  threadId?: string | null;
  createdBy: Job["createdBy"];
};

export type JobChanges = Partial<Pick<Job, "title" | "schedule" | "payload" | "status" | "nextRunAt" | "lastRunAt" | "lastRunId" | "failures" | "threadId">>;

export type JobFilter = { status?: JobStatus[]; kind?: JobKind[]; intentId?: string };

export type RunFilter = {
  jobId?: string;
  threadId?: string;
  kind?: RunKind;
  status?: RunStatus[];
  /** Runs older than this run (the next page). */
  before?: string;
  limit?: number;
};

export type NewIntent = {
  id?: string;
  text: string;
  trigger: string;
  action: string;
  notes?: string;
  scope?: Partial<Scope>;
  status?: IntentStatus;
  expiresAt?: number | null;
  fireBudget?: number | null;
  cooldownMs?: number;
  threadId?: string | null;
  lastCheckedAt?: number | null;
};

export type IntentChanges = Partial<Omit<Intent, "id" | "createdAt" | "updatedAt">>;

export interface JobsStore {
  ready: Promise<void>;

  createJob(input: NewJob): Promise<Job>;
  /** Insert the job with its fixed id unless one exists; either way answer the stored job. */
  ensureJob(input: NewJob & { id: string }): Promise<{ job: Job; created: boolean }>;
  getJob(id: string): Promise<Job | null>;
  /** By next run (unscheduled last), then newest first. */
  listJobs(filter?: JobFilter): Promise<Job[]>;
  updateJob(id: string, changes: JobChanges): Promise<Job>;
  /** Lease up to `limit` active jobs due now that nobody holds, soonest first; `exclude` are skipped. */
  claimDue(options: { limit: number; leaseMs: number; exclude?: string[] }): Promise<Job[]>;
  /** Lease one active job whether or not it is due (run now); null when it is not active or someone holds it. */
  claimJob(id: string, leaseMs: number): Promise<Job | null>;
  /** Push the leases of jobs still running forward. */
  renewLeases(ids: string[], leaseMs: number): Promise<void>;
  /** Apply `changes` and drop the lease. */
  release(id: string, changes: JobChanges): Promise<Job>;
  /** The active, unleased job that runs soonest. */
  nextDue(): Promise<Job | null>;
  /** Delete done and cancelled jobs last changed before `before`; answers how many went. */
  pruneJobs(before: number): Promise<number>;

  /** Stores a new run; answers it as stored (its id is re-rolled on a collision). */
  insertRun(run: JobRun): Promise<JobRun>;
  updateRun(run: JobRun): Promise<void>;
  getRun(id: string): Promise<JobRun | null>;
  /** Newest first. */
  listRuns(filter?: RunFilter): Promise<JobRun[]>;
  /** Drop finished runs beyond the newest `keep`; answers how many went. */
  pruneRuns(keep?: number): Promise<number>;

  createIntent(input: NewIntent): Promise<Intent>;
  getIntent(id: string): Promise<Intent | null>;
  /** Newest first. */
  listIntents(filter?: { status?: IntentStatus[] }): Promise<Intent[]>;
  updateIntent(id: string, changes: IntentChanges): Promise<Intent>;
}

// ---------------------------------------------------------------------------------------------
// Record rules (shared by the backends)
// ---------------------------------------------------------------------------------------------

export const unknownJob = (id: string) => httpError(`Unknown job "${id}".`, 404);
export const unknownIntent = (id: string) => httpError(`Unknown intent "${id}".`, 404);

function title(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) throw httpError("A job needs a title.", 400);
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
}

export function buildJob(input: NewJob, id: string, at: number): Job {
  if (!jobKinds.includes(input.kind)) throw httpError(`Unknown job kind "${input.kind}".`, 400);
  const status = input.status ?? "active";
  if (!jobStatuses.includes(status)) throw httpError(`Unknown job status "${status}".`, 400);
  return {
    id, kind: input.kind, title: title(input.title), schedule: input.schedule, payload: input.payload ?? {}, status,
    nextRunAt: status === "active" ? input.nextRunAt : null, lastRunAt: null, lastRunId: null, intentId: input.intentId ?? null,
    threadId: input.threadId ?? null, createdBy: input.createdBy, failures: 0, createdAt: at, updatedAt: at,
  };
}

export function patchJob(current: Job, changes: JobChanges, at: number): Job {
  const next: Job = { ...current, ...changes, updatedAt: Math.max(at, current.updatedAt) };
  if (changes.title !== undefined) next.title = title(changes.title);
  if (!jobStatuses.includes(next.status)) throw httpError(`Unknown job status "${next.status}".`, 400);
  // Only an active job is scheduled.
  if (next.status !== "active") next.nextRunAt = null;
  return next;
}

/** A run as stored: the log capped. */
export function cappedRun(run: JobRun): JobRun {
  const log = run.log.slice(-MAX_RUN_LOG_LINES).map((line) => (line.length > MAX_RUN_LOG_LINE ? `${line.slice(0, MAX_RUN_LOG_LINE - 1)}…` : line));
  return { ...run, log };
}

export function clampRunLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RUN_LIMIT;
  return Math.max(1, Math.min(MAX_RUN_LIMIT, Math.floor(limit)));
}

function text(value: string, what: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw httpError(`An intent needs ${what}.`, 400);
  if (trimmed.length > max) throw httpError(`An intent's ${what} is at most ${max} characters.`, 400);
  return trimmed;
}

function checkIntent(intent: Intent): Intent {
  if (!intentStatuses.includes(intent.status)) throw httpError(`Unknown intent status "${intent.status}".`, 400);
  if (intent.fireBudget !== null && (!Number.isSafeInteger(intent.fireBudget) || intent.fireBudget < 1)) throw httpError("fireBudget is a positive whole number or null.", 400);
  if (!Number.isSafeInteger(intent.cooldownMs) || intent.cooldownMs < 0) throw httpError("cooldownMs is a whole number of milliseconds, at least 0.", 400);
  if (intent.expiresAt !== null && !Number.isSafeInteger(intent.expiresAt)) throw httpError("expiresAt is epoch ms or null.", 400);
  return intent;
}

export function buildIntent(input: NewIntent, id: string, at: number): Intent {
  return checkIntent({
    id, text: text(input.text, "text", 2000), trigger: text(input.trigger, "trigger", 1000), action: text(input.action, "action", 1000),
    notes: input.notes ?? "", scope: normalizeScope(input.scope), status: input.status ?? "active", expiresAt: input.expiresAt ?? null,
    fireBudget: input.fireBudget === undefined ? 1 : input.fireBudget, fires: 0, cooldownMs: input.cooldownMs ?? 0, lastFiredAt: null,
    lastCheckedAt: input.lastCheckedAt ?? null, threadId: input.threadId ?? null, createdAt: at, updatedAt: at,
  });
}

export function patchIntent(current: Intent, changes: IntentChanges, at: number): Intent {
  const next: Intent = { ...current, ...changes, updatedAt: Math.max(at, current.updatedAt) };
  if (changes.text !== undefined) next.text = text(changes.text, "text", 2000);
  if (changes.trigger !== undefined) next.trigger = text(changes.trigger, "trigger", 1000);
  if (changes.action !== undefined) next.action = text(changes.action, "action", 1000);
  if (changes.scope !== undefined) next.scope = normalizeScope(changes.scope);
  return checkIntent(next);
}

/** Jobs by next run (unscheduled last), then newest first. */
export function compareJobs(a: Job, b: Job): number {
  if (a.nextRunAt !== b.nextRunAt) {
    if (a.nextRunAt === null) return 1;
    if (b.nextRunAt === null) return -1;
    return a.nextRunAt - b.nextRunAt;
  }
  return b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);
}

/** Runs newest first; the id breaks ties so paging is stable. */
export function compareRuns(a: JobRun, b: JobRun): number {
  return b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

// ---------------------------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------------------------

type Leased = { job: Job; lockedUntil: number | null };

export function createMemoryJobsStore({ now = Date.now }: { now?: () => number } = {}): JobsStore {
  const jobs = new Map<string, Leased>();
  const runs = new Map<string, JobRun>();
  const intents = new Map<string, Intent>();

  function requireJob(id: string): Leased {
    const entry = jobs.get(id);
    if (!entry) throw unknownJob(id);
    return entry;
  }

  function requireIntent(id: string): Intent {
    const intent = intents.get(id);
    if (!intent) throw unknownIntent(id);
    return intent;
  }

  const free = (entry: Leased, t: number) => entry.lockedUntil === null || entry.lockedUntil <= t;

  async function pruneRuns(keep = MAX_RUNS) {
    const finished = [...runs.values()].sort(compareRuns);
    let removed = 0;
    for (const run of finished.slice(keep)) {
      if (run.status === "running") continue;
      runs.delete(run.id);
      removed++;
    }
    return removed;
  }

  return {
    ready: Promise.resolve(),

    async createJob(input) {
      const id = input.id ?? newId((candidate) => jobs.has(candidate));
      if (jobs.has(id)) throw httpError(`A job "${id}" already exists.`, 409);
      const job = buildJob(input, id, now());
      jobs.set(id, { job, lockedUntil: null });
      return job;
    },
    async ensureJob(input) {
      const existing = jobs.get(input.id);
      if (existing) return { job: existing.job, created: false };
      const job = buildJob(input, input.id, now());
      jobs.set(job.id, { job, lockedUntil: null });
      return { job, created: true };
    },
    async getJob(id) {
      return jobs.get(id)?.job ?? null;
    },
    async listJobs(filter = {}) {
      return [...jobs.values()].map((entry) => entry.job).filter((job) =>
        (!filter.status || filter.status.includes(job.status)) && (!filter.kind || filter.kind.includes(job.kind))
        && (filter.intentId === undefined || job.intentId === filter.intentId)).sort(compareJobs);
    },
    async updateJob(id, changes) {
      const entry = requireJob(id);
      entry.job = patchJob(entry.job, changes, now());
      return entry.job;
    },
    async claimDue({ limit, leaseMs, exclude = [] }) {
      const t = now();
      const due = [...jobs.values()]
        .filter((entry) => entry.job.status === "active" && entry.job.nextRunAt !== null && entry.job.nextRunAt <= t && free(entry, t) && !exclude.includes(entry.job.id))
        .sort((a, b) => compareJobs(a.job, b.job))
        .slice(0, Math.max(0, limit));
      for (const entry of due) entry.lockedUntil = t + leaseMs;
      return due.map((entry) => entry.job);
    },
    async claimJob(id, leaseMs) {
      const entry = jobs.get(id);
      const t = now();
      if (!entry || entry.job.status !== "active" || !free(entry, t)) return null;
      entry.lockedUntil = t + leaseMs;
      return entry.job;
    },
    async renewLeases(ids, leaseMs) {
      const until = now() + leaseMs;
      for (const id of ids) {
        const entry = jobs.get(id);
        if (entry && entry.lockedUntil !== null) entry.lockedUntil = until;
      }
    },
    async release(id, changes) {
      const entry = requireJob(id);
      entry.job = patchJob(entry.job, changes, now());
      entry.lockedUntil = null;
      return entry.job;
    },
    async nextDue() {
      const t = now();
      return [...jobs.values()]
        .filter((entry) => entry.job.status === "active" && entry.job.nextRunAt !== null && free(entry, t))
        .map((entry) => entry.job).sort(compareJobs)[0] ?? null;
    },
    async pruneJobs(before) {
      let removed = 0;
      for (const [id, entry] of jobs) {
        if ((entry.job.status === "done" || entry.job.status === "cancelled") && entry.job.updatedAt < before) {
          jobs.delete(id);
          removed++;
        }
      }
      return removed;
    },

    async insertRun(raw) {
      let run = cappedRun(raw);
      while (runs.has(run.id)) run = { ...run, id: newId() };
      runs.set(run.id, run);
      if (runs.size > MAX_RUNS) await pruneRuns();
      return run;
    },
    async updateRun(run) {
      runs.set(run.id, cappedRun(run));
    },
    async getRun(id) {
      return runs.get(id) ?? null;
    },
    async listRuns(filter = {}) {
      const cursor = filter.before ? runs.get(filter.before) : undefined;
      if (filter.before && !cursor) return [];
      return [...runs.values()]
        .filter((run) => (filter.jobId === undefined || run.jobId === filter.jobId) && (filter.threadId === undefined || run.threadId === filter.threadId)
          && (filter.kind === undefined || run.kind === filter.kind) && (!filter.status || filter.status.includes(run.status))
          && (!cursor || compareRuns(cursor, run) < 0))
        .sort(compareRuns)
        .slice(0, clampRunLimit(filter.limit));
    },
    pruneRuns,

    async createIntent(input) {
      const id = input.id ?? newId((candidate) => intents.has(candidate));
      if (intents.has(id)) throw httpError(`An intent "${id}" already exists.`, 409);
      const intent = buildIntent(input, id, now());
      intents.set(id, intent);
      return intent;
    },
    async getIntent(id) {
      return intents.get(id) ?? null;
    },
    async listIntents(filter = {}) {
      return [...intents.values()].filter((intent) => !filter.status || filter.status.includes(intent.status))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    },
    async updateIntent(id, changes) {
      const intent = patchIntent(requireIntent(id), changes, now());
      intents.set(id, intent);
      return intent;
    },
  };
}
