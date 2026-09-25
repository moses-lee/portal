/**
 * Jobs, runs, and intents in Postgres (`jobs`, `job_runs`, `intents`). Claims are single statements
 * (`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`), so two workers, in this process or
 * another, never lease the same job. Records are stripped of U+0000 before they are written.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Intent, Job, JobRun, JobSchedule } from "@portal/contracts/jobs";
import type { Db } from "../../db/client.ts";
import { stripNul } from "../../db/sanitize.ts";
import { intents, jobRuns, jobs } from "../../db/schema.ts";
import { newId } from "../store.ts";
import type { Scope } from "../types.ts";
import {
  type JobsStore, MAX_RUNS, buildIntent, buildJob, cappedRun, clampRunLimit, patchIntent, patchJob, unknownIntent, unknownJob,
} from "./store.ts";

type Json = Record<string, unknown>;
type JobRow = typeof jobs.$inferSelect;
type RunRow = typeof jobRuns.$inferSelect;
type IntentRow = typeof intents.$inferSelect;

/** Inserting runs prunes the table once every this many. */
const PRUNE_EVERY = 100;

export const jobFromRow = (row: JobRow): Job => ({
  id: row.id, kind: row.kind as Job["kind"], title: row.title, schedule: row.schedule as unknown as JobSchedule, payload: row.payload,
  status: row.status as Job["status"], nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt, lastRunId: row.lastRunId, intentId: row.intentId,
  threadId: row.threadId, createdBy: row.createdBy as Job["createdBy"], failures: row.failures, createdAt: row.createdAt, updatedAt: row.updatedAt,
});

/** The columns of a job (without the lease). */
export const jobColumns = (job: Job) => ({
  kind: job.kind, title: job.title, schedule: job.schedule as unknown as Json, payload: job.payload, status: job.status, nextRunAt: job.nextRunAt,
  lastRunAt: job.lastRunAt, lastRunId: job.lastRunId, intentId: job.intentId, threadId: job.threadId, createdBy: job.createdBy,
  failures: job.failures, createdAt: job.createdAt, updatedAt: job.updatedAt,
});

export const runFromRow = (row: RunRow): JobRun => ({
  id: row.id, jobId: row.jobId, kind: row.kind as JobRun["kind"], threadId: row.threadId, parentRunId: row.parentRunId,
  status: row.status as JobRun["status"], trigger: row.trigger as JobRun["trigger"], startedAt: row.startedAt, finishedAt: row.finishedAt,
  model: row.model as JobRun["model"], usage: row.usage as JobRun["usage"], log: row.log, result: row.result as JobRun["result"],
  summary: row.summary, error: row.error,
});

export const runColumns = (run: JobRun) => ({
  jobId: run.jobId, kind: run.kind, threadId: run.threadId, parentRunId: run.parentRunId, status: run.status, trigger: run.trigger,
  startedAt: run.startedAt, finishedAt: run.finishedAt, model: run.model as Json | null, usage: run.usage as Json | null, log: run.log,
  result: run.result as Json | null, summary: run.summary, error: run.error,
});

export const intentFromRow = (row: IntentRow): Intent => ({
  id: row.id, text: row.text, trigger: row.trigger, action: row.action, notes: row.notes, scope: row.scope as unknown as Scope,
  status: row.status as Intent["status"], expiresAt: row.expiresAt, fireBudget: row.fireBudget, fires: row.fires, cooldownMs: row.cooldownMs,
  lastFiredAt: row.lastFiredAt, lastCheckedAt: row.lastCheckedAt, threadId: row.threadId, createdAt: row.createdAt, updatedAt: row.updatedAt,
});

export const intentColumns = (intent: Intent) => ({
  text: intent.text, trigger: intent.trigger, action: intent.action, notes: intent.notes, scope: intent.scope as unknown as Json,
  status: intent.status, expiresAt: intent.expiresAt, fireBudget: intent.fireBudget, fires: intent.fires, cooldownMs: intent.cooldownMs,
  lastFiredAt: intent.lastFiredAt, lastCheckedAt: intent.lastCheckedAt, threadId: intent.threadId, createdAt: intent.createdAt, updatedAt: intent.updatedAt,
});

