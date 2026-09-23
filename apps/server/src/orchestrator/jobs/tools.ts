/**
 * The job tools. A chat turn (or a helper that names them) gets the scheduling set: jobs, runs,
 * intents, helpers, and the schedule. An intent check gets only what acts on its own intent
 * (fire_intent, close_intent, update_intent). The tick and other background turns get none: their
 * tool schemas would be paid for on every step.
 */
import { z } from "zod";
import type { Intent, Job, JobRun, JobSchedule } from "@portal/contracts/jobs";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { httpError } from "../ops.ts";
import { capped, define } from "../tools/context.ts";
import { pullRefSchema } from "../tools/items.ts";
import { TICK_JOB_ID, type JobsCore } from "./core.ts";
import type { createHelpers } from "./helpers.ts";
import { DEFAULT_CHECK_MS, type IntentsPart } from "./intents.ts";
import { MIN_EVERY_MS, describeSchedule, parseSchedule } from "./schedule.ts";

type Helpers = ReturnType<typeof createHelpers>;

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
const NOTES_PREVIEW = 200;

const scopeSchema = z.object({
  projectIds: z.array(z.string()).optional(),
  sessionIds: z.array(z.string()).optional(),
  pulls: z.array(pullRefSchema).optional(),
  repos: z.array(z.string()).optional(),
  people: z.array(z.string()).optional(),
  taskTypes: z.array(z.string()).optional(),
});

/** How the model states a schedule: one of every (minutes), cron, at (ISO time), or inMinutes. */
const scheduleSchema = z.object({
  everyMinutes: z.number().min(1).optional().describe("Run every N minutes."),
  idleEveryMinutes: z.number().min(1).optional().describe("With everyMinutes: the interval while nobody has Portal open."),
  cron: z.string().optional().describe("Five-field cron expression, e.g. \"0 9 * * 1-5\"."),
  tz: z.string().optional().describe("IANA zone for cron, e.g. \"Europe/Berlin\"."),
  at: z.string().optional().describe("Run once at this ISO 8601 time."),
  inMinutes: z.number().min(0).optional().describe("Run once, this many minutes from now."),
});

type ScheduleInput = z.infer<typeof scheduleSchema>;

function toSchedule(input: ScheduleInput, now: number): JobSchedule {
  const given = [input.everyMinutes !== undefined, input.cron !== undefined, input.at !== undefined, input.inMinutes !== undefined].filter(Boolean).length;
  if (given !== 1) throw httpError("Give exactly one of everyMinutes, cron, at, or inMinutes.", 400);
  if (input.everyMinutes !== undefined) {
    return parseSchedule({
      type: "every", everyMs: Math.max(MIN_EVERY_MS, Math.round(input.everyMinutes * 60_000)),
      ...(input.idleEveryMinutes !== undefined ? { idleEveryMs: Math.round(input.idleEveryMinutes * 60_000) } : {}),
    });
  }
  if (input.cron !== undefined) return parseSchedule({ type: "cron", expr: input.cron, ...(input.tz ? { tz: input.tz } : {}) });
  if (input.inMinutes !== undefined) return { type: "at", at: now + Math.round(input.inMinutes * 60_000) };
  const at = Date.parse(input.at as string);
  if (!Number.isFinite(at)) throw httpError(`"${input.at}" is not an ISO 8601 time.`, 400);
  return { type: "at", at };
}

function parseTime(value: string | null | undefined, what: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw httpError(`${what} "${value}" is not an ISO 8601 time.`, 400);
  return at;
}

function jobRow(job: Job) {
  return {
    id: job.id, kind: job.kind, title: job.title, schedule: describeSchedule(job.schedule), status: job.status, nextRunAt: iso(job.nextRunAt),
    lastRunAt: iso(job.lastRunAt), ...(job.failures ? { failures: job.failures } : {}), ...(job.intentId ? { intentId: job.intentId } : {}),
    ...(job.threadId ? { threadId: job.threadId } : {}),
  };
}

function runRow(run: JobRun) {
  return {
    id: run.id, kind: run.kind, ...(run.jobId ? { jobId: run.jobId } : {}), status: run.status, trigger: run.trigger, startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt), summary: run.summary, ...(run.error ? { error: run.error } : {}),
    ...(run.usage ? { tokens: run.usage.inputTokens + run.usage.outputTokens } : {}), ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
  };
}

