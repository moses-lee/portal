/**
 * The job tools. A chat turn (or a helper that names them) gets the scheduling set: jobs, runs,
 * watches, helpers, and the schedule. A watch's run gets only what acts on its own watch
 * (update_watch, and end_watch or renew_watch where they apply) and list_watches: it never starts
 * background work, and its final reply, not a tool, is its firing. Intents are called watches wherever the model (or the
 * user) reads about them: tool names, descriptions, and result keys say "watch"; the code, the
 * tables, and the REST paths keep "intent". Other background turns get none: their tool schemas
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
import { sessionEventKinds } from "@portal/contracts/jobs";
import { DEFAULT_CHECK_MS, type IntentsPart, MAX_LIFETIME_MS, MIN_LIFETIME_MS, RENEW_WINDOW_MS, describeSource } from "./intents.ts";
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
    lastRunAt: iso(job.lastRunAt), ...(job.failures ? { failures: job.failures } : {}), ...(job.intentId ? { watchId: job.intentId } : {}),
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
  const sessions = intent.source.type === "session" || intent.source.type === "portal_sessions" ? intent.source.sessionIds : null;
  return {
    id: intent.id, text: intent.text, trigger: intent.trigger, action: intent.action, status: intent.status, notes,
    wakes: describeSource(intent), ...(sessions ? { sessions } : {}), fires: intent.fires, ...(intent.fireBudget === 1 ? { once: true } : {}),
    expiresAt: iso(intent.expiresAt), lastFiredAt: iso(intent.lastFiredAt), lastCheckedAt: iso(intent.lastCheckedAt),
    ...(intent.threadId ? { threadId: intent.threadId } : {}),
  };
}

/** `hours` from now as an expiry, clamped to what a watch may live; null (the default week) when not given. */
function expiryIn(hours: number | undefined, now: number): number | null {
  if (hours === undefined) return null;
  return now + Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, Math.round(hours * 3_600_000)));
}

export function jobTools(core: JobsCore, intents: IntentsPart, helpers: Helpers, ctx: DomainToolContext): ToolSet {
  if (ctx.turn.kind === "intent_check") return ctx.turn.intentId ? watchRunTools(core, intents, ctx, ctx.turn.intentId) : {};
  if (!ctx.interactive) return {};
  return schedulingTools(core, intents, helpers, ctx);
}

/**
 * In a watch's run only: act on that one watch. end_watch ends a poll watch (an event watch ends
 * with its sessions or its expiry); renew_watch extends, once, a watch within a day of expiring.
 * Both refuse when they do not apply, since the tool set is built before the watch is read.
 */
