/** The activity log in Postgres (`activity_log`). Rows are only ever inserted. */
import { and, desc, eq, like, lt, or, type SQL } from "drizzle-orm";
import type { ActivityEntry } from "@portal/contracts/activity";
import type { Db } from "../../db/client.ts";
import { stripNul } from "../../db/sanitize.ts";
import { activityLog } from "../../db/schema.ts";
import { type ActivityStore, clampLimit } from "./store.ts";

type Row = typeof activityLog.$inferSelect;

const fromRow = (row: Row): ActivityEntry => ({
  id: row.id, at: row.at, actor: row.actor as ActivityEntry["actor"], kind: row.kind, summary: row.summary,
  refs: row.refs as ActivityEntry["refs"], detail: row.detail ?? null,
});

/** `%` and `_` are LIKE wildcards; a kind never contains them, but a filter from a URL might. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createPgActivityStore({ db }: { db: Db }): ActivityStore {
  return {
    async append(raw) {
      const entry = stripNul(raw);
      const [row] = await db.insert(activityLog).values({
        at: entry.at, actor: entry.actor, kind: entry.kind, summary: entry.summary, refs: entry.refs as Record<string, unknown>,
        detail: entry.detail, threadId: entry.refs.threadId ?? null, runId: entry.refs.runId ?? null,
      }).returning();
      return fromRow(row);
    },
    async list(filter = {}) {
      const where: SQL[] = [];
      if (filter.before !== undefined) where.push(lt(activityLog.id, filter.before));
      if (filter.kind) {
        where.push(filter.kind.endsWith(".")
          ? or(eq(activityLog.kind, filter.kind), like(activityLog.kind, `${escapeLike(filter.kind)}%`))!
          : eq(activityLog.kind, filter.kind));
      }
      if (filter.threadId) where.push(eq(activityLog.threadId, filter.threadId));
      if (filter.runId) where.push(eq(activityLog.runId, filter.runId));
      const rows = await db.select().from(activityLog).where(where.length ? and(...where) : undefined)
        .orderBy(desc(activityLog.id)).limit(clampLimit(filter.limit));
      return rows.map(fromRow);
    },
  };
}
