import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { titleMayReplace, titleSourceRank } from "@portal/contracts/types";
import { connect } from "../src/db/client.ts";
import { migrationsFolder } from "../src/db/migrate.ts";
import { createPgProjectsStore } from "../src/projects/pg-store.ts";
import { createMemoryProjectsStore } from "../src/projects/store.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { createMemorySessionStore, isSessionRecord } from "../src/sessions/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const adminUrl = process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";
/** The last migration from before the session lifecycle columns. */
const BEFORE = "0012_tracked_sessions";

/** A throwaway database migrated only up to `BEFORE`, and a way to run the rest. */
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

function record(id, extra = {}) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1",
    createdAt: 1, lastActiveAt: 1, title: null, upstreamId: `up-${id}`,
    state: { modes: null, configOptions: [], commands: [] },
    ...extra,
  };
}

test("title sources rank user over portal over agent over prompt", () => {
  assert.deepEqual(["prompt", "agent", "portal", "user"].map(titleSourceRank), [0, 1, 2, 3]);
  assert.equal(titleMayReplace("prompt", "agent"), true);
  assert.equal(titleMayReplace("agent", "agent"), true);
  assert.equal(titleMayReplace("portal", "agent"), false);
  assert.equal(titleMayReplace("user", "agent"), false);
  assert.equal(titleMayReplace("user", "portal"), false);
  assert.equal(titleMayReplace("portal", "user"), true);
});

test("migration 0013 adds the lifecycle columns and starts every existing session's clocks at its last activity, except an open turn's", async (t) => {
  const { sql, rest, db } = await databaseBefore(t);
  const state = JSON.stringify({ modes: null, configOptions: [], commands: [] });
  for (const [id, lastActiveAt, title, turnOpen] of [["s1", 1000, null, false], ["s2", 2500, "Named", null], ["s3", 3000, null, true]]) {
    await sql`insert into sessions (id, agent_id, agent_name, cwd, project_id, created_at, last_active_at, title, upstream_id, state, turn_open)
      values (${id}, 'claude', 'Claude Code', '/repos/x', 'p1', 10, ${lastActiveAt}, ${title}, ${`up-${id}`}, ${state}::jsonb, ${turnOpen})`;
  }
  await sql`insert into projects (id, name, path, created_at) values ('p1', 'one', '/repos/x', 5)`;

  await rest();

  const sessions = await sql`select id, idle_since, turn_ended_at, title_source, title from sessions order by id`;
  assert.deepEqual(sessions.map((row) => ({ ...row })), [
    { id: "s1", idle_since: "1000", turn_ended_at: "1000", title_source: "prompt", title: null },
    { id: "s2", idle_since: "2500", turn_ended_at: "2500", title_source: "prompt", title: "Named" },
    // A turn this restart cut off gets its clocks on the next start, from its last event.
    { id: "s3", idle_since: null, turn_ended_at: null, title_source: "prompt", title: null },
  ]);
  const [project] = await sql`select pinned_at, kept_reason, revived_at from projects`;
  assert.deepEqual({ ...project }, { pinned_at: null, kept_reason: null, revived_at: null });

  // The stores read the backfilled rows as numbers.
  const store = createPgSessionStore({ db });
  const s2 = await store.getSession("s2");
  assert.deepEqual({ idleSince: s2.idleSince, turnEndedAt: s2.turnEndedAt, titleSource: s2.titleSource }, { idleSince: 2500, turnEndedAt: 2500, titleSource: "prompt" });
  const projects = createPgProjectsStore({ db });
  await projects.ready;
  assert.deepEqual(projects.get("p1"), { id: "p1", name: "one", path: "/repos/x", createdAt: 5, pinnedAt: null, keptReason: null, revivedAt: null });
});

const sessionBackends = [
  ["memory", async () => createMemorySessionStore()],
  ["postgres", async (t) => createPgSessionStore({ db: (await temporaryDatabase(t)).db })],
];

