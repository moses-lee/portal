/**
 * Writes `session_messages` (global search) from events, for the store's appends and the boot
 * backfill alike, so the two key rows the same way: one row per prompt, one per reply covering
 * `first_seq..seq`. A reply the runtime wrote as several appends is joined across them: when the
 * first event written continues a reply whose row ends at the event just before it, that row is
 * taken out and its text leads the new one, which keeps the earlier row's start and time.
 */
import { and, eq, sql } from "drizzle-orm";
import type { StoredEvent } from "@portal/contracts/types";
import type { Db } from "../db/client.ts";
import { stripNul } from "../db/sanitize.ts";
import { sessionEvents, sessionMessages } from "../db/schema.ts";
import { type MessageRow, MESSAGE_TEXT_MAX, joinText, messageRowsFrom } from "./search-messages.ts";

type Writer = Pick<Db, "insert" | "delete" | "update">;

/** Insert rows, leaving any already there alone; answers how many were new. */
export async function insertMessageRows(db: Writer, sessionId: string, rows: MessageRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const written = await db.insert(sessionMessages)
    .values(rows.map((row) => ({ sessionId, seq: row.seq, firstSeq: row.firstSeq, role: row.role, ts: Math.round(row.ts), text: stripNul(row.text) })))
    .onConflictDoNothing()
    .returning({ seq: sessionMessages.seq });
  return written.length;
}

/**
 * When `rows` opens with a reply starting at `firstEventSeq` and the stored reply row ends at the
 * event right before it, take that row out and join it into the first one. `DELETE … RETURNING`
 * reads and removes in one step, so a concurrent writer that changed the row first is seen.
 */
export async function joinEarlierReply(db: Writer, sessionId: string, rows: MessageRow[], firstEventSeq: number): Promise<MessageRow[]> {
  const [head, ...rest] = rows;
  if (!head || head.role !== "agent" || head.firstSeq !== firstEventSeq) return rows;
  const previous = sql`(select max(${sessionEvents.seq}) from ${sessionEvents} where ${sessionEvents.sessionId} = ${sessionId} and ${sessionEvents.seq} < ${firstEventSeq})`;
  const [earlier] = await db.delete(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, "agent"), eq(sessionMessages.seq, previous)))
    .returning({ firstSeq: sessionMessages.firstSeq, ts: sessionMessages.ts, text: sessionMessages.text });
  if (!earlier) return rows;
  return [{ ...head, firstSeq: earlier.firstSeq, ts: earlier.ts, text: joinText(earlier.text, head.text) }, ...rest];
}

/**
 * When `rows` ends with a reply running up to the event right before `nextFirstSeq`, and the stored
 * reply row starts at `nextFirstSeq`, prepend it to that row instead (the backfill reaching older
 * events below a live-indexed reply). Answers the rows still to insert.
 */
export async function joinLaterReply(db: Writer, sessionId: string, rows: MessageRow[], lastEventSeq: number, nextFirstSeq: number): Promise<MessageRow[]> {
  const tail = rows.at(-1);
  if (!tail || tail.role !== "agent" || tail.seq !== lastEventSeq) return rows;
  const joined = await db.update(sessionMessages)
    .set({ firstSeq: tail.firstSeq, ts: Math.round(tail.ts), text: sql`left(${stripNul(tail.text)} || ${sessionMessages.text}, ${MESSAGE_TEXT_MAX})` })
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, "agent"), eq(sessionMessages.firstSeq, nextFirstSeq)))
    .returning({ seq: sessionMessages.seq });
  return joined.length > 0 ? rows.slice(0, -1) : rows;
}

/** Index a batch the store just appended (strictly increasing seqs, all above what was stored). */
export async function indexMessages(db: Writer, sessionId: string, events: StoredEvent[]): Promise<void> {
  if (events.length === 0) return;
  await insertMessageRows(db, sessionId, await joinEarlierReply(db, sessionId, messageRowsFrom(events), events[0].seq));
}
