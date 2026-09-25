/**
 * The job tools. A chat turn (or a helper that names them) gets the scheduling set: jobs, runs,
 * intents, helpers, and the schedule. An intent check gets only what acts on its own intent
 * (fire_intent, close_intent, update_intent). Other background turns get none: their tool schemas
 * would be paid for on every step. The world refresh job (`TICK_JOB_ID`) is Portal's plumbing and
 * never shows here: no tool lists it or its runs, and update_job and cancel_job answer that it is
 * unknown (the jobs core refuses it).
 */
import { z } from "zod";
import type { Intent, Job, JobRun, JobSchedule } from "@portal/contracts/jobs";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { canonicalScope, knownIds } from "../ids.ts";
import { httpError } from "../ops.ts";
import { capped, define } from "../tools/context.ts";
import { pullRefSchema } from "../tools/items.ts";
import { type JobsCore, isRefreshJob } from "./core.ts";
import type { createHelpers } from "./helpers.ts";
import { resolvePull } from "../world/resolve.ts";
import { DEFAULT_CHECK_MS, type IntentsPart } from "./intents.ts";
import { DEFAULT_MONITOR_CHECK_MS, DEFAULT_PULL_EVENTS, type PullEvent, pullEvents, pullWatchOf } from "./pull-watch.ts";
import { MIN_EVERY_MS, describeSchedule, parseSchedule } from "./schedule.ts";

