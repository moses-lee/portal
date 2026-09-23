/**
 * Import a legacy Portal home into Postgres by hand:
 *
 *   pnpm --filter @portal/server run import [--home <dir>] [--database-url <url>] [--dry-run] [--force]
 *
 * The server does this on its own at boot when the database is new; the CLI is for everything else
 * (a database already in use, a second home, a preview with --dry-run). The home's `server.key`
 * seals the API keys, so point --home at the directory the server runs with (its PORTAL_HOME). Stop
 * the server first or restart it afterwards: it caches projects and sessions at startup.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { connect } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { describeCounts, importLegacyHome } from "./import-legacy.ts";

const usage = `Usage: pnpm --filter @portal/server run import [options]

Moves a legacy Portal home (~/.portal JSON files) into Postgres. The files stay as a backup;
settings.json, which holds API keys in plain text, is renamed to settings.json.imported-<time> (0600).

Options:
  --home <dir>           Portal home to import (default: $PORTAL_HOME or ~/.portal)
  --database-url <url>   Postgres connection string (default: $DATABASE_URL or the dev database)
  --dry-run              Report what would be imported; write nothing and rename nothing
  --force                Import even if this database already recorded an import
  -h, --help             Show this help`;

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        home: { type: "string" },
        "database-url": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${usage}`);
    return 2;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const config = loadConfig();
  const home = values.home ?? config.portalHome;
  const dryRun = values["dry-run"];
  const database = connect(values["database-url"] ?? config.databaseUrl, { max: 2 });
  try {
    // A dry run must not change the database, so it does not migrate either (an unmigrated database reads as "never imported").
    if (!dryRun) await runMigrations(database.db);
    const log = { info: (message: string) => console.log(message), warn: (message: string) => console.warn(`warning: ${message}`) };
    const result = await importLegacyHome({ home, db: database.db, log, dryRun, force: values.force });
    switch (result.status) {
      case "skipped":
        if (result.reason === "already-imported") {
          console.log(`Already imported ${result.marker.home} on ${new Date(result.marker.importedAt).toISOString()}; nothing to do (use --force to import again).`);
        } else {
          console.log(`No legacy Portal data in ${home}; nothing to do.`);
        }
        break;
      case "dry-run":
        for (const warning of result.warnings) console.warn(`warning: ${warning}`);
        console.log(`Dry run for ${home}; would import ${describeCounts(result.counts)}. Nothing was written.`);
        break;
      case "imported":
        console.log(`Imported ${home}: ${describeCounts(result.counts)}.`);
        if (result.settingsBackup) console.log(`settings.json moved to ${result.settingsBackup} (mode 0600); delete it once you have checked your settings.`);
        if (result.markerFile) console.log(`Summary written to ${result.markerFile}.`);
        break;
    }
    return 0;
  } catch (err) {
    console.error(`Import failed, nothing was imported: ${(err as Error).message}`);
    return 1;
  } finally {
    await database.close();
  }
}

process.exitCode = await main();
