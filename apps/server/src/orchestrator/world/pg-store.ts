/** World builds in Postgres (`world_snapshots`): the body holds `{ reason, world }`. */
import { desc, lt } from "drizzle-orm";
import type { WorldState } from "@portal/contracts/world";
import type { Db } from "../../db/client.ts";
import { stripNul } from "../../db/sanitize.ts";
import { worldSnapshots } from "../../db/schema.ts";
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
