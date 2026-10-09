/**
 * The room's census (docs/PALACE.md, Census service): the counts behind the accumulated objects,
 * with high-water marks so they never go down, and the milestones they reached.
 *
 * Counted from the stores the orchestrator's services use, read here directly so the census works
 * without the orchestrator: the sessions list, memory (`active` records, the `proposed` inbox),
 * intents (watches), standing approval grants (not revoked), and the activity log (the last hour).
 *
 * The high-water marks (`sessionsEver`, `watches.ever`, `watches.fires`, and every milestone input,
 * so the memory high-water too), `since`, and the reached milestones live in one `settings` row
 * (`key = 'room'`), with the same load/save split and serialised writes as the workspace row. A
 * purge lowers the live counts only. A milestone is stored before it is logged to Activity as
 * `room.expanded`, so a restart never logs it twice.
 *
 * Cached 60 seconds. A new session, a change to watches, memory or grants (the orchestrator's
 * events), and any Activity entry schedule a recompute a few seconds later; while a browser holds a
 * stream open the census is recomputed once a minute so the hearth cools. Listeners hear about a
 * change to the counts or milestones, never about the first computation (nobody saw one before).
 */
import { eq } from "drizzle-orm";
import type { ActivityInput } from "@portal/contracts/activity";
import type { RoomCensus, RoomMilestone } from "@portal/contracts/room";
import { milestonesReached } from "@portal/shared/room";
import type { AppContext } from "../context.ts";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { settings } from "../db/schema.ts";
import { createPgActivityStore } from "../orchestrator/activity/pg-store.ts";
import { createPgApprovalStore } from "../orchestrator/approvals/pg-store.ts";
import { createPgJobsStore } from "../orchestrator/jobs/pg-store.ts";
import { createPgMemoryStore } from "../orchestrator/memory/pg-store.ts";
import type { OrchestratorEvent } from "../orchestrator/types.ts";

/** The `settings` row that holds the high-water marks, `since`, and the milestones. */
export const ROOM_KEY = "room";
/** How long a computed census answers every reader. */
export const CENSUS_CACHE_MS = 60_000;
/** How long after a change event the census is recomputed; events meanwhile share the one recompute. */
export const CENSUS_SETTLE_MS = 3_000;
const HOUR_MS = 3_600_000;

/** What the `room` row holds. The counts are high-water marks; `memoryActive` is the memory milestones' input. */
export type StoredRoom = {
  sessionsEver: number;
  memoryActive: number;
  watchesEver: number;
  fires: number;
  since: number | null;
  milestones: RoomMilestone[];
};

export type RoomCensusSnapshot = { census: RoomCensus; milestones: RoomMilestone[] };

export interface RoomCensusBackend {
  load(): Promise<unknown>;
  save(room: StoredRoom): Promise<void>;
}

export type RoomCensusOptions = {
  now?: () => number;
  /** The settings row's backend; the database row unless given. */
  backend?: RoomCensusBackend;
  /** How long after a change event to recompute (tests shorten it). */
  settleMs?: number;
  /** How often to recompute while a browser is present; 0 turns it off. */
  censusEveryMs?: number;
};

export interface RoomCensusService {
  /** The census and milestones, from the cache when it is under 60 seconds old; `force` recomputes. */
  current(options?: { force?: boolean }): Promise<RoomCensusSnapshot>;
  /** Recompute a few seconds from now (something the census counts changed). */
  schedule(): void;
  /** Called with the new snapshot whenever the counts or milestones change; answers the unsubscribe function. */
  subscribe(listener: (snapshot: RoomCensusSnapshot) => void): () => void;
  dispose(): void;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

function isMilestone(value: unknown): value is RoomMilestone {
  if (!value || typeof value !== "object") return false;
  const { id, at, summary } = value as Record<string, unknown>;
  return typeof id === "string" && typeof at === "number" && typeof summary === "string";
}

/** The stored row as `StoredRoom`; a missing row (or a missing field) reads as nothing counted yet. */
export function parseStoredRoom(raw: unknown): StoredRoom {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    sessionsEver: count(body.sessionsEver),
    memoryActive: count(body.memoryActive),
    watchesEver: count(body.watchesEver),
    fires: count(body.fires),
    since: typeof body.since === "number" && Number.isFinite(body.since) ? body.since : null,
    milestones: Array.isArray(body.milestones) ? body.milestones.filter(isMilestone) : [],
  };
}

/** The `room` settings row. */
export function createPgRoomBackend(db: Db): RoomCensusBackend {
  return {
    async load() {
      const [row] = await db.select({ body: settings.body }).from(settings).where(eq(settings.key, ROOM_KEY));
      return row?.body ?? null;
    },
    async save(room) {
      const body = stripNul(room) as unknown as Record<string, unknown>;
      const now = Date.now();
      await db
        .insert(settings)
        .values({ key: ROOM_KEY, body, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { body, updatedAt: now } });
    },
  };
}

/** Orchestrator events after which the census may have changed. `activity` covers grants and every count of the hearth. */
const changeEvents = new Set<OrchestratorEvent["type"]>(["activity", "intents", "memory"]);

