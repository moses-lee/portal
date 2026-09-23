/**
 * Applies the SQL migrations under `apps/server/drizzle` (generated with `pnpm --filter
 * @portal/server db:generate`). Runs at server boot and in tests against a fresh database.
 */
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.ts";

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