function intentRow(intent: Intent, preview = false) {
  const notes = preview && intent.notes.length > NOTES_PREVIEW ? `${intent.notes.slice(0, NOTES_PREVIEW)}…` : intent.notes;
  return {
    id: intent.id, text: intent.text, trigger: intent.trigger, action: intent.action, status: intent.status, notes,
    fires: intent.fires, fireBudget: intent.fireBudget, cooldownMinutes: intent.cooldownMs / 60_000, expiresAt: iso(intent.expiresAt),
    lastFiredAt: iso(intent.lastFiredAt), lastCheckedAt: iso(intent.lastCheckedAt), ...(intent.threadId ? { threadId: intent.threadId } : {}),
  };
}

export function jobTools(core: JobsCore, intents: IntentsPart, helpers: Helpers, ctx: DomainToolContext): ToolSet {
  if (ctx.turn.kind === "intent_check") return ctx.turn.intentId ? intentCheckTools(intents, ctx, ctx.turn.intentId) : {};
  if (!ctx.interactive) return {};
  return schedulingTools(core, intents, helpers, ctx);
}

/** In an intent check only: act on that one intent. */
function intentCheckTools(intents: IntentsPart, ctx: DomainToolContext, intentId: string): ToolSet {
  const how = { actor: "agent" as const, runId: ctx.turn.runId };
  return {
    fire_intent: define(
      "The intent's trigger holds: record the firing and put a Needs-you item in front of the user. The server refuses during the cooldown, past the budget, or after expiry; then stop.",
      z.object({ title: z.string().min(1).max(200).describe("One line for the user: what happened."), body: z.string().max(2000).describe("One to three sentences: what you saw, what to do.") }),
      async ({ title, body }) => intents.fire(intentId, { title, body }, { ...how, touched: ctx.touched }),
    ),
    close_intent: define(
      "End this intent: done when it is fulfilled, cancelled when it can never fire or no longer applies.",
      z.object({ status: z.enum(["done", "cancelled"]), reason: z.string().max(500) }),
      async ({ status, reason }) => ({ closed: (await intents.close(intentId, status, { ...how, reason })).status }),
    ),
    update_intent: define(
      "Rewrite this intent's notes: what you saw and what is left. Keep them short.",
      z.object({ notes: z.string().max(4000) }),
      async ({ notes }) => intentRow(await intents.update(intentId, { notes }, how), true),
    ),
  };
}