export function createRoomCensus(
  ctx: Pick<AppContext, "db" | "log" | "presence" | "sessions"> & { orchestrator?: AppContext["orchestrator"] },
  { now = Date.now, backend = createPgRoomBackend(ctx.db), settleMs = CENSUS_SETTLE_MS, censusEveryMs = CENSUS_CACHE_MS }: RoomCensusOptions = {},
): RoomCensusService {
  const memory = createPgMemoryStore({ db: ctx.db });
  const jobs = createPgJobsStore({ db: ctx.db });
  const approvals = createPgApprovalStore({ db: ctx.db });
  const activity = createPgActivityStore({ db: ctx.db });
  const listeners = new Set<(snapshot: RoomCensusSnapshot) => void>();

  let cached: { snapshot: RoomCensusSnapshot; at: number; fingerprint: string } | null = null;
  let inflight: Promise<RoomCensusSnapshot> | null = null;
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Sessions created since the last computation, so one created and purged in between still counts. */
  let created = 0;

  /** Through the orchestrator when it runs, so the entry is pushed to the page too. */
  async function record(input: ActivityInput): Promise<void> {
    if (ctx.orchestrator) {
      await ctx.orchestrator.hub.activity.log(input);
      return;
    }
    try {
      await activity.append({ at: input.at ?? now(), actor: input.actor, kind: input.kind, summary: input.summary, refs: input.refs ?? {}, detail: input.detail ?? null });
    } catch (err) {
      console.error(`Could not record activity "${input.kind}":`, err);
    }
  }

  async function compute(): Promise<RoomCensusSnapshot> {
    await ctx.sessions.ready;
    const t = now();
    // Read with the counter in one step, so a session created meanwhile is counted by one or the other.
    const sessions = ctx.sessions.listSessions();
    const createdHere = created;
    created = 0;
    try {
      const [memoryActive, memoryInbox, intents, grants, activityLastHour, stored] = await Promise.all([
        memory.countRecords({ status: ["active"] }),
        memory.countRecords({ status: ["proposed"] }),
        jobs.listIntents(),
        approvals.listGrants(),
        activity.countSince(t - HOUR_MS),
        backend.load().then(parseStoredRoom),
      ]);
      const active = intents.filter((intent) => intent.status === "active").length;
      const fires = intents.reduce((sum, intent) => sum + intent.fires, 0);
      const oldest = sessions.reduce<number | null>((min, session) => (min === null || session.createdAt < min ? session.createdAt : min), null);
      const next: StoredRoom = {
        sessionsEver: Math.max(stored.sessionsEver + createdHere, sessions.length),
        memoryActive: Math.max(stored.memoryActive, memoryActive),
        watchesEver: Math.max(stored.watchesEver, intents.length),
        fires: Math.max(stored.fires, fires),
        since: stored.since ?? oldest ?? t,
        milestones: stored.milestones,
      };
      const census: RoomCensus = {
        sessionsEver: next.sessionsEver,
        memoryActive,
        memoryInbox,
        watches: { active, finished: intents.length - active, fires: next.fires, ever: next.watchesEver },
        grants: grants.length,
        activityLastHour,
        since: next.since,
      };
      // Milestones read the high-water marks only, so a purge never takes one back.
      const reached = new Set(next.milestones.map((milestone) => milestone.id));
      const fresh = milestonesReached({ ...census, memoryActive: next.memoryActive }, t).filter((milestone) => !reached.has(milestone.id));
      next.milestones = [...next.milestones, ...fresh.map(({ id, summary }) => ({ id, at: t, summary }))];
      if (JSON.stringify(next) !== JSON.stringify(stored)) await backend.save(next);
      // Logged once stored: a failure between the two loses the entry rather than logging it twice.
      for (const milestone of fresh) {
        await record({ actor: "system", kind: "room.expanded", summary: milestone.summary, at: t, detail: { milestone: milestone.id, value: milestone.value } });
      }
      return { census, milestones: next.milestones };
    } catch (err) {
      created += createdHere;
      throw err;
    }
  }

  function notify(snapshot: RoomCensusSnapshot) {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("Room census listener failed:", err);
      }
    }
  }

  function current({ force = false }: { force?: boolean } = {}): Promise<RoomCensusSnapshot> {
    if (!force && cached && now() - cached.at < CENSUS_CACHE_MS) return Promise.resolve(cached.snapshot);
    if (inflight && !force) return inflight;
    // One computation at a time; a forced one waits for the one in flight and then counts again.
    const run = (inflight ?? Promise.resolve()).catch(() => {}).then(async () => {
      const snapshot = await compute();
      const fingerprint = JSON.stringify(snapshot);
      const changed = cached !== null && cached.fingerprint !== fingerprint;
      cached = { snapshot, at: now(), fingerprint };
      if (changed && !disposed) notify(snapshot);
      return snapshot;
    });
    inflight = run;
    const clear = () => {
      if (inflight === run) inflight = null;
    };
    run.then(clear, clear);
    return run;
  }

  const warn = (err: unknown) => ctx.log.warn(`Room: could not count the census (${err instanceof Error ? err.message : String(err)}).`);

  function schedule() {
    if (disposed || scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!disposed) current({ force: true }).catch(warn);
    }, settleMs);
    scheduled.unref?.();
  }

  const unsubscribeSessions = ctx.sessions.onSessionsChange((change) => {
    if (change.type !== "created") return;
    created += 1;
    schedule();
  });
  const unsubscribeOrchestrator = ctx.orchestrator
    ? ctx.orchestrator.subscribe((event) => {
        if (changeEvents.has(event.type)) schedule();
      })
    : () => {};
  // Only while someone looks: the hearth's last hour moves with the clock, not with events.
  const timer = censusEveryMs > 0
    ? setInterval(() => {
        if (ctx.presence.count() > 0) current({ force: true }).catch(warn);
      }, censusEveryMs)
    : null;
  timer?.unref?.();

  return {
    current,
    schedule,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      unsubscribeSessions();
      unsubscribeOrchestrator();
      if (scheduled) clearTimeout(scheduled);
      scheduled = null;
      if (timer) clearInterval(timer);
      listeners.clear();
    },
  };
}
