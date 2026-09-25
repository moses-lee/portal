/**
 * World builds in Postgres (`world_snapshots`: the body holds `{ reason, world }`) and the change
 * log (`world_changes`, one row per subject, upserted on it).
 */
import { desc, gte, inArray, lt, sql } from "drizzle-orm";
import type { WorldState } from "@portal/contracts/world";
import type { Db } from "../../db/client.ts";
import { stripNul } from "../../db/sanitize.ts";
import { worldChanges, worldSnapshots } from "../../db/schema.ts";
import { type ChangeRefs, type ChangeStore, type WorldChange, clampChangeLimit } from "./changes.ts";
import { KEEP_WORLD_BUILDS, type WorldBuild, type WorldStore, clampWorldLimit } from "./store.ts";

type Row = typeof worldSnapshots.$inferSelect;
type Body = { reason?: string; world: WorldState };

const fromRow = (row: Row): WorldBuild => {
  const body = row.body as unknown as Body;
  return { id: row.id, at: row.at, reason: body.reason ?? "", world: body.world };
};

export function createPgWorldStore({ db }: { db: Db }): WorldStore {
  return {
    async append(world, reason) {
      const body = stripNul({ reason, world }) as unknown as Row["body"];
      const [row] = await db.insert(worldSnapshots).values({ at: world.at, body }).returning();
      return fromRow(row);
    },
    async latest() {
      const [row] = await db.select().from(worldSnapshots).orderBy(desc(worldSnapshots.id)).limit(1);
      return row ? fromRow(row) : null;
    },
    async list(filter = {}) {
      const rows = await db.select().from(worldSnapshots)
        .where(filter.before !== undefined ? lt(worldSnapshots.id, filter.before) : undefined)
        .orderBy(desc(worldSnapshots.id)).limit(clampWorldLimit(filter.limit));
      return rows.map(fromRow);
    },
    async prune(keep = KEEP_WORLD_BUILDS) {
      // The oldest build to keep; everything before it goes.
      if (keep <= 0) return (await db.delete(worldSnapshots).returning({ id: worldSnapshots.id })).length;
      const [edge] = await db.select({ id: worldSnapshots.id }).from(worldSnapshots).orderBy(desc(worldSnapshots.id)).offset(keep - 1).limit(1);
      if (!edge) return 0;
      return (await db.delete(worldSnapshots).where(lt(worldSnapshots.id, edge.id)).returning({ id: worldSnapshots.id })).length;
    },
  };
}

type ChangeRow = typeof worldChanges.$inferSelect;

const changeFromRow = (row: ChangeRow): WorldChange => ({
  id: row.id, subject: row.subject, at: row.at, kind: row.kind as WorldChange["kind"], fingerprint: row.fingerprint, summary: row.summary,
  detail: row.detail, refs: row.refs as ChangeRefs, mine: row.mine, activeAt: row.activeAt,
});

export function createPgChangeStore({ db }: { db: Db }): ChangeStore {
  return {
    async record(entries, at) {
      if (entries.length === 0) return;
      const rows = entries.map((entry) => stripNul({ ...entry, refs: entry.refs as Record<string, unknown>, at }));
      // The latest state replaces the subject's row, with a fresh id so "newest first" holds.
      await db.insert(worldChanges).values(rows).onConflictDoUpdate({
        target: worldChanges.subject,
        set: {
          id: sql`nextval(pg_get_serial_sequence('world_changes', 'id'))`, at: sql`excluded.at`, kind: sql`excluded.kind`,
          fingerprint: sql`excluded.fingerprint`, summary: sql`excluded.summary`, detail: sql`excluded.detail`, refs: sql`excluded.refs`,
          mine: sql`excluded.mine`, activeAt: sql`excluded.active_at`,
        },
      });
    },
    async remove(subjects) {
      if (subjects.length === 0) return 0;
      return (await db.delete(worldChanges).where(inArray(worldChanges.subject, subjects)).returning({ id: worldChanges.id })).length;
    },
    async list(filter = {}) {
      const rows = await db.select().from(worldChanges)
        .where(filter.since !== undefined ? gte(worldChanges.at, filter.since) : undefined)
        .orderBy(desc(worldChanges.at), desc(worldChanges.id)).limit(clampChangeLimit(filter.limit));
      return rows.map(changeFromRow);
    },
    async subjects() {
      const rows = await db.select({ subject: worldChanges.subject, kind: worldChanges.kind }).from(worldChanges);
      return rows.map((row) => ({ subject: row.subject, kind: row.kind as WorldChange["kind"] }));
    },
    async prune(before) {
      return (await db.delete(worldChanges).where(lt(worldChanges.at, before)).returning({ id: worldChanges.id })).length;
    },
  };
}