function watchRunTools(core: JobsCore, intents: IntentsPart, ctx: DomainToolContext, intentId: string): ToolSet {
  const how = { actor: "agent" as const, runId: ctx.turn.runId };
  return {
    update_watch: define(
      "Rewrite this watch's notes: what you saw and reported, and what is left. Keep them short.",
      z.object({ notes: z.string().max(4000) }),
      async ({ notes }) => intentRow(await intents.update(intentId, { notes }, how), true),
    ),
    list_watches: define(
      "Watches by status (default active), newest first.",
      z.object({ status: z.enum(["active", "done", "cancelled", "expired"]).optional() }),
      async ({ status = "active" }) => {
        const { rows, truncated } = capped(await core.store.listIntents({ status: [status] }));
        return { watches: rows.map((row) => intentRow(row, true)), truncated };
      },
    ),
    end_watch: define(
      "End this watch when it checks a condition on a schedule (not one woken by session events): done when it is fulfilled, cancelled when it can never fire. Give the evidence (what you saw, where) as well as the reason.",
      z.object({ status: z.enum(["done", "cancelled"]), reason: z.string().min(1).max(500), evidence: z.string().min(1).max(1000) }),
      async ({ status, reason, evidence }) => {
        const intent = await intents.requireIntent(intentId);
        if (intent.source.type !== "poll") return { error: "This watch ends by itself when its sessions or PR are gone, or when it expires; reply [quiet] if nothing is worth telling." };
        if (!evidence.trim()) return { error: "Give the evidence that the watch is fulfilled or can never fire." };
        const when = await intents.requestEnd(intentId, status, { ...how, reason: `${reason} (evidence: ${evidence.trim()})` });
        return when === "after_reply" ? { ending: status, note: "It ends once your reply is delivered; still reply with what the user should hear." } : { closed: status };
      },
    ),
    renew_watch: define(
      "Extend this watch once, by up to 168 hours from now, when it expires within a day and what it waits for is still ahead.",
      z.object({ hours: z.number().min(1).max(168), reason: z.string().min(1).max(300) }),
      async ({ hours, reason }) => {
        const now = core.hub.timers.now();
        const expiresAt = now + Math.round(hours * 3_600_000);
        let refused: string | null = null;
        const stored = await core.store.updateIntent(intentId, (current) => {
          if (current.status !== "active") refused = `This watch is ${current.status}.`;
          else if (current.renewals >= 1) refused = "This watch was renewed once already; the user can re-activate it after it expires.";
          else if (current.expiresAt === null || current.expiresAt - now >= RENEW_WINDOW_MS) refused = "This watch does not expire within a day; nothing to renew yet.";
          return refused ? null : { expiresAt, renewals: current.renewals + 1 };
        });
        if (refused) return { error: refused };
        void core.hub.activity.log({
          actor: "agent", kind: "intent.updated", summary: `Renewed the watch "${stored.text.slice(0, 80)}" until ${iso(expiresAt)} (${reason})`,
          refs: { intentId, runId: ctx.turn.runId }, detail: { fields: ["expiresAt"] },
        });
        await core.emitIntents();
        return intentRow(stored, true);
      },
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
      "Watch one pull request and tell the user only when its state changes: merged, closed, checks failing or passing again, changes requested, approved, merge conflicts (new reviews and comments only with comments: true). It ends by itself when the PR merges or closes; cancel_watch with pull stops it. Asking again for a PR already watched updates that monitor. repo may be owner/name (any repo on GitHub) or a loose name.",
      z.object({
        number: z.number().int().positive(),
        repo: z.string().optional(),
        text: z.string().max(2000).optional().describe("What the user asked, in their words."),
        events: z.array(z.enum(pullEvents)).min(1).optional().describe("Which changes to report (default all but comments)."),
        comments: z.boolean().optional().describe("Also report new reviews and comments."),
        expiresInDays: z.number().min(1).max(30).optional().describe("Stop watching after this many days (default 30) if it has not merged or closed by then."),
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
          source: { type: "pull" }, expiresAt: now() + (input.expiresInDays ? Math.round(input.expiresInDays * 86_400_000) : MAX_LIFETIME_MS), threadId: turn.threadId,
          check: check ?? { type: "every", everyMs: DEFAULT_MONITOR_CHECK_MS }, checkNow: true,
          checkPayload: { pull: { repo: target.repo, number: target.number, url: target.url, events: chosen, last: null } },
        }, how);
        return { ...intentRow(intent), checkJob: jobRow(job), pull: target, events: chosen };
      },
    ),
    create_watch: define(
      "Create a watch: a standing request of the user (\"tell me when the #42 session finishes\"): text in the user's words, a precise trigger, the action when it fires. With sessions, Portal sees their turn ends, permission waits, and stalls as they happen and runs the watch only then. Without, its runs check the trigger on the cadence you choose. Each run has every tool you have; its reply is what the user hears. It expires after expiresInHours (the answer says when).",
      z.object({
        text: z.string().min(1).max(2000).describe("What the user asked, in their words."),
        trigger: z.string().min(1).max(1000).describe("The exact condition, e.g. \"the #3313 session finishes its rebase\" or \"status.openai.com shows the Codex incident resolved\"."),
        action: z.string().min(1).max(1000).describe("What to do when it fires, e.g. \"tell me the findings in brief; never prompt the session\"."),
        sessions: z.array(z.string()).max(20).optional().describe("Session ids to watch for events (turn ends, permission waits, stalls)."),
        on: z.array(z.enum(sessionEventKinds)).min(1).optional().describe("Which session events wake it (default all three)."),
        once: z.boolean().optional().describe("Fire only once, then end (\"tell me when it finishes\"). Default false: it keeps reporting until it expires."),
        expiresInHours: z.number().min(1).max(720).optional().describe("How long it lives (default 168, a week; at most 720)."),
        scope: scopeSchema.optional(),
        notes: z.string().max(4000).optional().describe("Your plan and what you know so far."),
        ...cadence,
        checkNow: z.boolean().optional().describe("Without sessions: run the first check right away instead of after one interval."),
      }),
      async (input) => {
        const known = await knownIds(hub.deps);
        // Stored scopes hold full ids: a prefix is expanded, and one that names nothing or several is refused.
        const sessionIds = input.sessions?.length ? canonicalScope({ sessionIds: input.sessions }, known).sessionIds : [];
        const scope = canonicalScope({ ...input.scope, sessionIds: [...(input.scope?.sessionIds ?? []), ...sessionIds] }, known);
        const source = sessionIds.length ? { type: "session" as const, sessionIds, on: input.on ?? [...sessionEventKinds] } : undefined;
        const check = checkSchedule(input) ?? { type: "every", everyMs: DEFAULT_CHECK_MS };
        const { intent, job } = await intents.create({
          text: input.text, trigger: input.trigger, action: input.action, scope, notes: input.notes, source,
          expiresAt: expiryIn(input.expiresInHours, now()), fireBudget: input.once ? 1 : null, cooldownMs: 0,
          threadId: turn.threadId, check, checkNow: input.checkNow,
        }, how);
        return { ...intentRow(intent), checkJob: jobRow(job) };
      },
    ),
    update_watch: define(
      "Change an active watch: its notes (your current understanding), trigger, action, scope, expiry, or (for a watch without sessions) check cadence.",
      z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(2000).optional(),
        trigger: z.string().min(1).max(1000).optional(),
        action: z.string().min(1).max(1000).optional(),
        notes: z.string().max(4000).optional(),
        scope: scopeSchema.optional(),
        expiresInHours: z.number().min(1).max(720).optional().describe("It now expires this many hours from now."),
        ...cadence,
      }),
      async ({ id, text, trigger, action, notes, scope, expiresInHours, ...rest }) => {
        // Ids already stored pass even when they no longer resolve; new ones must name one session or project.
        const current = scope !== undefined ? (await intents.requireIntent(id)).scope : null;
        const changes = {
          ...(text !== undefined ? { text } : {}), ...(trigger !== undefined ? { trigger } : {}), ...(action !== undefined ? { action } : {}),
          ...(notes !== undefined ? { notes } : {}), ...(current ? { scope: canonicalScope({ ...current, ...scope }, await knownIds(hub.deps), current) } : {}),
          ...(expiresInHours !== undefined ? { expiresAt: expiryIn(expiresInHours, now()) } : {}),
        };
        return intentRow(await intents.update(id, changes, { ...how, check: checkSchedule(rest) }));
      },
    ),
    cancel_watch: define(
      "Cancel a watch the user no longer wants (or that can never fire); its check job stops too, including a check in progress (runStopped says whether one was). Give its id, or pull (and repo) to stop the monitor of that PR.",
      z.object({ id: z.string().min(1).optional(), pull: z.number().int().positive().optional(), repo: z.string().optional(), reason: z.string().max(500).optional() }),
      async ({ id, pull, repo, reason }) => {
        const target = id ?? (pull ? (await monitorOf(repo && REPO_PATTERN.test(repo) ? repo : null, pull))?.intent.id : undefined);
        if (!target) throw httpError(pull ? `No active monitor watches PR #${pull}.` : "Give the watch's id or a PR number.", pull ? 404 : 400);
        const stopped: string[] = [];
        const intent = await intents.close(target, "cancelled", { ...how, reason, stopped });
        const jobIds = (await store.listJobs({ intentId: intent.id })).map((job) => job.id);
        return { ...intentRow(intent, true), ...(await runsReport(jobIds, stopped)) };
      },
    ),
    list_watches: define(
      "Watches by status (default active), newest first.",
      z.object({ status: z.enum(["active", "done", "cancelled", "expired"]).optional() }),
      async ({ status = "active" }) => {
        const { rows, truncated } = capped(await store.listIntents({ status: [status] }));
        return { watches: rows.map((intent) => intentRow(intent, true)), truncated };
      },
    ),
    schedule_job: define(
      "Schedule a helper job: a bounded turn with your prompt that runs on a schedule (every N minutes, cron, or once) and posts its answer to this thread. For conditions to watch, use create_watch instead.",
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
      "Cancel a job that is no longer needed; a run of it in progress is stopped too (runStopped says whether one was). Cancelling a watch's check job cancels the watch.",
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
