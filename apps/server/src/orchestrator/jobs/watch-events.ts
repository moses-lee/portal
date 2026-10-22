/**
 * Session watches without a model: Portal sees a watched session's turn end, its permission wait,
 * or its stall as it happens, and only then does the watch run (docs/WATCHES.md). Every event is
 * read off the session's state with a stable key (`sessionEventsOf`), so the same function serves
 * the live path (a session changed), the catch-up pass (at start and every few minutes, for what a
 * restart or a dropped listener missed), and a watch's own run; a key already handled is never
 * handled again.
 *
 * An event the user saw happen (the session was in a device's focused, visible pane) is recorded
 * as seen and not reported. The standing rule ("report on sessions Portal starts") is one watch of
 * source `portal_sessions`; `sessionStarted` adds each session Portal starts to it.
 */
import type { ActivityActor } from "@portal/contracts/activity";
import type { Intent, IntentStatus, Job, SessionEventKind, WatchEvent, WatchEvents, WatchSource } from "@portal/contracts/jobs";
import type { SessionMeta } from "../../lib/types.ts";
import type { IntentInput } from "../hub.ts";
import type { JobsCore } from "./core.ts";
import { noEvents } from "./store.ts";

/** What the engine needs of the intents part (named here, so the two parts' types do not refer to each other). */
export type WatchIntents = {
  create(input: IntentInput, how: { actor: ActivityActor }): Promise<{ intent: Intent; job: Job }>;
  close(id: string, status: Exclude<IntentStatus, "active">, how: { actor: ActivityActor; reason?: string }): Promise<Intent>;
  checkJobs(intentId: string): Promise<Job[]>;
  lifetime(asked: number | null | undefined, now: number): number;
};

/** How often every session watch is compared with its sessions' state, for events the live path missed. */
export const CATCH_UP_MS = 10 * 60_000;
/** A session watch's job is unscheduled between events; this nominal cadence only names it. */
export const EVENT_JOB_EVERY_MS = 24 * 60 * 60_000;

export const RULE_TEXT = "Report on every session Portal starts";
const RULE_TRIGGER = "A session Portal started finishes a turn, waits on a permission, or stalls (hung, or its agent was lost).";
const RULE_ACTION = "Tell the user what happened, with the session's findings in brief. Never prompt the session.";

type SessionSource = Extract<WatchSource, { type: "session" | "portal_sessions" }>;

export const isSessionSource = (source: WatchSource): source is SessionSource => source.type === "session" || source.type === "portal_sessions";

/**
 * The event a session's state shows now, if any. A stall (hung, or dead after its agent was lost)
 * is keyed by when it began; a permission wait by the prompt it belongs to (one report per prompt,
 * however many it asks); a turn end by when it ended, and only once the session is settled: not
 * busy, nothing queued to start the next turn, no permission open.
 */
export function sessionEventsOf(meta: SessionMeta, now: number): WatchEvent[] {
  const live = meta.liveness;
  if (live && (live.state === "dead" || live.state === "hung")) {
    const since = live.lost?.at ?? live.turnStartedAt ?? meta.lastActiveAt;
    return [{ key: `${meta.id}:stalled:${live.state}:${since}`, kind: "stalled", sessionId: meta.id, at: now }];
  }
  if (meta.awaitingPermission) return [{ key: `${meta.id}:permission:${meta.lastActiveAt}`, kind: "permission", sessionId: meta.id, at: now }];
  if (!meta.busy && meta.turnEndedAt != null && (meta.queue?.length ?? 0) === 0) {
    return [{ key: `${meta.id}:turn:${meta.turnEndedAt}`, kind: "turn_end", sessionId: meta.id, at: meta.turnEndedAt }];
  }
  return [];
}

/** The events of `metas` a watch with `source` reports. */
function eventsFor(source: SessionSource, metas: SessionMeta[], now: number): WatchEvent[] {
  const kinds = new Set<SessionEventKind>(source.on);
  return metas.filter((meta) => source.sessionIds.includes(meta.id)).flatMap((meta) => sessionEventsOf(meta, now)).filter((event) => kinds.has(event.kind));
}

/** `events` with every event of `metas` marked handled: what a watch starts from, so it never reports what happened before it. */
export function baseline(events: WatchEvents, source: SessionSource, metas: SessionMeta[], now: number): WatchEvents {
  const keys = eventsFor(source, metas, now).map((event) => event.key);
  return { ...events, handled: [...events.handled, ...keys.filter((key) => !events.handled.includes(key))] };
}

export type WatchEventsPart = ReturnType<typeof createWatchEvents>;

