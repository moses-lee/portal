/**
 * Fills `session_messages` (global search, docs/SEARCH.md) for logs written before the table
 * existed or by the legacy import, which bypass the store's append. Runs once in the background
 * after boot, so neither the boot nor the first request waits on it, and logs once when done.
 *
 * Per session, it reads only the events no message row covers: those below where the lowest row
 * starts and those above where the highest ends. Live appends only ever add at the top, so before a
 * session is backfilled its rows (if any) all sit above its older events; afterwards both walks
 * are a handful of rows. Rows are keyed as the store keys them (`search-index.ts`): a reply cut by
 * either edge is joined to the row on the other side, so no reply is split or indexed twice. Each session is one transaction, so a backfill cut short (shutdown, a
 * crash) leaves the session as it found it rather than with a hole the next pass could not see.
 * Inserts skip rows already there, so a pass repeating one is harmless; a pass reads only events
 * committed when it reached the session, so it never touches the rows a live append is writing.
 */
import { and, asc, desc, eq, gt, lt, lte, max, min, sql } from "drizzle-orm";
import type { StoredEvent } from "@portal/contracts/types";
import type { Db } from "../db/client.ts";
import { sessionEvents, sessionMessages, sessions } from "../db/schema.ts";
import { isForeignKeyViolation } from "./pg-session-store.ts";
import { insertMessageRows, joinEarlierReply, joinLaterReply } from "./search-index.ts";
import { messageRowsFrom, trailingReplyRun } from "./search-messages.ts";

/** Events read per page; only the few fields search needs come over the wire, never tool output. */
const PAGE = 2000;
/** How long after boot the backfill starts, so the boot's own reads go first. */
export const BACKFILL_AFTER_MS = 5_000;

export type BackfillResult = { sessions: number; rows: number; failed: number; ms: number };

export interface MessageBackfill {
  /** Run a pass now (or join the running one). */
  run(): Promise<BackfillResult>;
  /** Stop: a session in progress rolls back, and no new pass starts. */
  dispose(): Promise<void>;
}

class Stopped extends Error {}

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

type Projected = { seq: number; ts: number; type: string | null; kind: string | null; text: string | null };

/** The projected row as just enough of an event for `messageRowsFrom`; anything else stands in as a run breaker. */
function toEvent({ seq, ts, type, kind, text }: Projected): StoredEvent {
  if (type === "user" && text !== null) return { type: "user", text, seq, ts };
  if (type === "update" && kind === "agent_message_chunk" && text !== null) {
    return { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, seq, ts } as StoredEvent;
  }
  return { type: "turn_start", seq, ts };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Index one session's unindexed events; answers the rows written. */
async function backfillSession(tx: Tx, sessionId: string, stopped: () => boolean): Promise<number> {
  const [bounds] = await tx
    .select({ low: min(sessionMessages.firstSeq), high: max(sessionMessages.seq) })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));
  // Only events committed before this pass looked: a live append in flight writes above them, so
  // the two never wait on each other's uncommitted rows.
  const [top] = await tx.select({ seq: max(sessionEvents.seq) }).from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
  if (top?.seq === null || top?.seq === undefined) return 0;
  const end = lte(sessionEvents.seq, top.seq);
  const low = bounds?.low ?? null;
  const walks = low === null
    ? [{ range: end, below: null }]
    : [{ range: lt(sessionEvents.seq, low), below: low }, { range: and(gt(sessionEvents.seq, bounds?.high ?? low), end), below: null }];
  let written = 0;
  for (const { range, below } of walks) {
    let cursor = -1;
    let carry: StoredEvent[] = [];
    for (;;) {
      if (stopped()) throw new Stopped();
      const page = await tx
        .select({
          seq: sessionEvents.seq,
          ts: sessionEvents.ts,
          type: sql<string | null>`${sessionEvents.body}->>'type'`,
          kind: sql<string | null>`${sessionEvents.body}->'update'->>'sessionUpdate'`,
          text: sql<string | null>`case
            when ${sessionEvents.body}->>'type' = 'user' then ${sessionEvents.body}->>'text'
            when ${sessionEvents.body}->'update'->>'sessionUpdate' = 'agent_message_chunk' and ${sessionEvents.body}->'update'->'content'->>'type' = 'text'
              then ${sessionEvents.body}->'update'->'content'->>'text'
          end`,
        })
        .from(sessionEvents)
        .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, cursor), range))
        .orderBy(asc(sessionEvents.seq))
        .limit(PAGE);
      const events = [...carry, ...page.map(toEvent)];
      const last = page.length < PAGE;
      // A reply run cut by the page edge waits for the rest of it.
      const held = last ? 0 : trailingReplyRun(events);
      carry = events.slice(events.length - held);
      const ready = events.slice(0, events.length - held);
      if (ready.length > 0) {
        let rows = await joinEarlierReply(tx, sessionId, messageRowsFrom(ready), ready[0].seq);
        // The walk below the indexed rows ends right before the lowest one starts.
        if (last && below !== null) rows = await joinLaterReply(tx, sessionId, rows, ready[ready.length - 1].seq, below);
        written += await insertMessageRows(tx, sessionId, rows);
      }
      if (last) break;
      cursor = page[page.length - 1].seq;
    }
  }
  return written;
}

/** One pass over every session, most recently active first. */
async function backfillAll(db: Db, log: Log, stopped: () => boolean): Promise<BackfillResult> {
  const started = Date.now();
  const ids = await db.select({ id: sessions.id }).from(sessions).orderBy(desc(sessions.lastActiveAt));
  const result = { sessions: 0, rows: 0, failed: 0, ms: 0 };
  for (const { id } of ids) {
    if (stopped()) throw new Stopped();
    try {
      result.rows += await db.transaction((tx) => backfillSession(tx, id, stopped));
      result.sessions++;
    } catch (err) {
      if (err instanceof Stopped) throw err;
      // Deleted while it was being read: nothing left to index.
      if (isForeignKeyViolation(err)) continue;
      result.failed++;
      log.warn({ err, sessionId: id }, "Could not index a session's messages for search");
    }
  }
  result.ms = Date.now() - started;
  return result;
}

export function createMessageBackfill(
  { db, log }: { db: Db; log: Log },
  { start = true, afterMs = BACKFILL_AFTER_MS }: { start?: boolean; afterMs?: number } = {},
): MessageBackfill {
  let disposed = false;
  let running: Promise<BackfillResult> | null = null;
  const stopped = () => disposed;

  function run(): Promise<BackfillResult> {
    if (disposed) return Promise.reject(new Error("Portal is shutting down."));
    running ??= backfillAll(db, log, stopped).finally(() => { running = null; });
    return running;
  }

  const timer = start
    ? setTimeout(() => {
      run().then(
        (result) => log.info(result, "Indexed session messages for search"),
        (err: unknown) => { if (!(err instanceof Stopped)) log.warn({ err }, "Could not index session messages for search"); },
      );
    }, afterMs)
    : null;
  timer?.unref();

  return {
    run,
    async dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => {});
    },
  };
}