function schedulingTools(core: JobsCore, intents: IntentsPart, helpers: Helpers, ctx: DomainToolContext): ToolSet {
  const { hub, store, runs } = core;
  const { turn } = ctx;
  const how = { actor: "agent" as const, runId: turn.runId, threadId: turn.threadId };
  const now = () => hub.timers.now();

  const checkSchedule = (input: { checkEveryMinutes?: number; idleCheckEveryMinutes?: number; checkCron?: string; tz?: string }): JobSchedule | undefined => {
    if (input.checkCron !== undefined) return toSchedule({ cron: input.checkCron, tz: input.tz }, now());
    if (input.checkEveryMinutes !== undefined) return toSchedule({ everyMinutes: input.checkEveryMinutes, idleEveryMinutes: input.idleCheckEveryMinutes }, now());
    return undefined;
  };

  const cadence = {
    checkEveryMinutes: z.number().min(1).optional().describe("How often to check the trigger; your choice (e.g. 2 for a PR under active review, 60 for something slow)."),
    idleCheckEveryMinutes: z.number().min(1).optional().describe("The interval while nobody has Portal open."),
    checkCron: z.string().optional().describe("Instead of checkEveryMinutes: a five-field cron expression."),
    tz: z.string().optional(),
  };

  return {
    create_intent: define(
      "Track a standing request of the user (\"tell me when #42 merges\"): text in the user's words, a precise trigger, the action when it fires, and how often to check. A check job evaluates the trigger; firing puts a Needs-you item in front of the user.",
      z.object({
        text: z.string().min(1).max(2000).describe("What the user asked, in their words."),
        trigger: z.string().min(1).max(1000).describe("The exact condition, e.g. \"PR acme/app#42 is merged or closed\"."),
        action: z.string().min(1).max(1000).describe("What to do when it fires, e.g. \"tell me, and offer to remove the worktree\"."),
        scope: scopeSchema.optional(),
        notes: z.string().max(4000).optional().describe("Your plan and what you know so far."),
        expiresAt: z.string().optional().describe("ISO 8601 time after which the intent lapses."),
        fireBudget: z.number().int().min(1).nullable().optional().describe("How many times it may fire (default 1; null for unlimited)."),
        cooldownMinutes: z.number().min(0).optional().describe("Least time between two firings (default 0)."),
        ...cadence,
        checkNow: z.boolean().optional().describe("Run the first check right away instead of after one interval."),
        role: z.enum(["chat", "bookkeeping"]).optional().describe("The model that checks it (default bookkeeping, the cheap one)."),
      }),
      async (input) => {
        const check = checkSchedule(input) ?? { type: "every", everyMs: DEFAULT_CHECK_MS };
        const { intent, job } = await intents.create({
          text: input.text, trigger: input.trigger, action: input.action, scope: input.scope, notes: input.notes,
          expiresAt: parseTime(input.expiresAt, "expiresAt") ?? null, fireBudget: input.fireBudget, cooldownMs: Math.round((input.cooldownMinutes ?? 0) * 60_000),
          threadId: turn.threadId, check, checkNow: input.checkNow, role: input.role,
        }, how);
        return { ...intentRow(intent), checkJob: jobRow(job) };
      },
    ),
    update_intent: define(
      "Change an active intent: its notes (your current understanding), trigger, action, scope, expiry, budget, cooldown, or check cadence.",
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(2000).optional(),
        trigger: z.string().min(1).max(1000).optional(),
        action: z.string().min(1).max(1000).optional(),
        notes: z.string().max(4000).optional(),
        scope: scopeSchema.optional(),
        expiresAt: z.string().nullable().optional().describe("ISO 8601 time, or null for no expiry."),
        fireBudget: z.number().int().min(1).nullable().optional(),
        cooldownMinutes: z.number().min(0).optional(),
        ...cadence,
      }),
      async ({ id, text, trigger, action, notes, scope, expiresAt, fireBudget, cooldownMinutes, ...rest }) => {
        const changes = {
          ...(text !== undefined ? { text } : {}), ...(trigger !== undefined ? { trigger } : {}), ...(action !== undefined ? { action } : {}),
          ...(notes !== undefined ? { notes } : {}), ...(scope !== undefined ? { scope: { ...(await intents.requireIntent(id)).scope, ...scope } } : {}),
          ...(expiresAt !== undefined ? { expiresAt: parseTime(expiresAt, "expiresAt") ?? null } : {}), ...(fireBudget !== undefined ? { fireBudget } : {}),
          ...(cooldownMinutes !== undefined ? { cooldownMs: Math.round(cooldownMinutes * 60_000) } : {}),
        };
        return intentRow(await intents.update(id, changes, { ...how, check: checkSchedule(rest) }));
      },
    ),
    cancel_intent: define(
      "Cancel an intent the user no longer wants (or that can never fire); its check job stops too.",
      z.object({ id: z.string().min(1), reason: z.string().max(500).optional() }),
      async ({ id, reason }) => intentRow(await intents.close(id, "cancelled", { ...how, reason }), true),
    ),
    list_intents: define(
      "Intents by status (default active), newest first.",
      z.object({ status: z.enum(["active", "done", "cancelled", "expired"]).optional() }),
      async ({ status = "active" }) => {
        const { rows, truncated } = capped(await store.listIntents({ status: [status] }));
        return { intents: rows.map((intent) => intentRow(intent, true)), truncated };
      },
    ),
    schedule_job: define(
      "Schedule a helper job: a bounded turn with your prompt that runs on a schedule (every N minutes, cron, or once) and posts its answer to this thread. For conditions to watch, use create_intent instead.",
      z.object({
        title: z.string().min(1).max(200),
        prompt: z.string().min(1).max(8000).describe("The instruction the helper turn gets each time."),
        schedule: scheduleSchema,
        role: z.enum(["chat", "bookkeeping"]).optional(),
        tools: z.array(z.string()).max(40).optional().describe("Tool names the helper may use (default: read-only tools)."),
        maxSteps: z.number().int().min(1).max(24).optional(),
        report: z.boolean().optional().describe("Post the answer to the thread (default true)."),
      }),
      async ({ title, prompt, schedule, role, tools, maxSteps, report }) => {
        return jobRow(await helpers.schedule({ title, prompt, role, tools, maxSteps, report, threadId: turn.threadId, schedule: toSchedule(schedule, now()) }, { ctx }));
      },
    ),
    update_job: define(
      `Reschedule, rename, pause, or resume a job, including the tick ("${TICK_JOB_ID}") whose cadence is yours to choose.`,
      z.object({
        id: z.string().min(1),
        schedule: scheduleSchema.optional(),
        title: z.string().min(1).max(200).optional(),
        status: z.enum(["active", "paused"]).optional(),
      }),
      async ({ id, schedule, title, status }) => {
        const patch = { ...(schedule ? { schedule: toSchedule(schedule, now()) } : {}), ...(title ? { title } : {}), ...(status ? { status } : {}) };
        return jobRow(await core.patchJob(id, patch, { actor: "agent", runId: turn.runId }));
      },
    ),
    cancel_job: define(
      "Cancel a job that is no longer needed. Cancelling an intent's check job cancels the intent.",
      z.object({ id: z.string().min(1) }),
      async ({ id }) => jobRow(await core.patchJob(id, { status: "cancelled" }, { actor: "agent", runId: turn.runId })),
    ),
    list_jobs: define(
      "Jobs by status (default active), soonest first.",
      z.object({ status: z.enum(["active", "paused", "done", "cancelled", "failed"]).optional(), kind: z.enum(["tick", "intent_check", "helper", "consolidate"]).optional() }),
      async ({ status = "active", kind }) => {
        const { rows, truncated } = capped(await store.listJobs({ status: [status], ...(kind ? { kind: [kind] } : {}) }));
        return { jobs: rows.map(jobRow), truncated };
      },
    ),
    list_runs: define(
      "Recent runs (chat turns, ticks, checks, helpers), newest first: status, summary, errors.",
      z.object({ jobId: z.string().optional(), kind: z.enum(["chat", "tick", "intent_check", "helper", "consolidate"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
      async ({ jobId, kind, limit = 10 }) => ({ runs: (await store.listRuns({ jobId, kind, limit })).map(runRow) }),
    ),
    run_helper: define(
      "Start a bounded helper turn for a side task (research, summarizing). wait: true (chat only) runs it now and returns its answer; otherwise it runs in the background and posts its answer to this thread.",
      z.object({
        prompt: z.string().min(1).max(8000),
        role: z.enum(["chat", "bookkeeping"]).optional(),
        tools: z.array(z.string()).max(40).optional().describe("Tool names it may use (default: read-only tools)."),
        maxSteps: z.number().int().min(1).max(24).optional(),
        wait: z.boolean().optional(),
      }),
      async ({ prompt, role, tools, maxSteps, wait }, options) => {
        if (wait && turn.origin === "chat") {
          // Stopping the chat turn stops the helper it is waiting for.
          const { runId, text } = await helpers.runInline(ctx, { prompt, role, tools, maxSteps }, options?.abortSignal);
          return { runId, text };
        }
        const job = await helpers.schedule({ prompt, role, tools, maxSteps }, { ctx, chain: true });
        return { jobId: job.id, scheduled: true, ...(wait ? { note: "Background turns cannot wait; the helper posts its answer to the thread." } : {}) };
      },
    ),
    get_schedule: define(
      "Your schedule: the tick's cadence and next run, whether anyone has Portal open, and the next jobs due.",
      z.object({}),
      async () => {
        const [tick, upcoming, model] = await Promise.all([store.getJob(TICK_JOB_ID), store.listJobs({ status: ["active"] }), hub.model("bookkeeping")]);
        return {
          ready: !!model, presence: hub.presence.count(),
          tick: tick ? { ...jobRow(tick), followsSettings: tick.payload.followsSettings !== false } : null,
          running: runs.running().map(runRow),
          upcoming: upcoming.slice(0, 10).map(jobRow),
        };
      },
    ),
  };
}