export function createWatchEvents(core: JobsCore, intents: WatchIntents) {
  const { hub, store } = core;
  const now = () => hub.timers.now();
  /** Active session watches as last announced (refreshed on every `intents` event and each catch-up). */
  let watched: Intent[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let catchUpTimer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const remember = (active: Intent[]) => { watched = active.filter((intent) => isSessionSource(intent.source)); };
  async function sessionWatches(): Promise<Intent[]> {
    if (!watched) remember(await store.listIntents({ status: ["active"] }));
    return watched ?? [];
  }

  /** Run `task` after every earlier one, so two changes of one session never interleave; never rejects. */
  function serial(task: () => Promise<void>): Promise<void> {
    const next = chain.then(task).catch((err: unknown) => console.error("A watch could not take a session event:", err));
    chain = next;
    return next;
  }

  /**
   * Add what `metas` show to the watch's events: new ones wait for its run, or count as seen when
   * the user had the session in front of them. Answers whether any now waits.
   */
  async function absorb(intent: Intent, metas: SessionMeta[]): Promise<boolean> {
    if (!isSessionSource(intent.source)) return false;
    let found = eventsFor(intent.source, metas, now());
    if (intent.source.type === "portal_sessions") {
      // A session with a watch of its own is reported there; the rule stays out so nothing is said twice.
      const own = new Set((await sessionWatches()).flatMap((other) => (other.source.type === "session" ? other.source.sessionIds : [])));
      found = found.filter((event) => !own.has(event.sessionId));
    }
    if (!found.length) return intent.events.pending.length > 0;
    const watching = (sessionId: string) => hub.presence.watching?.(sessionId) ?? false;
    const stored = await store.updateIntent(intent.id, (current) => {
      if (current.status !== "active") return null;
      const { pending, handled, seen } = current.events;
      const known = new Set([...handled, ...pending.map((event) => event.key)]);
      const fresh = found.filter((event) => !known.has(event.key));
      if (!fresh.length) return null;
      const looked = fresh.filter((event) => watching(event.sessionId));
      const waiting = fresh.filter((event) => !looked.includes(event));
      return { events: { pending: [...pending, ...waiting], handled: [...handled, ...looked.map((event) => event.key)], seen: [...seen, ...looked] } };
    });
    return stored.status === "active" && stored.events.pending.length > 0;
  }

  /** Schedule the watch's job now (its run takes the waiting events). */
  async function wake(intentId: string): Promise<void> {
    const [job] = await store.listJobs({ intentId, kind: ["intent_check"], status: ["active"] });
    if (!job) return;
    if (job.nextRunAt === null || job.nextRunAt > now()) await store.updateJob(job.id, { nextRunAt: now() });
    core.notify();
  }

  /** A session was deleted: it leaves every watch, and a session watch left with none is done. */
  async function sessionGone(sessionId: string): Promise<void> {
    for (const intent of await sessionWatches()) {
      if (!isSessionSource(intent.source) || !intent.source.sessionIds.includes(sessionId)) continue;
      const sessionIds = intent.source.sessionIds.filter((id) => id !== sessionId);
      if (intent.source.type === "session" && sessionIds.length === 0) {
        await intents.close(intent.id, "done", { actor: "system", reason: "its session was removed" });
        continue;
      }
      await store.updateIntent(intent.id, (current) => (isSessionSource(current.source)
        ? { source: { ...current.source, sessionIds: current.source.sessionIds.filter((id) => id !== sessionId) } }
        : null));
    }
    watched = null;
    await core.emitIntents();
  }

  async function sessionChanged(sessionId: string): Promise<void> {
    const watching = (await sessionWatches()).filter((intent) => isSessionSource(intent.source) && intent.source.sessionIds.includes(sessionId));
    if (!watching.length) return;
    const meta = await hub.deps.sessions.get(sessionId);
    if (!meta) return;
    for (const intent of watching) {
      if (await absorb(intent, [meta])) await wake(intent.id);
    }
  }

  /** Compare every session watch with its sessions' state; wake the ones with events waiting. */
  async function catchUp(): Promise<void> {
    const active = await store.listIntents({ status: ["active"] });
    remember(active);
    const watches = active.filter((intent) => isSessionSource(intent.source));
    if (!watches.length) return;
    const metas = await hub.deps.sessions.list();
    for (const intent of watches) {
      if (await absorb(intent, metas)) await wake(intent.id);
    }
  }

  function armCatchUp() {
    if (stopped) return;
    catchUpTimer = hub.timers.setTimeout(() => {
      catchUpTimer = null;
      void serial(catchUp).finally(armCatchUp);
    }, CATCH_UP_MS);
  }

  /** The standing rule, active or not; null before `ensureRule` made it. */
  async function rule(): Promise<Intent | null> {
    return (await store.listIntents()).find((intent) => intent.source.type === "portal_sessions") ?? null;
  }

  /** Make the standing rule, on, watching `sessionIds` from what they show now. */
  async function makeRule(sessionIds: string[], metas: SessionMeta[]): Promise<Intent> {
    const source: SessionSource = { type: "portal_sessions", sessionIds, on: ["turn_end", "permission", "stalled"] };
    const { intent } = await intents.create({
      text: RULE_TEXT, trigger: RULE_TRIGGER, action: RULE_ACTION, fireBudget: null, cooldownMs: 0, expiresAt: null, source,
      events: baseline(noEvents(), source, metas, now()), check: { type: "every", everyMs: EVENT_JOB_EVERY_MS },
    }, { actor: "system" });
    return intent;
  }

  /**
   * Move the watches made before sources onto them, once (while no standing rule exists yet): a
   * per-session "always watch" watch hands its sessions to a new standing rule and ends; any other
   * model-checked watch on sessions becomes a session watch; every live watch gets an expiry. The
   * rule is otherwise made by the first session Portal starts.
   */
  async function migrateLegacy(): Promise<void> {
    if (await rule()) return;
    const legacy = (await store.listIntents({ status: ["active"] })).filter((intent) => intent.source.type === "poll");
    if (!legacy.length) return;
    const metas = await hub.deps.sessions.list().catch(() => [] as SessionMeta[]);
    const t = now();
    const handOver = legacy.filter((intent) => intent.scope.sessionIds.length > 0 && /always watch|watch every session|watch (the )?sessions portal starts/i.test(intent.text));
    if (handOver.length) {
      await makeRule([...new Set(handOver.flatMap((intent) => intent.scope.sessionIds))].filter((id) => metas.some((meta) => meta.id === id)), metas);
      for (const intent of handOver) await intents.close(intent.id, "done", { actor: "system", reason: "the standing rule for sessions Portal starts covers it now" });
    }
    for (const intent of legacy) {
      if (handOver.includes(intent)) continue;
      const jobs = await intents.checkJobs(intent.id);
      const deterministic = jobs.some((job: Job) => job.payload.review || job.payload.pull);
      if (deterministic) continue;
      const expiresAt = intents.lifetime(intent.expiresAt, t);
      if (intent.scope.sessionIds.length === 0) {
        if (intent.expiresAt !== expiresAt) await store.updateIntent(intent.id, { expiresAt });
        continue;
      }
      const converted: SessionSource = { type: "session", sessionIds: intent.scope.sessionIds, on: ["turn_end", "permission", "stalled"] };
      await store.updateIntent(intent.id, (current) => ({ source: converted, events: baseline(current.events, converted, metas, t), expiresAt, fireBudget: null, cooldownMs: 0 }));
      for (const job of jobs) await store.updateJob(job.id, { schedule: { type: "every", everyMs: EVENT_JOB_EVERY_MS }, nextRunAt: null });
    }
    watched = null;
    await core.emitIntents();
  }

  return {
    absorb,
    baseline: (events: WatchEvents, source: SessionSource, metas: SessionMeta[]) => baseline(events, source, metas, now()),
    rule,
    remember,
    catchUp: () => serial(catchUp),
    /** A session Portal started joins the standing rule while it is on; review sessions have their own watch and stay out. */
    async sessionStarted(sessionId: string): Promise<void> {
      const current = await rule();
      const meta = await hub.deps.sessions.get(sessionId).catch(() => null);
      if (!current) {
        // The first session Portal starts makes the rule (on); one the user turned off stays off.
        await makeRule([sessionId], meta ? [meta] : []);
        watched = null;
        return;
      }
      if (current.status !== "active" || !isSessionSource(current.source) || current.source.sessionIds.includes(sessionId)) return;
      await store.updateIntent(current.id, (stored) => {
        if (!isSessionSource(stored.source) || stored.source.sessionIds.includes(sessionId)) return null;
        const source = { ...stored.source, sessionIds: [...stored.source.sessionIds, sessionId] };
        return { source, events: meta ? baseline(stored.events, source, [meta], now()) : stored.events };
      });
      watched = null;
      await core.emitIntents();
    },
    async start(): Promise<void> {
      stopped = false;
      await migrateLegacy().catch((err: unknown) => console.error("Could not move the older watches onto session events:", err));
      unsubscribe = hub.deps.sessions.onChange?.((id, change) => {
        void serial(() => (change === "deleted" ? sessionGone(id) : sessionChanged(id)));
      }) ?? null;
      await serial(catchUp);
      armCatchUp();
    },
    stop(): void {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      if (catchUpTimer !== null) hub.timers.clearTimeout(catchUpTimer);
      catchUpTimer = null;
    },
  };
}
