/**
 * Intents (watches, to the model and the user): standing "when X, do Y" requests, each served by an
 * `intent_check` job (docs/WATCHES.md). What wakes one is its source:
 * - a session watch (and the standing rule for sessions Portal starts) runs only when Portal saw an
 *   event of its sessions (`watch-events.ts`); its job sits unscheduled in between;
 * - the PR monitor and the review watch are checked by code alone (`pull-watch.ts`, `review-watch.ts`);
 * - a poll watch, a condition only a model can check, runs on its job's schedule.
 *
 * A run is a full agent turn on the watch role's model. Its final reply is the firing: a reply
 * opening with [quiet] (or empty) says nothing happened worth telling; anything else becomes the
 * watch's Needs-you item and a note in its thread. The server keeps the rules: a firing is refused
 * past the budget, during a cooldown, after expiry, or (for a poll watch) when it repeats the last
 * one; spending the budget finishes the watch; every watch but the standing rule expires (seven days
 * by default, at most thirty), and an expired one leaves an item saying so.
 */
import type { ActivityActor } from "@portal/contracts/activity";
import type { Intent, IntentStatus, Job, JobSchedule, WatchEvent } from "@portal/contracts/jobs";
import type { IntentInput } from "../hub.ts";
import { expandId, expandScope, knownIds, mapRefs } from "../ids.ts";
import { httpError } from "../ops.ts";
import { generateTurn, prepareTurn } from "../turn.ts";
import type { Item, ItemAction, ItemLinks } from "../types.ts";
import { MAIN_THREAD_ID } from "../types.ts";
import type { JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";
import { type EventDetail, watchRunPrompt } from "./prompt.ts";
import { checkPull, pullWatchOf } from "./pull-watch.ts";
import { checkReview, reviewText, reviewWatchOf, sessionProgress } from "./review-watch.ts";
import { describeSchedule, nextRunAt, replanned } from "./schedule.ts";
import type { IntentChanges } from "./store.ts";
import { EVENT_JOB_EVERY_MS, isSessionSource } from "./watch-events.ts";
import type { SessionMeta } from "../../lib/types.ts";
import type { WatchEvents } from "@portal/contracts/jobs";

type SessionSource = Extract<Intent["source"], { type: "session" | "portal_sessions" }>;

/** What the intents part needs of the session-event engine (named here, so the two parts' types do not refer to each other). */
export type WatchEventsApi = {
  absorb(intent: Intent, metas: SessionMeta[]): Promise<boolean>;
  baseline(events: WatchEvents, source: SessionSource, metas: SessionMeta[]): WatchEvents;
};

/** The cadence a poll watch's job gets when none is given (and migrated watches get). */
export const DEFAULT_CHECK_MS = 10 * 60_000;
/** How long a watch lives unless the agent asks otherwise, the least it may ask for, and the most. */
export const DEFAULT_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const MIN_LIFETIME_MS = 60 * 60_000;
export const MAX_LIFETIME_MS = 30 * 24 * 60 * 60_000;
/** A run may extend its watch (once) when it expires within this window. */
export const RENEW_WINDOW_MS = 24 * 60 * 60_000;
/** Assistant text of a watched session's last turn handed to a run, per event (the end kept). */
export const EVENT_TEXT_CAP = 6000;
/** Events a run reads in full; any beyond are listed by one line. */
const DETAILED_EVENTS = 5;

export type IntentsPart = ReturnType<typeof createIntents>;

/** `stopped` collects the ids of runs in progress that ending a check job stopped. */
type How = { actor: ActivityActor; runId?: string; threadId?: string | null; stopped?: string[] };

const intentRefs = (intent: Pick<Intent, "id" | "threadId">, runId?: string) =>
  ({ intentId: intent.id, ...(intent.threadId ? { threadId: intent.threadId } : {}), ...(runId ? { runId } : {}) });

const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A title compared for repeats: case, spacing, and punctuation ignored. Titles, not bodies: a model
 * rewords its body at every check ("still gone at 18:52"), while its one-line "what happened" stays
 * the same when nothing did; a real change earns a new title.
 */
const repeatKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A run's reply that reports nothing: empty, [quiet] first, or the old NO_UPDATE. */
export function isQuiet(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || /^\[quiet\]/i.test(trimmed) || /^NO_UPDATE\b/.test(trimmed);
}

/** A firing's one-line title from a run's reply: its first sentence, or its first line, shortened. */
export function firingTitle(text: string): string {
  const line = text.trim().split("\n").find((part) => part.trim())?.trim() ?? "";
  const sentence = line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line;
  return short(sentence.replace(/^[#>*\-\s]+/, ""), 160);
}

type Refusal = { reason: string; close?: "expired" | "done" };

/**
 * Why the intent may not fire now, or null when it may; `close` when the refusal should end it (its
 * time is up, its budget spent). A repeat of the last firing's title is refused only for a poll
 * watch's run: a session watch's events are distinct by construction, and the server's own watches
 * fire on changes they compute themselves. The title is kept on the intent, not read back from its
 * item, which the user may have dismissed.
 */
function refusal(intent: Intent, now: number, title: string, actor: ActivityActor): Refusal | null {
  if (intent.status !== "active") return { reason: `the watch is ${intent.status}` };
  if (intent.expiresAt !== null && intent.expiresAt <= now) return { reason: "the watch has expired", close: "expired" };
  if (intent.fireBudget !== null && intent.fires >= intent.fireBudget) return { reason: "the watch's fire budget is spent", close: "done" };
  if (intent.lastFiredAt !== null && now - intent.lastFiredAt < intent.cooldownMs) {
    return { reason: `the watch is cooling down until ${new Date(intent.lastFiredAt + intent.cooldownMs).toISOString()}` };
  }
  if (actor !== "system" && intent.source.type === "poll" && intent.lastFiredTitle !== null && intent.lastFiredAt !== null && repeatKey(intent.lastFiredTitle) === repeatKey(title)) {
    return { reason: `this repeats the last firing at ${new Date(intent.lastFiredAt).toISOString()} ("${short(intent.lastFiredTitle, 120)}")` };
  }
  return null;
}

export function checkTitle(text: string): string {
  return `Check: ${short(text.trim().replace(/\s+/g, " "), 100)}`;
}

/** When a watch made or re-activated at `now` expires: `asked` clamped to one hour – thirty days, seven days when not given. */
export function lifetime(asked: number | null | undefined, now: number): number {
  if (asked === null || asked === undefined) return now + DEFAULT_LIFETIME_MS;
  return Math.min(now + MAX_LIFETIME_MS, Math.max(now + MIN_LIFETIME_MS, asked));
}

export function createIntents(core: JobsCore) {
  const { hub, store } = core;
  /** The session-event engine; set by the service once both exist. */
  let events: WatchEventsApi | null = null;
  /**
   * Watch runs in progress, by run id, with the ending their end_watch asked for: applied once the
   * run's reply is delivered, so a run that reports and ends its watch in one go is still heard.
   */
  const endings = new Map<string, { status: "done" | "cancelled"; reason: string } | null>();

  /** end_watch: end now, or (inside a watch run) once its reply is delivered. */
  async function requestEnd(intentId: string, status: "done" | "cancelled", how: How & { reason: string }): Promise<"ended" | "after_reply"> {
    if (how.runId && endings.has(how.runId)) {
      endings.set(how.runId, { status, reason: how.reason });
      return "after_reply";
    }
    await close(intentId, status, how);
    return "ended";
  }

  async function requireIntent(id: string): Promise<Intent> {
    const intent = await store.getIntent(id);
    if (!intent) throw httpError(`Unknown watch "${id}".`, 404);
    return intent;
  }

  /** The live check jobs of an intent. */
  const checkJobs = (intentId: string) => store.listJobs({ intentId, kind: ["intent_check"], status: ["active", "paused", "failed"] });

  async function create(input: IntentInput, how: How): Promise<{ intent: Intent; job: Job }> {
    const now = hub.timers.now();
    if (input.expiresAt != null && input.expiresAt <= now) throw httpError("expiresAt is in the past.", 400);
    const source = input.source ?? (input.checkPayload?.review ? { type: "review" as const } : input.checkPayload?.pull ? { type: "pull" as const } : { type: "poll" as const });
    const evented = isSessionSource(source);
    const expiresAt = source.type === "portal_sessions" ? null : lifetime(input.expiresAt, now);
    // A session watch starts from what its sessions show now, so it reports only what happens next.
    const startEvents = input.events ?? (evented && events ? events.baseline({ pending: [], handled: [], seen: [] }, source, await hub.deps.sessions.list().catch(() => [])) : undefined);
    const intent = await store.createIntent({ ...input, source, events: startEvents, expiresAt, threadId: input.threadId ?? how.threadId ?? null });
    const schedule: JobSchedule = evented ? { type: "every", everyMs: EVENT_JOB_EVERY_MS } : input.check;
    const job = await core.scheduleJob({
      kind: "intent_check", title: checkTitle(intent.text), schedule,
      payload: { ...input.checkPayload, intentId: intent.id, ...(input.role ? { role: input.role } : {}) },
      intentId: intent.id, threadId: intent.threadId, createdBy: how.actor === "user" ? "user" : how.actor === "system" ? "system" : "agent",
      nextRunAt: evented ? null : input.checkNow ? now : nextRunAt(schedule, { now, lastRunAt: null, present: core.present() }),
    }, how.actor, { runId: how.runId });
    void hub.activity.log({
      actor: how.actor, kind: "intent.created", summary: `Now watching: ${short(intent.text, 160)} (${describeSource(intent, schedule)})`,
      refs: { ...intentRefs(intent, how.runId), jobId: job.id },
      detail: { trigger: intent.trigger, action: intent.action, source: intent.source, fireBudget: intent.fireBudget, expiresAt: intent.expiresAt },
    });
    await core.emitIntents();
    return { intent, job };
  }

  async function update(id: string, changes: IntentChanges, how: How & { check?: JobSchedule }): Promise<Intent> {
    // Checked on the stored intent, so a firing that closes it at the same moment is seen.
    const intent = await store.updateIntent(id, (current) => {
      if (current.status !== "active" && (changes.status === undefined || changes.status === current.status)) {
        throw httpError(`This watch is ${current.status}; create a new one instead.`, 409);
      }
      return changes;
    });
    if (how.check && !isSessionSource(intent.source)) {
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
      actor: how.actor, kind: "intent.updated", summary: `Updated the watch "${short(intent.text)}" (${fields.join(", ")})`,
      refs: intentRefs(intent, how.runId), detail: { fields },
    });
    await core.emitIntents();
    return intent;
  }

  /** End an intent (done, cancelled, expired) and every job that checks it. An expired one leaves an item saying so. */
  async function close(id: string, status: Exclude<IntentStatus, "active">, how: How & { reason?: string }): Promise<Intent> {
    const current = await requireIntent(id);
    if (current.status !== "active") return current;
    // Only the close that ends it goes on to end its jobs and log it; a concurrent one answers the intent as closed.
    let ended = false;
    const intent = await store.updateIntent(id, (stored) => {
      if (stored.status !== "active") return null;
      ended = true;
      return { status };
    });
    if (!ended) return intent;
    await core.endIntentJobs(id, status === "cancelled" ? "cancelled" : "done", how);
    const verb = status === "done" ? "Done" : status === "expired" ? "Expired" : "Cancelled";
    void hub.activity.log({
      actor: how.actor, kind: "intent.closed", summary: `${verb}: ${short(intent.text, 160)}${how.reason ? ` (${short(how.reason, 160)})` : ""}`,
      refs: intentRefs(intent, how.runId), detail: { status, ...(how.reason ? { reason: how.reason } : {}) },
    });
    if (status === "expired") await raiseExpired(intent).catch((err: unknown) => console.error("Could not raise the expired watch's item:", err));
    await core.emitIntents();
    return intent;
  }

  /** Bring a closed intent back (the UI's "re-activate"): it lives another seven days, and its check job resumes or a new one starts. */
  async function reopen(id: string, how: How): Promise<Intent> {
    const current = await requireIntent(id);
    if (current.status === "active") return current;
    const now = hub.timers.now();
    const expiresAt = current.source.type === "portal_sessions" ? null : lifetime(null, now);
    const budget = current.fireBudget !== null && current.fires >= current.fireBudget ? { fireBudget: current.fires + 1 } : {};
    const intent = await store.updateIntent(id, { status: "active", expiresAt, renewals: 0, ...budget });
    const [last] = await store.listJobs({ intentId: id, kind: ["intent_check"] });
    const evented = isSessionSource(intent.source);
    const schedule: JobSchedule = evented
      ? { type: "every", everyMs: EVENT_JOB_EVERY_MS }
      : last?.schedule.type === "every" || last?.schedule.type === "cron" ? last.schedule : { type: "every", everyMs: DEFAULT_CHECK_MS };
    // The new check job carries the old one's payload: its role and any watch it keeps.
    await core.scheduleJob({
      kind: "intent_check", title: checkTitle(intent.text), schedule, payload: { ...last?.payload, intentId: id },
      intentId: id, threadId: intent.threadId, createdBy: how.actor === "user" ? "user" : "agent",
      nextRunAt: evented ? null : nextRunAt(schedule, { now, lastRunAt: null, present: core.present() }),
    }, how.actor, { runId: how.runId });
    if (evented && events) {
      // What happened while it was off is not news: it starts again from the sessions as they are.
      const metas = await hub.deps.sessions.list().catch(() => []);
      await store.updateIntent(id, (stored) => (isSessionSource(stored.source) ? { events: events!.baseline({ ...stored.events, pending: [] }, stored.source, metas) } : null));
    }
    void hub.activity.log({ actor: how.actor, kind: "intent.updated", summary: `Re-activated the watch "${short(intent.text)}"`, refs: intentRefs(intent, how.runId), detail: { status: "active" } });
    await core.emitIntents();
    return intent;
  }

  /** The user renews an active watch: it lives another seven days from now (the standing rule never expires). */
  async function renew(id: string, how: How): Promise<Intent> {
    const now = hub.timers.now();
    const intent = await store.updateIntent(id, (current) => {
      if (current.status !== "active") throw httpError(`This watch is ${current.status}; re-activate it instead.`, 409);
      return current.source.type === "portal_sessions" ? null : { expiresAt: lifetime(null, now) };
    });
    void hub.activity.log({ actor: how.actor, kind: "intent.updated", summary: `Renewed the watch "${short(intent.text)}" for another week`, refs: intentRefs(intent, how.runId), detail: { fields: ["expiresAt"] } });
    await core.emitIntents();
    return intent;
  }

  /**
   * The Needs-you item for a firing: one per intent, updated on each firing, except that the
   * standing rule keeps one per session. Its links carry full ids, even from a scope stored with
   * prefixes.
   */
  async function raiseItem(stored: Intent, title: string, body: string, sessionId?: string): Promise<Item> {
    const intent = { ...stored, scope: expandScope(stored.scope, await knownIds(hub.deps)).scope };
    const links: ItemLinks = { intentId: intent.id, ...(intent.threadId ? { threadId: intent.threadId } : {}) };
    const actions: ItemAction[] = [];
    if (intent.scope.pulls.length === 1) {
      links.pull = intent.scope.pulls[0];
      actions.push({ type: "open_url", url: intent.scope.pulls[0].url, label: "Open PR" });
    }
    const session = sessionId ?? (intent.scope.sessionIds.length === 1 ? intent.scope.sessionIds[0] : undefined);
    if (session) {
      links.sessionId = session;
      actions.push({ type: "open_session", sessionId: session, label: "Open session" });
    }
    if (intent.scope.projectIds.length === 1) links.projectId = intent.scope.projectIds[0];
    const fingerprint = intent.source.type === "portal_sessions" && session ? `intent_update:${intent.id}:${session}` : `intent_update:${intent.id}`;
    const existing = await hub.store.findItemByFingerprint(fingerprint);
    const fields = { title: short(title, 200), body: short(body, 2000), links, actions };
    const item = existing ? await hub.store.updateItem(existing.id, fields) : await hub.store.createItem({ ...fields, kind: "intent_update", fingerprint });
    hub.emit({ type: "items", items: await hub.store.listItems() });
    return item;
  }

  /** The item an expired watch leaves: it stopped, and the Watches page re-activates it. */
  async function raiseExpired(intent: Intent): Promise<void> {
    const fingerprint = `intent_expired:${intent.id}`;
    const fields = {
      title: short(`Watch expired: ${intent.text}`, 200),
      body: `This watch stopped at ${new Date(intent.expiresAt ?? hub.timers.now()).toISOString()}. Re-activate it in Watches to keep watching for another week.`,
      links: { intentId: intent.id, ...(intent.threadId ? { threadId: intent.threadId } : {}) } as ItemLinks, actions: [] as ItemAction[],
    };
    const existing = await hub.store.findItemByFingerprint(fingerprint);
    if (existing) await hub.store.updateItem(existing.id, fields);
    else await hub.store.createItem({ ...fields, kind: "intent_update", fingerprint });
    hub.emit({ type: "items", items: await hub.store.listItems() });
  }

  /**
   * Fire an intent if the rules allow it: count the firing, raise its item, and finish the intent
   * when that spent its budget.
   */
  async function fire(id: string, { title, body, item = true, sessionId }: { title: string; body: string; item?: boolean; sessionId?: string }, how: How & { touched?: Set<string> }) {
    const now = hub.timers.now();
    // The rules are judged and the firing counted on the intent as stored, in one update.
    let refused = null as Refusal | null;
    const fired = await store.updateIntent(id, (current) => {
      refused = refusal(current, now, title, how.actor);
      return refused ? null : { fires: current.fires + 1, lastFiredAt: now, lastFiredTitle: short(title, 200) };
    });
    if (refused) {
      if (refused.close) await close(id, refused.close, { actor: "system", ...(refused.close === "done" ? { reason: "fire budget spent" } : {}) });
      return { fired: false as const, reason: refused.reason };
    }
    const raised = item ? await raiseItem(fired, title, body, sessionId) : null;
    if (raised) how.touched?.add(raised.id);
    void hub.activity.log({
      actor: how.actor, kind: "intent.fired", summary: `Fired: ${short(title, 160)}`,
      refs: { ...intentRefs(fired, how.runId), ...(raised ? { itemId: raised.id } : {}), ...(sessionId ? { sessionId } : {}) }, detail: { fires: fired.fires, fireBudget: fired.fireBudget },
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

  /**
   * An active intent stored before scopes held full ids, with each prefix that names one known
   * session or project expanded and saved, and its live item's links too. Every check runs it rather
   * than boot: a check is where a prefix does harm (a lookup that reads like a deletion), the
   * sessions are all known by then, and a full scope writes nothing. A prefix that names nothing or
   * several is left as it is.
   */
  async function repaired(intent: Intent | null): Promise<Intent | null> {
    if (intent?.status !== "active") return intent;
    const known = await knownIds(hub.deps);
    const { scope, changed } = expandScope(intent.scope, known);
    if (!changed) return intent;
    const item = await hub.store.findItemByFingerprint(`intent_update:${intent.id}`);
    if (item) await hub.store.updateItem(item.id, mapRefs(item, (kind, id) => expandId(known, kind, id)));
    return store.updateIntent(intent.id, { scope });
  }

  /** What a run reads about each event: the session, what happened, and for a turn end what the agent said. */
  async function eventDetails(taken: WatchEvent[]): Promise<EventDetail[]> {
    const details: EventDetail[] = [];
    for (const [index, event] of taken.entries()) {
      const meta = await hub.deps.sessions.get(event.sessionId).catch(() => null);
      const detail: EventDetail = { event, title: meta?.title ?? null, agentName: meta?.agentName ?? null, state: meta?.liveness?.summary ?? null };
      if (index < DETAILED_EVENTS && event.kind === "turn_end" && meta) {
        const [progress, text] = await Promise.all([
          sessionProgress(hub.deps, event.sessionId).catch(() => null),
          reviewText(hub.deps, event.sessionId).catch(() => ""),
        ]);
        detail.outcome = progress?.note ?? null;
        detail.text = text.length > EVENT_TEXT_CAP ? `[earlier text omitted]\n${text.slice(text.length - EVENT_TEXT_CAP)}` : text;
      }
      details.push(detail);
    }
    return details;
  }

  /**
   * One run of a watch: a full agent turn over the watch (and the events that woke it), on the watch
   * role's model. Its final reply is the firing unless it is quiet.
   */
  async function runWatch(intent: Intent, { job, run, trigger, signal }: KindContext, taken: WatchEvent[]): Promise<KindResult> {
    const touched = new Set<string>();
    const threadId = intent.threadId ?? MAIN_THREAD_ID;
    const now = hub.timers.now();
    const sessionIds = isSessionSource(intent.source) ? [...new Set(taken.map((event) => event.sessionId))] : intent.scope.sessionIds;
    const sessions = sessionIds.length ? await hub.deps.sessions.list().catch(() => null) : null;
    const details = await eventDetails(taken);
    const prepared = await prepareTurn(hub, {
      kind: "intent_check", role: job.payload.role === "chat" ? "chat" : "watch", trigger, threadId, jobId: job.id, intentId: intent.id,
      interactive: false, fullTools: true, scope: { ...intent.scope, sessionIds: [...new Set([...intent.scope.sessionIds, ...sessionIds])] },
      query: `${intent.text}\n${intent.trigger}`, touched, summary: job.title,
    });
    if (!prepared) return { status: "failed", skipped: true, error: "not ready", summary: "No API key is stored; the watch did not run." };
    endings.set(prepared.run.id, null);
    let result: Awaited<ReturnType<typeof generateTurn>>;
    let ending: { status: "done" | "cancelled"; reason: string } | null = null;
    try {
      result = await generateTurn(prepared, { prompt: watchRunPrompt(intent, now, { events: details, sessions, sessionIds }), signal });
    } finally {
      ending = endings.get(prepared.run.id) ?? null;
      endings.delete(prepared.run.id);
    }
    const text = result.text.trim();
    let fired = false;
    let refusedBecause: string | null = null;
    if (!isQuiet(text)) {
      const sessionId = sessionIds.length === 1 ? sessionIds[0] : undefined;
      const outcome = await fire(intent.id, { title: firingTitle(text), body: text, sessionId }, { actor: "agent", runId: run.id, touched });
      fired = outcome.fired;
      if (!outcome.fired) refusedBecause = outcome.reason;
      if (fired) await core.postToThread(threadId, text, run, [...touched]);
    }
    if (!fired && touched.size > 0) hub.emit({ type: "items", items: await hub.store.listItems() });
    if (ending) await close(intent.id, ending.status, { actor: "agent", runId: run.id, reason: ending.reason });
    const quietReason = isQuiet(text) ? short(text.replace(/^\[quiet\]\s*/i, "").trim() || "nothing worth telling", 160) : null;
    return {
      summary: fired ? `Fired: ${short(firingTitle(text), 160)}` : refusedBecause ? `Not fired: ${short(refusedBecause, 160)}` : `Quiet: ${quietReason}`,
      result: { intentId: intent.id, fired, quiet: isQuiet(text), events: taken.map((event) => event.key), text: short(text, 2000) },
    };
  }

  /** One run of a watch's job. */
  async function check(ctx: KindContext): Promise<KindResult> {
    const { job, run } = ctx;
    const intentId = typeof job.payload.intentId === "string" ? job.payload.intentId : job.intentId;
    const intent = await repaired(intentId ? await store.getIntent(intentId) : null);
    if (!intent) return { summary: "Its watch no longer exists.", jobStatus: "cancelled" };
    if (intent.status !== "active") return { summary: `The watch is ${intent.status}.`, jobStatus: intent.status === "cancelled" ? "cancelled" : "done" };
    const now = hub.timers.now();
    if (intent.expiresAt !== null && intent.expiresAt <= now) {
      await close(intent.id, "expired", { actor: "system", runId: run.id });
      return { summary: "The watch expired.", jobStatus: "done" };
    }
    // A watch the server can evaluate itself needs no model turn.
    const review = reviewWatchOf(job.payload);
    if (review) return checkReview({ core, fire }, ctx, intent, review);
    const pull = pullWatchOf(job.payload);
    if (pull) return checkPull({ core, fire, close }, ctx, intent, pull);

    let outcome: KindResult;
    if (isSessionSource(intent.source)) {
      // Catch up on its own sessions first (a run is also the fallback for a missed event), then take what waits.
      if (events) {
        const metas = (await Promise.all(intent.source.sessionIds.map((id) => hub.deps.sessions.get(id).catch(() => null)))).filter((meta) => meta !== null);
        await events.absorb(intent, metas);
      }
      let taken: WatchEvent[] = [];
      const current = await store.updateIntent(intent.id, (stored) => {
        if (stored.status !== "active" || !stored.events.pending.length) return null;
        taken = stored.events.pending;
        return { events: { ...stored.events, pending: [], handled: [...stored.events.handled, ...taken.map((event) => event.key)] } };
      });
      if (!taken.length) return { summary: "No new events.", nextRunAt: null };
      try {
        outcome = await runWatch(current, ctx, taken);
      } catch (err) {
        // The events wait for the retry rather than being lost with the failed run.
        const keys = new Set(taken.map((event) => event.key));
        await store.updateIntent(intent.id, (stored) => ({
          events: { ...stored.events, pending: [...taken, ...stored.events.pending.filter((event) => !keys.has(event.key))], handled: stored.events.handled.filter((key) => !keys.has(key)) },
        })).catch(() => {});
        throw err;
      }
      if (outcome.skipped) {
        await store.updateIntent(intent.id, (stored) => ({ events: { ...stored.events, pending: [...taken, ...stored.events.pending] } })).catch(() => {});
      }
    } else {
      outcome = await runWatch(intent, ctx, []);
    }
    const after = (await store.getIntent(intent.id)) ?? intent;
    if (after.status === "active") await store.updateIntent(intent.id, { lastCheckedAt: hub.timers.now() });
    await core.emitIntents();
    const waiting = after.status === "active" && isSessionSource(after.source) && after.events.pending.length > 0;
    return {
      ...outcome,
      ...(after.status !== "active" ? { jobStatus: after.status === "cancelled" ? "cancelled" as const : "done" as const } : {}),
      ...(isSessionSource(intent.source) && !outcome.skipped && after.status === "active" ? { nextRunAt: waiting ? hub.timers.now() : null } : {}),
    };
  }

  // Cancelling an intent's check job (from the UI or a tool) cancels the intent it serves.
  core.onCheckJobCancelled = async (job, how) => {
    if (job.intentId && (await checkJobs(job.intentId)).length === 0) await close(job.intentId, "cancelled", { ...how, reason: "its check job was cancelled" });
  };

  return {
    create, update, close, reopen, renew, fire, expireDue, check, requireIntent, checkJobs, lifetime, requestEnd,
    bindEvents(part: WatchEventsApi) { events = part; },
  };
}

/** How a watch is woken, in words for the activity log and the tools. */
export function describeSource(intent: Pick<Intent, "source">, schedule?: JobSchedule): string {
  switch (intent.source.type) {
    case "session": return `on events of ${intent.source.sessionIds.length === 1 ? "its session" : `${intent.source.sessionIds.length} sessions`}`;
    case "portal_sessions": return "on events of every session Portal starts";
    case "pull": return "on changes of its PR";
    case "review": return "until its reviews finish";
    case "poll": return schedule ? `checked ${describeSchedule(schedule)}` : "checked on a schedule";
  }
}
