import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV3 } from "ai/test";
import { MILESTONES } from "@portal/shared/room";
import { appContext, buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ROOM_KEY, parseStoredRoom } from "../src/room/census.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { fakeDeps, fakeSettings, fakeTimers } from "./fixtures/orchestrator-fakes.mjs";
import { fakeClock, until } from "./fixtures/room-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const HOUR = 3_600_000;
const DAY = 86_400_000;

function sessionRecord(id, createdAt) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1", createdAt, lastActiveAt: createdAt, title: null,
    upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false,
  };
}

/** Rows straight into the tables the census counts, as the services would have left them. */
function seeder({ sql, db }) {
  let n = 0;
  return {
    async sessions(createdAts) {
      const store = createPgSessionStore({ db });
      for (const at of createdAts) await store.putSession(sessionRecord(`s${++n}`, at));
    },
    async memory(statuses) {
      await sql`insert into memory_entities (id, type, key, name, summary, created_at, updated_at) values ('e1', 'repo', 'acme/app', 'acme/app', '', 1, 1) on conflict do nothing`;
      for (const status of statuses) {
        const id = `m${++n}`;
        await sql`insert into memory_records (id, entity_id, type, key, body, status, scope, authority, source, trust, created_at, updated_at)
          values (${id}, 'e1', 'fact', ${id}, 'A claim.', ${status}, ${'{}'}::jsonb, 'user', ${'{"kind":"user"}'}::jsonb, 1, 1, 1)`;
      }
    },
    async intents(rows) {
      for (const { status, fires = 0 } of rows) {
        await sql`insert into intents (id, text, trigger, action, notes, scope, status, fires, cooldown_ms, created_at, updated_at)
          values (${`i${++n}`}, 'Watch', 'when', 'tell', '', ${'{}'}::jsonb, ${status}, ${fires}, 0, 1, 1)`;
      }
    },
    async grants(revokedAts) {
      for (const revokedAt of revokedAts) {
        await sql`insert into approval_grants (id, tool, scope, approval_id, created_at, revoked_at) values (${`g${++n}`}, 'run_shell', 'always', 'a1', 1, ${revokedAt})`;
      }
    },
    async activity(ats) {
      for (const at of ats) await sql`insert into activity_log (at, actor, kind, summary, refs) values (${at}, 'agent', 'tool.call', 'Ran a tool', ${'{}'}::jsonb)`;
    },
  };
}

async function build(database, clock, { orchestrator = false, settleMs, sessions } = {}) {
  const config = loadConfig({ ...process.env, PORTAL_ROOM_OFFLINE: "1", PORTAL_LOCATION: "" });
  const options = orchestrator
    ? { settingsStore: fakeSettings(), deps: fakeDeps().deps, timers: fakeTimers(), model: () => new MockLanguageModelV3({}) }
    : false;
  return buildApp({
    config, database, orchestrator: options, sessions, singleInstance: false, lifecycle: { start: false }, searchBackfill: { start: false },
    room: { now: clock.now, refreshEveryMs: 0, censusEveryMs: 0, ...(settleMs !== undefined ? { settleMs } : {}) },
  });
}

/** Runs `body` with an app, closing it before the database is dropped. */
async function withApp(database, clock, options, body) {
  const app = await build(database, clock, options);
  try {
    return await body(app);
  } finally {
    await app.close();
  }
}

const getRoom = async (app) => (await app.inject({ method: "GET", url: "/api/room" })).json();
const refresh = async (app) => (await app.inject({ method: "POST", url: "/api/room/refresh" })).json();
const expansions = async ({ sql }) => [...(await sql`select actor, kind, summary, detail from activity_log where kind = 'room.expanded' order by id`)];
const stored = async ({ sql }) => {
  const [row] = await sql`select body from settings where key = ${ROOM_KEY}`;
  return row ? parseStoredRoom(row.body) : null;
};

