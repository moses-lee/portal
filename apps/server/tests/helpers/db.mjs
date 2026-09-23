/**
 * A throwaway database per test file: created from the development server, migrated, and dropped
 * on cleanup. Needs Postgres from `pnpm db:up` (or DATABASE_URL pointing at another server).
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { connect } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";

const adminUrl = process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";

export async function temporaryDatabase(t) {
  const name = `portal_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } catch (err) {
    await admin.end();
    throw new Error(`Cannot create a test database at ${adminUrl} (${err.message}). Start Postgres with \`pnpm db:up\`.`);
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = connect(url.toString(), { max: 4 });
  // Register cleanup before anything else can fail, or open sockets keep the test runner alive.
  t.after(async () => {
    await handle.close();
    await admin.unsafe(`drop database ${name} with (force)`);
    await admin.end();
  });
  await runMigrations(handle.db);
  return handle;
}
