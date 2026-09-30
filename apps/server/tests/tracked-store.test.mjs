import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { connect } from "../src/db/client.ts";
import { migrationsFolder } from "../src/db/migrate.ts";
import { createPgOrchestratorStore } from "../src/orchestrator/pg-store.ts";
import { createPgTrackedStore } from "../src/orchestrator/tracked/pg-store.ts";
import { createMemoryTrackedStore } from "../src/orchestrator/tracked/store.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const adminUrl = process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";

function sessionRecord(id) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1", createdAt: 1, lastActiveAt: 1, title: null,
    upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false,
  };
}

const SESSIONS = ["s1", "s2", "s3"];

const backends = [
  ["memory", async () => ({ store: createMemoryTrackedStore({ sessionExists: (id) => SESSIONS.includes(id) }) })],
  ["postgres", async (t) => {
    const handle = await temporaryDatabase(t);
    const sessions = createPgSessionStore({ db: handle.db });
    for (const id of SESSIONS) await sessions.putSession(sessionRecord(id));
    return { store: createPgTrackedStore({ db: handle.db }), handle, sessions };
  }],
];

for (const [name, make] of backends) {
  test(`${name} store: track is idempotent, untrack removes, the list is oldest first, unknown sessions are refused`, async (t) => {
    const { store } = await make(t);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.isTracked("s1"), false);

    assert.deepEqual(await store.track("s2", "portal", 200), { session: { sessionId: "s2", trackedAt: 200, trackedBy: "portal" }, created: true });
    assert.deepEqual(await store.track("s1", "user", 100), { session: { sessionId: "s1", trackedAt: 100, trackedBy: "user" }, created: true });
    assert.deepEqual(await store.track("s3", "user", 100), { session: { sessionId: "s3", trackedAt: 100, trackedBy: "user" }, created: true });
    // Tracking again keeps the first row: who tracked it and when.
    assert.deepEqual(await store.track("s2", "user", 900), { session: { sessionId: "s2", trackedAt: 200, trackedBy: "portal" }, created: false });
    assert.deepEqual((await store.list()).map((row) => row.sessionId), ["s1", "s3", "s2"], "by trackedAt, ties by id");
    assert.equal(await store.isTracked("s2"), true);

    assert.equal(await store.track("nope", "user", 300), null, "an unknown session cannot be tracked");
    assert.equal(await store.track("nu\u0000l", "user", 300), null, "nor one whose id Postgres cannot store");
    assert.equal(await store.track("s1\u0000", "user", 300), null, "an id with U+0000 is unknown, not another session's id stripped");
    assert.equal(await store.isTracked("s1\u0000"), false);
    assert.equal(await store.untrack("s1\u0000"), false);
    assert.equal(await store.isTracked("s1"), true);
    assert.equal(await store.isTracked("nope"), false);

    assert.equal(await store.untrack("s2"), true);
    assert.equal(await store.untrack("s2"), false, "untracking twice finds nothing");
    assert.equal(await store.untrack("nope"), false);
    assert.equal(await store.isTracked("s2"), false);
    assert.deepEqual(await store.list(), [
      { sessionId: "s1", trackedAt: 100, trackedBy: "user" }, { sessionId: "s3", trackedAt: 100, trackedBy: "user" },
    ]);
    // Untracked sessions can be tracked again, afresh.
    assert.deepEqual(await store.track("s2", "user", 500), { session: { sessionId: "s2", trackedAt: 500, trackedBy: "user" }, created: true });
  });
}

test("postgres store: deleting a session removes its row through the cascade", async (t) => {
  const { store, sessions, handle } = await backends[1][1](t);
  await store.track("s1", "user", 1);
  await store.track("s2", "portal", 2);
  await sessions.deleteSession("s1");
  assert.deepEqual(await store.list(), [{ sessionId: "s2", trackedAt: 2, trackedBy: "portal" }]);
  // A second store over the same database reads the same rows.
  assert.deepEqual(await createPgTrackedStore({ db: handle.db }).list(), await store.list());
});

