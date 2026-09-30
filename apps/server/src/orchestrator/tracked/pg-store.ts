/**
 * Tracked sessions in Postgres (`tracked_sessions`). The foreign key answers whether a session
 * exists, and its cascade drops the row when the session is deleted.
 */
import { asc, eq } from "drizzle-orm";
import type { TrackedSession } from "@portal/contracts/orchestrator";
import type { Db } from "../../db/client.ts";
import { trackedSessions } from "../../db/schema.ts";
import { isForeignKeyViolation } from "../../sessions/pg-session-store.ts";
import { type TrackedStore, hasNul } from "./store.ts";

type Row = typeof trackedSessions.$inferSelect;

/** Inserts a track may retry when concurrent removals keep emptying the row it conflicted with. */
const MAX_TRACK_ATTEMPTS = 3;

const fromRow = (row: Row): TrackedSession => ({
  sessionId: row.sessionId, trackedAt: row.trackedAt, trackedBy: row.trackedBy as TrackedSession["trackedBy"],
});

export function createPgTrackedStore({ db }: { db: Db }): TrackedStore {
  async function get(sessionId: string): Promise<TrackedSession | null> {
    const [row] = await db.select().from(trackedSessions).where(eq(trackedSessions.sessionId, sessionId));
    return row ? fromRow(row) : null;
  }
  const track: TrackedStore["track"] = async (sessionId, trackedBy, at) => {
    // Postgres cannot store U+0000, so no session id holds it.
    if (hasNul(sessionId)) return null;
    // A conflict means the row exists, but a concurrent untrack (or the session's delete) may remove
    // it before it is read back; then insert again and let the foreign key decide. Bounded, since
    // each lap needs another concurrent removal to lose.
    for (let attempt = 1; ; attempt++) {
      try {
        const [row] = await db.insert(trackedSessions).values({ sessionId, trackedAt: at, trackedBy })
          .onConflictDoNothing({ target: trackedSessions.sessionId }).returning();
        if (row) return { session: fromRow(row), created: true };
      } catch (err) {
        if (isForeignKeyViolation(err)) return null;
        throw err;
      }
      const existing = await get(sessionId);
      if (existing) return { session: existing, created: false };
      if (attempt >= MAX_TRACK_ATTEMPTS) throw new Error(`Could not track session ${sessionId}: its row kept changing.`);
    }
  };
  return {
    async list() {
      const rows = await db.select().from(trackedSessions).orderBy(asc(trackedSessions.trackedAt), asc(trackedSessions.sessionId));
      return rows.map(fromRow);
    },
    async isTracked(sessionId) {
      return !hasNul(sessionId) && (await get(sessionId)) !== null;
    },
    track,
    async untrack(sessionId) {
      if (hasNul(sessionId)) return false;
      const rows = await db.delete(trackedSessions).where(eq(trackedSessions.sessionId, sessionId)).returning({ sessionId: trackedSessions.sessionId });
      return rows.length > 0;
    },
  };
}
