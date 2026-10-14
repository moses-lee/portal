import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { connect } from "../src/db/client.ts";
import { migrationsFolder, runMigrations } from "../src/db/migrate.ts";

const adminUrl = process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";

test("retiring tracked sessions preserves sessions, workspace, and unrelated world/settings data", async (t) => {
  const name = `portal_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${name}`);
  } catch (err) {
    await admin.end();
    throw err;
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const database = connect(url.toString(), { max: 2 });
  const folder = mkdtempSync(path.join(os.tmpdir(), "portal-tracked-migration-"));
  t.after(async () => {
    await database.close();
    await admin.unsafe(`drop database ${name} with (force)`);
    await admin.end();
    rmSync(folder, { recursive: true, force: true });
  });
  // Upgrade an existing database, rather than just checking an empty installation.
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const entries = journal.entries.filter((entry) => entry.idx < 16);
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  await migrate(database.db, { migrationsFolder: folder });

  const { sql, db } = database;
  await sql`insert into sessions (id, agent_id, agent_name, cwd, project_id, created_at, last_active_at, upstream_id, state)
    values ('s1', 'claude', 'Claude', '/repo', 'p1', 1000, 2000, 'upstream', '{}'::jsonb)`;
  await sql`insert into session_events (session_id, seq, ts, body) values ('s1', 1, 2000, '{"kind":"user","text":"Keep my work"}'::jsonb)`;
  await sql`insert into tracked_sessions (session_id, tracked_at, tracked_by) values ('s1', 2000, 'portal')`;
  const workspace = { version: 1, tabs: [{ id: "tab1", title: null, titleSource: null, createdAt: 1000, root: { kind: "pane", id: "pane1", sessionId: "s1" } }] };
  const overrides = { sessions: { tracked: { untrackAfterHours: 24 }, worktrees: { removeAfterHours: 96 } }, orchestrator: { model: "custom" } };
  await sql`insert into settings (key, body, updated_at) values ('overrides', ${JSON.stringify(overrides)}::jsonb, 2000), ('workspace', ${JSON.stringify(workspace)}::jsonb, 2000)`;
  const world = { reason: "refresh", world: { at: 2000, tracked: ["s1"], sessions: [{ id: "s1" }], snapshot: { at: 2000 } } };
  await sql`insert into world_snapshots (at, body) values (2000, ${JSON.stringify(world)}::jsonb)`;
  const [before] = await sql`select * from sessions where id = 's1'`;

  await runMigrations(db);

  assert.equal((await sql`select to_regclass('public.tracked_sessions') as name`)[0].name, null);
  assert.deepEqual((await sql`select * from sessions where id = 's1'`)[0], before);
  assert.equal((await sql`select body from session_events where session_id = 's1'`)[0].body.text, "Keep my work");
  const settings = Object.fromEntries((await sql`select key, body from settings`).map((row) => [row.key, row.body]));
  assert.deepEqual(settings.workspace, workspace);
  assert.deepEqual(settings.overrides, { ...overrides, sessions: { worktrees: overrides.sessions.worktrees } });
  const { tracked: _removed, ...remainingWorld } = world.world;
  assert.deepEqual((await sql`select body from world_snapshots`)[0].body, { ...world, world: remainingWorld });
  // Repeated startup migrations should leave the upgraded data alone.
  await runMigrations(db);
  assert.deepEqual((await sql`select * from sessions where id = 's1'`)[0], before);
});