const jobOrder = [sql`${jobs.nextRunAt} asc nulls last`, desc(jobs.createdAt), asc(jobs.id)];
const unleased = (t: number) => or(isNull(jobs.lockedUntil), lte(jobs.lockedUntil, t));

export function createPgJobsStore({ db, now = Date.now }: { db: Db; now?: () => number }): JobsStore {
  let inserted = 0;

  async function readJob(id: string): Promise<Job | null> {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    return row ? jobFromRow(row) : null;
  }

  async function requireJob(id: string): Promise<Job> {
    const job = await readJob(id);
    if (!job) throw unknownJob(id);
    return job;
  }

  async function readIntent(id: string): Promise<Intent | null> {
    const [row] = await db.select().from(intents).where(eq(intents.id, id));
    return row ? intentFromRow(row) : null;
  }

  async function insertJob(job: Job): Promise<boolean> {
    const rows = await db.insert(jobs).values({ id: job.id, ...jobColumns(stripNul(job)), lockedUntil: null }).onConflictDoNothing().returning({ id: jobs.id });
    return rows.length > 0;
  }

  async function pruneRuns(keep = MAX_RUNS) {
    const cutoff = db.select({ startedAt: jobRuns.startedAt }).from(jobRuns).orderBy(desc(jobRuns.startedAt)).offset(keep).limit(1);
    const removed = await db.delete(jobRuns).where(and(ne(jobRuns.status, "running"), lte(jobRuns.startedAt, sql`(${cutoff})`))).returning({ id: jobRuns.id });
    return removed.length;
  }

  return {
    ready: Promise.resolve(),

    async createJob(input) {
      let job = stripNul(buildJob(input, input.id ?? newId(), now()));
      while (!(await insertJob(job))) {
        if (input.id) throw Object.assign(new Error(`A job "${input.id}" already exists.`), { status: 409 });
        job = { ...job, id: newId() };
      }
      return job;
    },
    async ensureJob(input) {
      const job = stripNul(buildJob(input, input.id, now()));
      if (await insertJob(job)) return { job, created: true };
      return { job: await requireJob(input.id), created: false };
    },
    getJob: readJob,
    async listJobs(filter = {}) {
      const where: SQL[] = [];
      if (filter.status) where.push(filter.status.length ? inArray(jobs.status, filter.status) : sql`false`);
      if (filter.kind) where.push(filter.kind.length ? inArray(jobs.kind, filter.kind) : sql`false`);
      if (filter.intentId !== undefined) where.push(eq(jobs.intentId, filter.intentId));
      const rows = await db.select().from(jobs).where(where.length ? and(...where) : undefined).orderBy(...jobOrder);
      return rows.map(jobFromRow);
    },
    async updateJob(id, changes) {
      const job = stripNul(patchJob(await requireJob(id), changes, now()));
      await db.update(jobs).set(jobColumns(job)).where(eq(jobs.id, id));
      return job;
    },
    async claimDue({ limit, leaseMs, exclude = [] }) {
      if (limit <= 0) return [];
      const t = now();
      const due = db.select({ id: jobs.id }).from(jobs)
        .where(and(
          eq(jobs.status, "active"), isNotNull(jobs.nextRunAt), lte(jobs.nextRunAt, t), unleased(t),
          ...(exclude.length ? [notInArray(jobs.id, exclude)] : []),
        ))
        .orderBy(asc(jobs.nextRunAt), asc(jobs.id)).limit(limit)
        .for("update", { skipLocked: true });
      const rows = await db.update(jobs).set({ lockedUntil: t + leaseMs }).where(inArray(jobs.id, due)).returning();
      return rows.map(jobFromRow).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0) || (a.id < b.id ? -1 : 1));
    },
    async claimJob(id, leaseMs) {
      const t = now();
      const [row] = await db.update(jobs).set({ lockedUntil: t + leaseMs })
        .where(and(eq(jobs.id, id), eq(jobs.status, "active"), unleased(t))).returning();
      return row ? jobFromRow(row) : null;
    },
    async renewLeases(ids, leaseMs) {
      if (ids.length === 0) return;
      await db.update(jobs).set({ lockedUntil: now() + leaseMs }).where(and(inArray(jobs.id, ids), isNotNull(jobs.lockedUntil)));
    },
    async release(id, changes) {
      const job = stripNul(patchJob(await requireJob(id), changes, now()));
      await db.update(jobs).set({ ...jobColumns(job), lockedUntil: null }).where(eq(jobs.id, id));
      return job;
    },
    async nextDue(filter = {}) {
      const [row] = await db.select().from(jobs)
        .where(and(
          eq(jobs.status, "active"), isNotNull(jobs.nextRunAt), unleased(now()),
          filter.notKinds?.length ? notInArray(jobs.kind, filter.notKinds) : undefined,
        ))
        .orderBy(asc(jobs.nextRunAt), asc(jobs.id)).limit(1);
      return row ? jobFromRow(row) : null;
    },
    async pruneJobs(before) {
      const removed = await db.delete(jobs).where(and(inArray(jobs.status, ["done", "cancelled"]), lt(jobs.updatedAt, before))).returning({ id: jobs.id });
      return removed.length;
    },

    async insertRun(raw) {
      let run = stripNul(cappedRun(raw));
      while ((await db.insert(jobRuns).values({ id: run.id, ...runColumns(run) }).onConflictDoNothing().returning({ id: jobRuns.id })).length === 0) {
        run = { ...run, id: newId() };
      }
      if (++inserted % PRUNE_EVERY === 0) await pruneRuns().catch((err: unknown) => console.error("Could not prune old runs:", err));
      return run;
    },
    async updateRun(raw) {
      const run = stripNul(cappedRun(raw));
      await db.update(jobRuns).set(runColumns(run)).where(eq(jobRuns.id, run.id));
    },
    async getRun(id) {
      const [row] = await db.select().from(jobRuns).where(eq(jobRuns.id, id));
      return row ? runFromRow(row) : null;
    },
    async listRuns(filter = {}) {
      const where: SQL[] = [];
      if (filter.jobId !== undefined) where.push(eq(jobRuns.jobId, filter.jobId));
      if (filter.threadId !== undefined) where.push(eq(jobRuns.threadId, filter.threadId));
      if (filter.kind !== undefined) where.push(eq(jobRuns.kind, filter.kind));
      if (filter.notKinds?.length) where.push(notInArray(jobRuns.kind, filter.notKinds));
      if (filter.status) where.push(filter.status.length ? inArray(jobRuns.status, filter.status) : sql`false`);
      if (filter.before) {
        const [cursor] = await db.select({ startedAt: jobRuns.startedAt }).from(jobRuns).where(eq(jobRuns.id, filter.before));
        if (!cursor) return [];
        const older = or(lt(jobRuns.startedAt, cursor.startedAt), and(eq(jobRuns.startedAt, cursor.startedAt), lt(jobRuns.id, filter.before)));
        if (older) where.push(older);
      }
      const rows = await db.select().from(jobRuns).where(where.length ? and(...where) : undefined)
        .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id)).limit(clampRunLimit(filter.limit));
      return rows.map(runFromRow);
    },
    pruneRuns,

    async createIntent(input) {
      let intent = stripNul(buildIntent(input, input.id ?? newId(), now()));
      while ((await db.insert(intents).values({ id: intent.id, ...intentColumns(intent) }).onConflictDoNothing().returning({ id: intents.id })).length === 0) {
        if (input.id) throw Object.assign(new Error(`An intent "${input.id}" already exists.`), { status: 409 });
        intent = { ...intent, id: newId() };
      }
      return intent;
    },
    getIntent: readIntent,
    async listIntents(filter = {}) {
      const where = filter.status ? (filter.status.length ? inArray(intents.status, filter.status) : sql`false`) : undefined;
      const rows = await db.select().from(intents).where(where).orderBy(desc(intents.createdAt), desc(intents.id));
      return rows.map(intentFromRow);
    },
    async updateIntent(id, changes) {
      const current = await readIntent(id);
      if (!current) throw unknownIntent(id);
      const intent = stripNul(patchIntent(current, changes, now()));
      await db.update(intents).set(intentColumns(intent)).where(eq(intents.id, id));
      return intent;
    },
  };
}
