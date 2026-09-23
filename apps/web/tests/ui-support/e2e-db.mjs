/**
 * Drops and recreates the UI suite's database on the development Postgres, then prints its URL.
 * The server under test runs its migrations against it at boot, so every run starts from an empty
 * Portal and no test can see state left by an earlier run.
 *
 *   DATABASE_URL=$(node tests/ui-support/e2e-db.mjs) node ../server/src/index.ts
 *
 * The admin connection defaults to the `pnpm db:up` container; override it with E2E_ADMIN_DATABASE_URL.
 * Everything but the URL goes to stderr so command substitution captures only the URL.
 */
import { createRequire } from "node:module";

// `postgres` is a server dependency; resolve it from there rather than adding it to the web app.
const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const postgres = require("postgres");

const adminUrl = process.env.E2E_ADMIN_DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";
const name = process.env.E2E_DATABASE_NAME ?? "portal_e2e";
if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid database name ${JSON.stringify(name)}`);
// This script drops `name`. The admin connection's own database is, by default, the one the real
// Portal keeps everything in; never drop it, nor the databases Postgres itself needs.
const adminName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
if (new Set([adminName, "portal", "postgres", "template0", "template1"]).has(name)) {
  throw new Error(`Refusing to drop ${JSON.stringify(name)}: set E2E_DATABASE_NAME to a throwaway database.`);
}

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  // `with (force)` ends connections a previous, killed server run may have left open.
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
} catch (err) {
  console.error(`Cannot recreate ${name} at ${adminUrl} (${err.message}). Start Postgres with \`pnpm db:up\`.`);
  process.exitCode = 1;
} finally {
  await admin.end();
}
if (!process.exitCode) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  process.stdout.write(`${url}\n`);
}