type Helpers = ReturnType<typeof createHelpers>;

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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
      "Something new happened that the intent's trigger names: record the firing and put a Needs-you item in front of the user. The server refuses a repeat of the last firing's title, during the cooldown, past the budget, or after expiry; then stop.",
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

  /**
   * What a cancel did to runs in progress: `runStopped` when it aborted one in this process. A run in
   * another Portal process cannot be aborted from here; it checks its job before each change and stops.
   */
  async function runsReport(jobIds: string[], stopped: string[]) {
    const elsewhere: string[] = [];
    for (const jobId of jobIds) {
      for (const run of await store.listRuns({ jobId, status: ["running"], limit: 5 })) {
        if (!stopped.includes(run.id) && run.id !== turn.runId && !runs.get(run.id)) elsewhere.push(run.id);
      }
    }
    return {
      runStopped: stopped.length > 0, ...(stopped.length ? { stoppedRunIds: stopped } : {}),
      ...(elsewhere.length ? { stoppingRunIds: elsewhere, note: "Another Portal process is running it; that run stops before its next change." } : {}),
    };
  }

  /** The active monitor of a PR (its intent and check job), when one exists. */
  async function monitorOf(repo: string | null, number: number): Promise<{ intent: Intent; job: Job } | null> {
    for (const job of await store.listJobs({ kind: ["intent_check"], status: ["active", "paused"] })) {
      const watch = pullWatchOf(job.payload);
      if (!watch || watch.number !== number || (repo && watch.repo.toLowerCase() !== repo.toLowerCase()) || !job.intentId) continue;
      const intent = await store.getIntent(job.intentId);
      if (intent?.status === "active") return { intent, job };
    }
    return null;
  }

  return {
    monitor_pull: define(
      "Watch one pull request and tell the user only when its state changes: merged, closed, checks failing or passing again, changes requested, approved, merge conflicts (new reviews and comments only with comments: true). It ends by itself when the PR merges or closes; cancel_intent with pull stops it. Asking again for a PR already watched updates that monitor. repo may be owner/name (any repo on GitHub) or a loose name.",
      z.object({
        number: z.number().int().positive(),
        repo: z.string().optional(),
        text: z.string().max(2000).optional().describe("What the user asked, in their words."),
        events: z.array(z.enum(pullEvents)).min(1).optional().describe("Which changes to report (default all but comments)."),
        comments: z.boolean().optional().describe("Also report new reviews and comments."),
        expiresInDays: z.number().min(1).max(90).optional().describe("Stop watching after this many days (default: until it merges or closes)."),
        ...cadence,
      }),
      async (input) => {
        let target: { repo: string; number: number; url: string; title: string };
        if (input.repo && REPO_PATTERN.test(input.repo.trim())) {
          const status = await hub.deps.github.pullStatus(input.repo.trim(), input.number);
          target = { repo: status.repo, number: status.number, url: status.url, title: status.title };
        } else {
          const world = (await hub.world.current()) ?? (await hub.world.refresh("monitor_pull"));
          const found = await resolvePull(world, hub.deps, { number: input.number, repo: input.repo });
          if (!found.match) return { candidates: found.candidates, reason: found.reason };
          target = { repo: found.match.repo, number: found.match.number, url: found.match.url, title: found.match.title };
        }
        const name = `${target.repo}#${target.number}`;
        const chosen: PullEvent[] = [...new Set([...(input.events ?? DEFAULT_PULL_EVENTS), ...(input.comments ? ["comments" as const] : [])])];
        const trigger = `${name} changes: ${chosen.join(", ").replaceAll("_", " ")}`;
        const check = checkSchedule(input);
        const existing = await monitorOf(target.repo, target.number);
        if (existing) {
          const watch = pullWatchOf(existing.job.payload)!;
          await store.updateJob(existing.job.id, { payload: { ...existing.job.payload, pull: { ...watch, events: chosen } } });
          const intent = await intents.update(existing.intent.id, { trigger, ...(input.text ? { text: input.text } : {}) }, { ...how, ...(check ? { check } : {}) });
          return { ...intentRow(intent), updated: true, pull: target, events: chosen };
        }
        const { intent, job } = await intents.create({
          text: input.text ?? `Monitor ${name} until it merges`, trigger, action: "Tell the user what changed; stop once it is merged or closed.",
          scope: { pulls: [{ repo: target.repo, number: target.number, url: target.url }], repos: [target.repo] }, fireBudget: null, cooldownMs: 0,
          expiresAt: input.expiresInDays ? now() + Math.round(input.expiresInDays * 86_400_000) : null, threadId: turn.threadId,
          check: check ?? { type: "every", everyMs: DEFAULT_MONITOR_CHECK_MS }, checkNow: true,
          checkPayload: { pull: { repo: target.repo, number: target.number, url: target.url, events: chosen, last: null } },
        }, how);
        return { ...intentRow(intent), checkJob: jobRow(job), pull: target, events: chosen };
      },
    ),
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
        // Stored scopes hold full ids: a prefix is expanded, and one that names nothing or several is refused.
        const scope = input.scope && canonicalScope(input.scope, await knownIds(hub.deps));
        const { intent, job } = await intents.create({
          text: input.text, trigger: input.trigger, action: input.action, scope, notes: input.notes,
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
        // Ids already stored pass even when they no longer resolve; new ones must name one session or project.
        const current = scope !== undefined ? (await intents.requireIntent(id)).scope : null;
        const changes = {
          ...(text !== undefined ? { text } : {}), ...(trigger !== undefined ? { trigger } : {}), ...(action !== undefined ? { action } : {}),
          ...(notes !== undefined ? { notes } : {}), ...(current ? { scope: canonicalScope({ ...current, ...scope }, await knownIds(hub.deps), current) } : {}),
          ...(expiresAt !== undefined ? { expiresAt: parseTime(expiresAt, "expiresAt") ?? null } : {}), ...(fireBudget !== undefined ? { fireBudget } : {}),
          ...(cooldownMinutes !== undefined ? { cooldownMs: Math.round(cooldownMinutes * 60_000) } : {}),
        };
        return intentRow(await intents.update(id, changes, { ...how, check: checkSchedule(rest) }));
      },
    ),
    cancel_intent: define(
      "Cancel an intent the user no longer wants (or that can never fire); its check job stops too, including a check in progress (runStopped says whether one was). Give its id, or pull (and repo) to stop the monitor of that PR.",
      z.object({ id: z.string().min(1).optional(), pull: z.number().int().positive().optional(), repo: z.string().optional(), reason: z.string().max(500).optional() }),
      async ({ id, pull, repo, reason }) => {
        const target = id ?? (pull ? (await monitorOf(repo && REPO_PATTERN.test(repo) ? repo : null, pull))?.intent.id : undefined);
        if (!target) throw httpError(pull ? `No active monitor watches PR #${pull}.` : "Give the intent's id or a PR number.", pull ? 404 : 400);
        const stopped: string[] = [];
        const intent = await intents.close(target, "cancelled", { ...how, reason, stopped });
        const jobIds = (await store.listJobs({ intentId: intent.id })).map((job) => job.id);
        return { ...intentRow(intent, true), ...(await runsReport(jobIds, stopped)) };
      },
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
      "Reschedule, rename, pause, or resume a job.",
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
      "Cancel a job that is no longer needed; a run of it in progress is stopped too (runStopped says whether one was). Cancelling an intent's check job cancels the intent.",
      z.object({ id: z.string().min(1) }),
      async ({ id }) => {
        const stopped: string[] = [];
        const job = await core.patchJob(id, { status: "cancelled" }, { actor: "agent", runId: turn.runId, stopped });
        return { ...jobRow(job), ...(await runsReport([job.id], stopped)) };
      },
    ),
    list_jobs: define(
      "Jobs by status (default active), soonest first.",
      z.object({ status: z.enum(["active", "paused", "done", "cancelled", "failed"]).optional(), kind: z.enum(["intent_check", "helper", "consolidate"]).optional() }),
      async ({ status = "active", kind }) => {
        const listed = await store.listJobs({ status: [status], ...(kind ? { kind: [kind] } : {}) });
        const { rows, truncated } = capped(listed.filter((job) => !isRefreshJob(job)));
        return { jobs: rows.map(jobRow), truncated };
      },
    ),
    list_runs: define(
      "Recent runs (chat turns, checks, helpers, curation), newest first: status, summary, errors.",
      z.object({ jobId: z.string().optional(), kind: z.enum(["chat", "intent_check", "helper", "consolidate"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
      async ({ jobId, kind, limit = 10 }) => ({ runs: (await store.listRuns({ jobId, kind, notKinds: ["tick"], limit })).map(runRow) }),
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
      "Your schedule: whether anyone has Portal open, what is running, and the next jobs due.",
      z.object({}),
      async () => {
        const [upcoming, model] = await Promise.all([store.listJobs({ status: ["active"] }), hub.model("bookkeeping")]);
        return {
          ready: !!model, presence: hub.presence.count(),
          running: runs.running().filter((run) => run.kind !== "tick").map(runRow),
          upcoming: upcoming.filter((job) => !isRefreshJob(job)).slice(0, 10).map(jobRow),
        };
      },
    ),
  };
}