test("the census counts sessions, memory, watches, grants, and the last hour of activity", async (t) => {
  const database = await temporaryDatabase(t);
  const clock = fakeClock();
  const seed = seeder(database);
  await seed.sessions([clock.now() - 2 * DAY, clock.now() - 5 * DAY, clock.now() - DAY]);
  await seed.memory(["active", "active", "proposed", "archived", "rejected"]);
  await seed.intents([{ status: "active", fires: 1 }, { status: "active", fires: 2 }, { status: "done", fires: 3 }, { status: "cancelled" }]);
  await seed.grants([null, null, clock.now() - HOUR]);
  await seed.activity([clock.now() - 10 * 60_000, clock.now() - 59 * 60_000, clock.now() - 2 * HOUR]);

  await withApp(database, clock, {}, async (app) => {
    const state = await getRoom(app);
    assert.deepEqual(state.census, {
      sessionsEver: 3, memoryActive: 2, memoryInbox: 1, watches: { active: 2, finished: 2, fires: 6, ever: 4 }, grants: 2, activityLastHour: 2,
      since: clock.now() - 5 * DAY,
    });
    assert.deepEqual(state.milestones, []);
    assert.equal(state.layoutVersion, 1);
    assert.deepEqual(await stored(database), { sessionsEver: 3, memoryActive: 2, watchesEver: 4, fires: 6, since: clock.now() - 5 * DAY, milestones: [] });
  });
});

test("high-water marks and since survive a purge and a rebuild", async (t) => {
  const database = await temporaryDatabase(t);
  const clock = fakeClock();
  const seed = seeder(database);
  await seed.sessions([clock.now() - 3 * DAY, clock.now() - DAY, clock.now()]);
  await seed.memory(["active", "active", "active"]);
  const since = clock.now() - 3 * DAY;

  await withApp(database, clock, {}, async (app) => {
    const ctx = appContext(app);
    assert.equal((await getRoom(app)).census.sessionsEver, 3);
    for (const { id } of ctx.sessions.listSessions()) assert.equal(await ctx.sessions.deleteSession(id), true);
    await database.sql`update memory_records set status = 'archived'`;
    const after = (await refresh(app)).census;
    assert.equal(after.sessionsEver, 3, "a purge never lowers sessionsEver");
    assert.equal(after.since, since, "since is stored once");
    assert.equal(after.memoryActive, 0, "memoryActive is a live count");
    assert.equal((await stored(database)).memoryActive, 3, "the memory milestones' high-water stays");
  });

  clock.advance(DAY);
  await withApp(database, clock, {}, async (app) => {
    const census = (await getRoom(app)).census;
    assert.equal(census.sessionsEver, 3, "and survives a restart with no sessions left");
    assert.equal(census.since, since, "since does not move to now when the sessions are gone");
  });
});