// ---------------------------------------------------------------------------------------------
// Migration 0012: the retired session items are resolved once
// ---------------------------------------------------------------------------------------------

/** The last migration before tracked sessions. */
const BEFORE = "0011_items_status_index";

/** A throwaway database migrated only up to `BEFORE`, and a way to run the rest (as jobs-migration.test.mjs). */
async function databaseBefore(t) {
  const name = `portal_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = connect(url.toString(), { max: 2 });
  const folder = mkdtempSync(path.join(os.tmpdir(), "portal-migrations-"));
  t.after(async () => {
    await handle.close();
    await admin.unsafe(`drop database ${name} with (force)`);
    await admin.end();
    rmSync(folder, { recursive: true, force: true });
  });
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const cut = journal.entries.findIndex((entry) => entry.tag === BEFORE);
  assert.ok(cut >= 0, `${BEFORE} is in the journal`);
  const entries = journal.entries.slice(0, cut + 1);
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  await migrate(handle.db, { migrationsFolder: folder });
  return { ...handle, rest: () => migrate(handle.db, { migrationsFolder }) };
}

test("migration 0012 creates tracked_sessions and resolves every open or snoozed item of a retired session kind", async (t) => {
  const { sql, db, rest } = await databaseBefore(t);
  const item = (id, kind, status, extra = {}) => ({
    id, kind, title: `Item ${id}`, body: "", links: { sessionId: "s1" }, actions: [], fingerprint: `${kind}:${id}`, status,
    createdAt: Date.now(), updatedAt: 10, snoozedUntil: status === "snoozed" ? Date.now() + 60_000 : null, ...extra,
  });
  const items = [
    item("a", "session_finished", "open"), item("b", "session_stopped", "snoozed"), item("c", "session_waiting", "open", { links: { intentId: "i1" } }),
    item("d", "session_hung", "open"), item("e", "session_offline", "open"),
    item("f", "session_finished", "dismissed"), item("g", "pr_checks_failing", "open"), item("h", "custom", "snoozed"), item("i", "review_findings", "open"),
  ];
  for (const [i, body] of items.entries()) {
    await sql`insert into orchestrator_items (id, status, fingerprint, created_at, updated_at, snoozed_until, body) values (${body.id}, ${body.status}, ${body.fingerprint}, ${body.createdAt + i}, ${body.updatedAt}, ${body.snoozedUntil}, ${JSON.stringify(body)}::jsonb)`;
  }

  const before = Date.now();
  await rest();

  const store = createPgOrchestratorStore({ db });
  const byId = Object.fromEntries((await store.listItems()).map((stored) => [stored.id, stored]));
  for (const id of ["a", "b", "c", "d", "e"]) {
    assert.equal(byId[id].status, "resolved", `${byId[id].kind} (${id}) is resolved`);
    assert.ok(byId[id].updatedAt >= before - 1000, "and its updatedAt moved");
  }
  assert.equal(byId.f.status, "dismissed", "items already closed keep their status");
  assert.equal(byId.f.updatedAt, 10);
  for (const [id, status] of [["g", "open"], ["h", "snoozed"], ["i", "open"]]) {
    assert.equal(byId[id].status, status, `${byId[id].kind} is not a retired kind and stays ${status}`);
    assert.equal(byId[id].updatedAt, 10);
  }
  const [columns] = await sql`select status from orchestrator_items where id = 'a'`;
  assert.equal(columns.status, "resolved", "the status column moves with the body");
  assert.equal(byId.b.snoozedUntil, null, "a resolved item is no longer snoozed");
  const [snoozed] = await sql`select status, snoozed_until from orchestrator_items where id = 'b'`;
  assert.deepEqual({ ...snoozed }, { status: "resolved", snoozed_until: null });
  assert.equal(typeof byId.h.snoozedUntil, "number", "other snoozed items keep their snooze");
  assert.deepEqual(await createPgTrackedStore({ db }).list(), [], "the table exists, empty");
});
