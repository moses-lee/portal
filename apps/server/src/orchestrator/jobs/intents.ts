/**
 * Intents: standing "when X, do Y" requests the user gave, each checked by an `intent_check` job at
 * the cadence the agent chose. The server, not the model, enforces the rules: a firing is refused
 * during the cooldown, past the budget, or after expiry; spending the budget finishes the intent;
 * closing or expiring one ends its jobs. A check is a small bookkeeping turn over the intent and
 * its notes; when it fires, the user hears of it through an `intent_update` Needs-you item (made
 * here, so its links are always right) and, if the turn says something, a note in the thread.
 */
import type { ActivityActor } from "@portal/contracts/activity";
import type { Intent, IntentStatus, Job, JobSchedule } from "@portal/contracts/jobs";
import type { IntentInput } from "../hub.ts";
import { httpError } from "../ops.ts";
import { generateTurn, prepareTurn } from "../turn.ts";
import type { Item, ItemAction, ItemLinks } from "../types.ts";
import { MAIN_THREAD_ID } from "../types.ts";
import type { JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";
import { intentCheckPrompt } from "./prompt.ts";
import { checkPull, pullWatchOf } from "./pull-watch.ts";
import { checkReview, reviewWatchOf } from "./review-watch.ts";
import { describeSchedule, nextRunAt, replanned } from "./schedule.ts";
import type { IntentChanges } from "./store.ts";

/** The tools an intent check may call (names another domain does not offer are simply absent). */
export const INTENT_CHECK_TOOLS = [
  "fire_intent", "close_intent", "update_intent",
  "list_sessions", "get_session", "read_transcript", "get_pull", "get_github_status", "list_items", "update_item", "send_prompt",
  "resolve_pull", "resolve_session", "search_memory",
] as const;

/** Model calls an intent check may make. */
export const INTENT_CHECK_STEPS = 12;
/** The cadence a check job gets when none is given (and migrated watches get). */
export const DEFAULT_CHECK_MS = 10 * 60_000;

const NO_UPDATE = "NO_UPDATE";

export type IntentsPart = ReturnType<typeof createIntents>;

/** `stopped` collects the ids of runs in progress that ending a check job stopped. */
type How = { actor: ActivityActor; runId?: string; threadId?: string | null; stopped?: string[] };

const intentRefs = (intent: Pick<Intent, "id" | "threadId">, runId?: string) =>
  ({ intentId: intent.id, ...(intent.threadId ? { threadId: intent.threadId } : {}), ...(runId ? { runId } : {}) });

const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function checkTitle(text: string): string {
  return `Check: ${short(text.trim().replace(/\s+/g, " "), 100)}`;
}

export function createIntents(core: JobsCore) {
  const { hub, store } = core;

  async function requireIntent(id: string): Promise<Intent> {
    const intent = await store.getIntent(id);
    if (!intent) throw httpError(`Unknown intent "${id}".`, 404);
    return intent;
  }

  /** The live check jobs of an intent. */
  const checkJobs = (intentId: string) => store.listJobs({ intentId, kind: ["intent_check"], status: ["active", "paused", "failed"] });

  async function create(input: IntentInput, how: How): Promise<{ intent: Intent; job: Job }> {
    const now = hub.timers.now();
    if (input.expiresAt != null && input.expiresAt <= now) throw httpError("expiresAt is in the past.", 400);
    const intent = await store.createIntent({ ...input, threadId: input.threadId ?? how.threadId ?? null });
    const job = await core.scheduleJob({
      kind: "intent_check", title: checkTitle(intent.text), schedule: input.check,
      payload: { ...input.checkPayload, intentId: intent.id, ...(input.role ? { role: input.role } : {}) },
      intentId: intent.id, threadId: intent.threadId, createdBy: how.actor === "user" ? "user" : how.actor === "system" ? "system" : "agent",
      nextRunAt: input.checkNow ? now : nextRunAt(input.check, { now, lastRunAt: null, present: core.present() }),
    }, how.actor, { runId: how.runId });
    void hub.activity.log({
      actor: how.actor, kind: "intent.created", summary: `Now watching: ${short(intent.text, 160)} (checked ${describeSchedule(input.check)})`,
      refs: { ...intentRefs(intent, how.runId), jobId: job.id },
      detail: { trigger: intent.trigger, action: intent.action, fireBudget: intent.fireBudget, cooldownMs: intent.cooldownMs, expiresAt: intent.expiresAt },
    });
    await core.emitIntents();
    return { intent, job };
  }

  async function update(id: string, changes: IntentChanges, how: How & { check?: JobSchedule }): Promise<Intent> {
    const current = await requireIntent(id);
    if (current.status !== "active" && (changes.status === undefined || changes.status === current.status)) {
      throw httpError(`This intent is ${current.status}; create a new one instead.`, 409);
    }
    const intent = await store.updateIntent(id, changes);
    if (how.check) {
      const jobs = await checkJobs(id);
      for (const job of jobs) {
        const next = job.status === "active" ? replanned({ ...job, schedule: how.check }, hub.timers.now(), core.present()) : null;
        await core.changeJob(job.id, { schedule: how.check, ...(job.status === "active" ? { nextRunAt: next } : {}) }, {
          actor: how.actor, runId: how.runId, summary: `"${job.title}" is now checked ${describeSchedule(how.check)}`,
        });
      }
    }
    const fields = [...Object.keys(changes), ...(how.check ? ["cadence"] : [])];
    void hub.activity.log({
      actor: how.actor, kind: "intent.updated", summary: `Updated the intent "${short(intent.text)}" (${fields.join(", ")})`,
      refs: intentRefs(intent, how.runId), detail: { fields },
    });
    await core.emitIntents();
    return intent;
  }

  /** End an intent (done, cancelled, expired) and every job that checks it. */
  async function close(id: string, status: Exclude<IntentStatus, "active">, how: How & { reason?: string }): Promise<Intent> {
    const current = await requireIntent(id);
    if (current.status !== "active") return current;
    const intent = await store.updateIntent(id, { status });
    await core.endIntentJobs(id, status === "cancelled" ? "cancelled" : "done", how);
    const verb = status === "done" ? "Done" : status === "expired" ? "Expired" : "Cancelled";
    void hub.activity.log({
      actor: how.actor, kind: "intent.closed", summary: `${verb}: ${short(intent.text, 160)}${how.reason ? ` (${short(how.reason, 160)})` : ""}`,
      refs: intentRefs(intent, how.runId), detail: { status, ...(how.reason ? { reason: how.reason } : {}) },
    });
    await core.emitIntents();
    return intent;
  }

  /** Bring a closed intent back (the UI's "re-activate"): its check job resumes, or a new one starts. */
  async function reopen(id: string, how: How): Promise<Intent> {
    const current = await requireIntent(id);
    if (current.status === "active") return current;
    const now = hub.timers.now();
    const expiresAt = current.expiresAt !== null && current.expiresAt <= now ? null : current.expiresAt;
    const budget = current.fireBudget !== null && current.fires >= current.fireBudget ? { fireBudget: current.fires + 1 } : {};
    const intent = await store.updateIntent(id, { status: "active", expiresAt, ...budget });
    const [last] = await store.listJobs({ intentId: id, kind: ["intent_check"] });
    const schedule: JobSchedule = last?.schedule.type === "every" || last?.schedule.type === "cron" ? last.schedule : { type: "every", everyMs: DEFAULT_CHECK_MS };
    // The new check job carries the old one's payload: its role and any watch it keeps.
    await core.scheduleJob({
      kind: "intent_check", title: checkTitle(intent.text), schedule, payload: { ...last?.payload, intentId: id },
      intentId: id, threadId: intent.threadId, createdBy: how.actor === "user" ? "user" : "agent", nextRunAt: nextRunAt(schedule, { now, lastRunAt: null, present: core.present() }),
    }, how.actor, { runId: how.runId });
    void hub.activity.log({ actor: how.actor, kind: "intent.updated", summary: `Re-activated the intent "${short(intent.text)}"`, refs: intentRefs(intent, how.runId), detail: { status: "active" } });
    await core.emitIntents();
    return intent;
  }

  /** Why the intent may not fire now, or null when it may. Expires it on the way when its time is up. */
  async function refusal(intent: Intent, now: number): Promise<string | null> {
    if (intent.status !== "active") return `the intent is ${intent.status}`;
    if (intent.expiresAt !== null && intent.expiresAt <= now) {
      await close(intent.id, "expired", { actor: "system" });
      return "the intent has expired";
    }
    if (intent.fireBudget !== null && intent.fires >= intent.fireBudget) {
      await close(intent.id, "done", { actor: "system", reason: "fire budget spent" });
      return "the intent's fire budget is spent";
    }
    if (intent.lastFiredAt !== null && now - intent.lastFiredAt < intent.cooldownMs) {
      return `the intent is cooling down until ${new Date(intent.lastFiredAt + intent.cooldownMs).toISOString()}`;
    }
    return null;
  }

  /** The Needs-you item for a firing: one per intent, updated on each firing. */
  async function raiseItem(intent: Intent, title: string, body: string): Promise<Item> {
    const links: ItemLinks = { intentId: intent.id, ...(intent.threadId ? { threadId: intent.threadId } : {}) };
    const actions: ItemAction[] = [];
    if (intent.scope.pulls.length === 1) {
      links.pull = intent.scope.pulls[0];
      actions.push({ type: "open_url", url: intent.scope.pulls[0].url, label: "Open PR" });
    }
    if (intent.scope.sessionIds.length === 1) {
      links.sessionId = intent.scope.sessionIds[0];
      actions.push({ type: "open_session", sessionId: intent.scope.sessionIds[0], label: "Open session" });
    }
    if (intent.scope.projectIds.length === 1) links.projectId = intent.scope.projectIds[0];
    const fingerprint = `intent_update:${intent.id}`;
    const existing = await hub.store.findItemByFingerprint(fingerprint);
    const fields = { title: short(title, 200), body: short(body, 2000), links, actions };
    const item = existing ? await hub.store.updateItem(existing.id, fields) : await hub.store.createItem({ ...fields, kind: "intent_update", fingerprint });
    hub.emit({ type: "items", items: await hub.store.listItems() });
    return item;
  }

  /**
   * Fire an intent if the rules allow it: count the firing, raise its item, and finish the intent
   * when that spent its budget.
   */
  async function fire(id: string, { title, body, item = true }: { title: string; body: string; item?: boolean }, how: How & { touched?: Set<string> }) {
    const intent = await requireIntent(id);
    const now = hub.timers.now();
    const refused = await refusal(intent, now);
    if (refused) return { fired: false as const, reason: refused };
    const fired = await store.updateIntent(id, { fires: intent.fires + 1, lastFiredAt: now });
    const raised = item ? await raiseItem(fired, title, body) : null;
    if (raised) how.touched?.add(raised.id);
    void hub.activity.log({
      actor: how.actor, kind: "intent.fired", summary: `Fired: ${short(title, 160)}`,
      refs: { ...intentRefs(fired, how.runId), ...(raised ? { itemId: raised.id } : {}) }, detail: { fires: fired.fires, fireBudget: fired.fireBudget },
    });
    const spent = fired.fireBudget !== null && fired.fires >= fired.fireBudget;
    if (spent) await close(id, "done", { ...how, reason: "fire budget spent" });
    else await core.emitIntents();
    return {
      fired: true as const, itemId: raised?.id ?? null, firesLeft: fired.fireBudget === null ? null : fired.fireBudget - fired.fires, done: spent,
    };
  }

  /** Expire every active intent past its time; the worker calls this before each look. */
  async function expireDue(): Promise<void> {
    const now = hub.timers.now();
    for (const intent of await store.listIntents({ status: ["active"] })) {
      if (intent.expiresAt !== null && intent.expiresAt <= now) await close(intent.id, "expired", { actor: "system" });
    }
  }

  /** One check: a bookkeeping turn over the intent that may fire it. */
  async function check({ job, run, trigger, signal }: KindContext): Promise<KindResult> {
    const intentId = typeof job.payload.intentId === "string" ? job.payload.intentId : job.intentId;
    const intent = intentId ? await store.getIntent(intentId) : null;
    if (!intent) return { summary: "Its intent no longer exists.", jobStatus: "cancelled" };
    if (intent.status !== "active") return { summary: `The intent is ${intent.status}.`, jobStatus: intent.status === "cancelled" ? "cancelled" : "done" };
    const now = hub.timers.now();
    if (intent.expiresAt !== null && intent.expiresAt <= now) {
      await close(intent.id, "expired", { actor: "system", runId: run.id });
      return { summary: "The intent expired.", jobStatus: "done" };
    }
    // A watch the server can evaluate itself needs no model turn.
    const review = reviewWatchOf(job.payload);
    if (review) return checkReview({ core, fire }, { job, run, trigger, signal }, intent, review);
    const pull = pullWatchOf(job.payload);
    if (pull) return checkPull({ core, fire, close }, { job, run, trigger, signal }, intent, pull);
    const touched = new Set<string>();
    const threadId = intent.threadId ?? MAIN_THREAD_ID;
    const prepared = await prepareTurn(hub, {
      kind: "intent_check", role: job.payload.role === "chat" ? "chat" : "bookkeeping", trigger, threadId, jobId: job.id, intentId: intent.id,
      interactive: false, toolNames: INTENT_CHECK_TOOLS, scope: intent.scope, query: `${intent.text}\n${intent.trigger}`, touched,
      summary: job.title,
    });
    if (!prepared) return { status: "failed", skipped: true, error: "not ready", summary: "No API key is stored; the intent was not checked." };
    const result = await generateTurn(prepared, { prompt: intentCheckPrompt(intent, now), signal, maxSteps: INTENT_CHECK_STEPS });
    const after = (await store.getIntent(intent.id)) ?? intent;
    const fired = after.fires > intent.fires;
    if (after.status === "active") await store.updateIntent(intent.id, { lastCheckedAt: hub.timers.now() });
    const text = result.text.trim();
    if (fired && text && text !== NO_UPDATE) await core.postToThread(threadId, text, run, [...touched]);
    if (touched.size > 0) hub.emit({ type: "items", items: await hub.store.listItems() });
    await core.emitIntents();
    return {
      summary: fired ? `Fired: ${short(text && text !== NO_UPDATE ? text : intent.text, 160)}` : "Checked; the trigger does not hold yet.",
      result: { intentId: intent.id, fired, text: short(text, 2000) },
      ...(after.status !== "active" ? { jobStatus: after.status === "cancelled" ? "cancelled" as const : "done" as const } : {}),
    };
  }

  // Cancelling an intent's check job (from the UI or a tool) cancels the intent it serves.
  core.onCheckJobCancelled = async (job, how) => {
    if (job.intentId && (await checkJobs(job.intentId)).length === 0) await close(job.intentId, "cancelled", { ...how, reason: "its check job was cancelled" });
  };

  return { create, update, close, reopen, fire, expireDue, check, requireIntent, checkJobs };
}