test("a session created and purged before the next count still counts", async (t) => {
  const database = await temporaryDatabase(t);
  const clock = fakeClock();
  await seeder(database).sessions([clock.now()]);
  const cwd = mkdtempSync(path.join(os.tmpdir(), "portal-room-census-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, "agent.jsonl"), "");
  writeFileSync(path.join(cwd, "config.json"), "{}");
  const agent = { id: "claude", name: "Claude Code", command: process.execPath, args: [fakeAgentPath, "claude", path.join(cwd, "agent.jsonl"), path.join(cwd, "config.json")], authHint: "" };
  await withApp(database, clock, { settleMs: 60_000, sessions: { agents: [agent], blobsDir: null } }, async (app) => {
    const ctx = appContext(app);
    assert.equal((await getRoom(app)).census.sessionsEver, 1);
    const session = await ctx.sessions.createSession(cwd, "claude");
    assert.equal(await ctx.sessions.deleteSession(session.id), true);
    assert.equal(ctx.sessions.listSessions().length, 1);
    assert.equal((await refresh(app)).census.sessionsEver, 2);
  });
});

test("a milestone is stored and logged as room.expanded once, not again on the next count or after a rebuild", async (t) => {
  const database = await temporaryDatabase(t);
  const clock = fakeClock();
  const seed = seeder(database);
  // 25 sessions, the first a little over a year ago.
  await seed.sessions([clock.now() - 400 * DAY, ...Array.from({ length: 24 }, (_, i) => clock.now() - i * HOUR)]);
  const bookcase = MILESTONES.find((m) => m.id === "tall-bookcase");
  const rug = MILESTONES.find((m) => m.id === "second-rug");
  const reachedAt = clock.now();

  const first = await withApp(database, clock, {}, async (app) => {
    const state = await getRoom(app);
    assert.deepEqual(state.milestones, [
      { id: "tall-bookcase", at: reachedAt, summary: bookcase.summary.replace("{n}", "25") },
      { id: "second-rug", at: reachedAt, summary: rug.summary.replace("{n}", "365") },
    ]);
    assert.deepEqual(await expansions(database), [
      { actor: "system", kind: "room.expanded", summary: "The small shelf became a tall bookcase at 25 sessions.", detail: { milestone: "tall-bookcase", value: 25 } },
      { actor: "system", kind: "room.expanded", summary: rug.summary, detail: { milestone: "second-rug", value: 400 } },
    ]);
    clock.advance(1000);
    assert.deepEqual((await refresh(app)).milestones, state.milestones, "the next count keeps them as they were");
    assert.equal((await expansions(database)).length, 2, "and logs nothing again");
    return state.milestones;
  });

  // A purge (the sessions gone) and a restart reach no milestone twice and take none back.
  await database.sql`delete from sessions`;
  clock.advance(DAY);
  await withApp(database, clock, {}, async (app) => {
    assert.deepEqual((await getRoom(app)).milestones, first);
    assert.equal((await expansions(database)).length, 2);
  });
});

test("GET /api/room answers from a 60-second cache; past it, or on POST /api/room/refresh, the census is counted again", async (t) => {
  const database = await temporaryDatabase(t);
  const clock = fakeClock();
  const seed = seeder(database);
  await withApp(database, clock, {}, async (app) => {
    const states = [];
    const off = appContext(app).room.subscribe((state) => states.push(state));
    t.after(off);
    assert.deepEqual((await getRoom(app)).census.watches, { active: 0, finished: 0, fires: 0, ever: 0 });
    await seed.intents([{ status: "active", fires: 4 }]);
    assert.equal((await getRoom(app)).census.watches.ever, 0, "within the cache");
    clock.advance(60_000);
    assert.deepEqual((await getRoom(app)).census.watches, { active: 1, finished: 0, fires: 4, ever: 1 }, "past the cache");
    await seed.grants([null]);
    assert.equal((await getRoom(app)).census.grants, 0, "cached again");
    assert.equal((await refresh(app)).census.grants, 1, "refresh counts past the cache");
    await until(() => states.length >= 2);
    assert.deepEqual(states.map((state) => [state.census.watches.ever, state.census.grants]), [[1, 0], [1, 1]], "each change pushed once, the first count not at all");
  });
});

test("with the orchestrator, an Activity entry schedules a recount and the portal stream gets the new census", async (t) => {
  const database = await temporaryDatabase(t);
  const clock = fakeClock();
  await withApp(database, clock, { orchestrator: true, settleMs: 5 }, async (app) => {
    const ctx = appContext(app);
    await ctx.orchestrator.ready;
    const pushed = [];
    const off = ctx.orchestrator.subscribe((event) => {
      if (event.type === "room") pushed.push(event.state);
    });
    t.after(off);
    const before = (await getRoom(app)).census.activityLastHour;
    await ctx.orchestrator.hub.activity.log({ actor: "user", kind: "item.resolved", summary: "Resolved a thing" });
    await until(() => pushed.length > 0);
    assert.equal(pushed.at(-1).census.activityLastHour, before + 1);
    assert.equal(pushed.at(-1).environment.source, "none");
  });
});