for (const [name, make] of sessionBackends) {
  test(`${name} session store: idle clocks and the title source round-trip`, async (t) => {
    const store = await make(t);
    await store.putSession(record("a", { title: "Mine", titleSource: "user", idleSince: 100, turnEndedAt: 90 }));
    let a = await store.getSession("a");
    assert.deepEqual({ title: a.title, titleSource: a.titleSource, idleSince: a.idleSince, turnEndedAt: a.turnEndedAt }, { title: "Mine", titleSource: "user", idleSince: 100, turnEndedAt: 90 });
    assert.ok(isSessionRecord(a));
    // Clearing the idle clock (a turn started) is written, not skipped.
    await store.putSession({ ...a, idleSince: null });
    a = await store.getSession("a");
    assert.equal(a.idleSince, null);
    assert.equal(a.turnEndedAt, 90);
    assert.equal(a.titleSource, "user");
    assert.deepEqual((await store.listSessions()).map(({ id, idleSince }) => ({ id, idleSince })), [{ id: "a", idleSince: null }]);
  });
}

test("postgres session store: a record without the lifecycle fields gets the defaults", async (t) => {
  const store = createPgSessionStore({ db: (await temporaryDatabase(t)).db });
  await store.putSession(record("old"));
  const old = await store.getSession("old");
  assert.deepEqual({ titleSource: old.titleSource, idleSince: old.idleSince, turnEndedAt: old.turnEndedAt }, { titleSource: "prompt", idleSince: null, turnEndedAt: null });
});

test("session records with a bad title source or clock are rejected by the shape check", () => {
  assert.ok(isSessionRecord(record("a")));
  assert.ok(isSessionRecord(record("a", { titleSource: "portal", idleSince: null, turnEndedAt: 5 })));
  assert.equal(isSessionRecord(record("a", { titleSource: "robot" })), false);
  assert.equal(isSessionRecord(record("a", { idleSince: "yesterday" })), false);
  assert.equal(isSessionRecord(record("a", { turnEndedAt: {} })), false);
});

const projectBackends = [
  ["memory", async (t, home) => {
    const store = createMemoryProjectsStore({ home });
    return { open: () => store, reopen: null };
  }],
  ["postgres", async (t, home) => {
    const { db } = await temporaryDatabase(t);
    return { open: () => createPgProjectsStore({ db, home }), reopen: () => createPgProjectsStore({ db, home }) };
  }],
];

for (const [name, make] of projectBackends) {
  test(`${name} projects store: pins and kept reasons are written, reloaded, and dropped with the listing`, async (t) => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-projects-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    for (const dir of ["one", "two"]) mkdirSync(path.join(home, dir));
    const { open, reopen } = await make(t, home);
    const store = open();
    await store.ready;

    const parent = await store.add({ path: path.join(home, "one") });
    const wt = await store.add({ path: path.join(home, "two"), worktree: { parentId: parent.id, branch: "feat" } });
    assert.equal(parent.pinnedAt, null);
    assert.equal(parent.keptReason, null);

    const pinned = await store.setPinned(wt.id, 1234);
    assert.equal(pinned.pinnedAt, 1234);
    assert.equal(store.get(wt.id).pinnedAt, 1234);
    const kept = await store.setKeptReason(wt.id, "uncommitted changes");
    assert.deepEqual({ pinnedAt: kept.pinnedAt, keptReason: kept.keptReason }, { pinnedAt: 1234, keptReason: "uncommitted changes" });
    assert.deepEqual(store.list().map(({ id }) => id), [parent.id, wt.id], "the list order is unchanged");
    await assert.rejects(store.setPinned("nope", 1), (err) => err.status === 404);
    await assert.rejects(store.setKeptReason("nope", "x"), (err) => err.status === 404);

    if (reopen) {
      const again = reopen();
      await again.ready;
      assert.deepEqual(again.get(wt.id), kept);
      assert.equal(again.get(parent.id).pinnedAt, null);
    }

    const cleared = await store.setKeptReason(wt.id, null);
    assert.equal(cleared.keptReason, null);
    assert.equal((await store.setPinned(wt.id, null)).pinnedAt, null);
    await store.setPinned(wt.id, 99);

    // A removed record leaves the pin behind, and a restored project comes back unpinned.
    await store.remove(wt.id, { keep: true });
    const removed = store.getRemoved(wt.id);
    assert.ok(!("pinnedAt" in removed) && !("keptReason" in removed) && !("revivedAt" in removed));
    const restored = await store.restore(wt.id);
    assert.deepEqual({ pinnedAt: restored.pinnedAt, keptReason: restored.keptReason }, { pinnedAt: null, keptReason: null });
    if (reopen) {
      const third = reopen();
      await third.ready;
      assert.equal(third.get(wt.id).pinnedAt, null);
      assert.equal(third.get(wt.id).revivedAt, restored.revivedAt, "the restore time is stored");
    }
  });
}
