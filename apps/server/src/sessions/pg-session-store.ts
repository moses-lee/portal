/**
 * Postgres-backed session store: one row per session, one row per event. The event log is read
 * backwards with `ORDER BY seq DESC LIMIT n`, so serving the latest page costs the same however
 * long the log is. Appends for one session are chained so they land in order even when callers
 * do not await each other. Values are stripped of U+0000 on the way in, which Postgres cannot store:
 * an agent's tool output may carry it, and the event would otherwise fail to save.
 */
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { StoredEvent } from "@portal/contracts/types";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { sessionEvents, sessions } from "../db/schema.ts";
import type { SessionRecord, SessionStore, TailQuery, TailResult } from "./store.ts";

type Row = typeof sessions.$inferSelect;

/** Postgres `foreign_key_violation`; Drizzle wraps the driver error as `cause`. */
function isForeignKeyViolation(err: unknown): boolean {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return code(err) === "23503" || code((err as { cause?: unknown } | null)?.cause) === "23503";
}

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    cwd: row.cwd,
    projectId: row.projectId,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    title: row.title,
    upstreamId: row.upstreamId,
    state: row.state,
    lost: row.lost ?? null,
  };
}

export function createPgSessionStore({ db }: { db: Db }): SessionStore {
  let closed = false;
  /** Per-session append chains, dropped once idle so the map does not grow with every session ever seen. */
  const chains = new Map<string, Promise<unknown>>();

  function assertOpen() {
    if (closed) throw new Error("Session store is disposed");
  }

  async function append(id: string, raw: StoredEvent) {
    assertOpen();
    const event = stripNul(raw);
    // Reject seqs at or below the highest stored one in the same statement that inserts, so two
    // racing appends cannot both pass a separate check.
    let inserted: { seq: number }[];
    try {
      inserted = await db
        .insert(sessionEvents)
        .select(
          db
            .select({ sessionId: sql`${id}`.as("session_id"), seq: sql`${event.seq}::integer`.as("seq"), ts: sql`${event.ts}::bigint`.as("ts"), body: sql`${JSON.stringify(event)}::jsonb`.as("body") })
            .from(sql`(select 1) as one`)
            .where(sql`not exists (select 1 from ${sessionEvents} where ${sessionEvents.sessionId} = ${id} and ${sessionEvents.seq} >= ${event.seq})`),
        )
        .returning({ seq: sessionEvents.seq });
    } catch (err) {
      if (isForeignKeyViolation(err)) throw new Error(`No such session: ${id}`);
      throw err;
    }
    if (inserted.length === 0) {
      const next = await count(id);
      if (next === 0 && !(await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id))).length) throw new Error(`No such session: ${id}`);
      throw new Error(`Out-of-order append: log already holds seq ${event.seq} (next is ${next})`);
    }
  }

  async function count(id: string): Promise<number> {
    const [row] = await db
      .select({ next: sql<number>`coalesce(max(${sessionEvents.seq}) + 1, 0)::integer` })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, id));
    return row?.next ?? 0;
  }

  return {
    ready: Promise.resolve(),

    async listSessions() {
      const rows = await db.select().from(sessions).orderBy(asc(sessions.ordinal));
      return rows.map(toRecord);
    },

    async getSession(id) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      return row ? toRecord(row) : undefined;
    },

    async putSession(record) {
      assertOpen();
      const { id, ...rest } = stripNul(record);
      await db
        .insert(sessions)
        .values({ id, ...rest })
        .onConflictDoUpdate({ target: sessions.id, set: rest });
    },

    async deleteSession(id) {
      assertOpen();
      await db.delete(sessions).where(eq(sessions.id, id));
    },

    appendEvent(id, event) {
      const previous = chains.get(id) ?? Promise.resolve();
      const run = previous.then(() => append(id, event));
      const settled = run.catch(() => {}).then(() => {
        if (chains.get(id) === settled) chains.delete(id);
      });
      chains.set(id, settled);
      return run;
    },

    async readTail(id, { beforeSeq, limit }: TailQuery): Promise<TailResult> {
      const before = beforeSeq === undefined ? [] : [lt(sessionEvents.seq, beforeSeq)];
      if (limit <= 0) {
        const [row] = await db.select({ seq: sessionEvents.seq }).from(sessionEvents).where(and(eq(sessionEvents.sessionId, id), ...before)).limit(1);
        return { events: [], hasMore: row !== undefined };
      }
      // Fetch one extra row to learn whether anything older exists.
      const rows = await db
        .select({ body: sessionEvents.body })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.sessionId, id), ...before))
        .orderBy(desc(sessionEvents.seq))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = (hasMore ? rows.slice(0, limit) : rows).reverse();
      return { events: page.map((row) => row.body), hasMore };
    },

    eventCount: count,

    async dispose() {
      closed = true;
      await Promise.allSettled([...chains.values()]);
    },
  };
}
