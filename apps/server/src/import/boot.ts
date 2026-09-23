/**
 * The import a fresh server runs on its own: when the database has never been used (no marker row,
 * no sessions, no projects) and the Portal home still holds the old app's files, move them in
 * before any service loads its cache. Anything else (a database already in use, a home that was
 * imported elsewhere) is left to the CLI, where the user decides.
 */
import type { Db } from "../db/client.ts";
import { type ImportLog, databaseIsEmpty, describeCounts, hasLegacyData, importLegacyHome, readImportMarker } from "./import-legacy.ts";

export async function importLegacyAtBoot({ home, db, log }: { home: string; db: Db; log: ImportLog }): Promise<void> {
  if (!(await hasLegacyData(home))) return;
  if (await readImportMarker(db)) return;
  if (!(await databaseIsEmpty(db))) {
    log.info(`Legacy Portal data in ${home} was not imported: the database already holds sessions or projects. Run \`pnpm --filter @portal/server run import\` to merge it.`);
    return;
  }
  let result;
  try {
    result = await importLegacyHome({ home, db, log });
  } catch (err) {
    // Fail the boot: starting empty would let new rows block the automatic import for good.
    throw new Error(`Importing the legacy Portal data in ${home} failed, and nothing was imported: ${(err as Error).message}`, { cause: err });
  }
  if (result.status === "imported") log.info(`Imported legacy Portal data from ${home}: ${describeCounts(result.counts)}.`);
}
