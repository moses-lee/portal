import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { appContext, buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { fakeDeps, fakeSettings, fakeTimers } from "./fixtures/orchestrator-fakes.mjs";
import { fakeClock, fakeFetch, until } from "./fixtures/room-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const EMPTY_CENSUS = {
  sessionsEver: 0, memoryActive: 0, memoryInbox: 0, watches: { active: 0, finished: 0, fires: 0, ever: 0 }, grants: 0, activityLastHour: 0, since: null,
};

/** A day before the fake clock's start, so no milestone counts the days since. */
const SESSION_AT = 1_700_000_000_000 - 86_400_000;

function sessionRecord(id) {
  return {
    id, agentId: "claude", agentName: "Claude Code", cwd: "/repos/x", projectId: "p1", createdAt: SESSION_AT, lastActiveAt: SESSION_AT, title: null,
    upstreamId: `up-${id}`, state: { modes: null, configOptions: [], commands: [] }, lost: null, turnOpen: false,
  };
}

/**
 * Runs `body` with an app over a throwaway database, closing the app before the database goes (as
 * health.test.mjs does); a `t.after` close would run after the database is dropped and stall.
 */
async function withApp(t, options, body) {
  const setup = await createApp(t, options);
  try {
    await body(setup);
  } finally {
    await setup.app.close();
  }
}

async function createApp(t, { orchestrator = false, sessions = [], env = {} } = {}) {
  const database = await temporaryDatabase(t);
  const store = createPgSessionStore({ db: database.db });
  for (const id of sessions) await store.putSession(sessionRecord(id));
  const fake = fakeFetch();
  const clock = fakeClock();
  const config = loadConfig({ ...process.env, PORTAL_ROOM_OFFLINE: "0", PORTAL_LOCATION: "", ...env });
  const options = orchestrator
    ? { settingsStore: fakeSettings(), deps: fakeDeps().deps, timers: fakeTimers(), model: () => new MockLanguageModelV3({}) }
    : false;
  const app = await buildApp({ config, database, orchestrator: options, lifecycle: { start: false }, searchBackfill: { start: false }, room: { fetch: fake.fetch, now: clock.now, timeZone: () => "Europe/Berlin", refreshEveryMs: 0 } });
  return { app, fake, clock };
}

test("GET /api/room answers source none at once, then the resolved environment, with the census", async (t) => {
  await withApp(t, { sessions: ["s1", "s2"] }, async ({ app, fake }) => {
    const gate = Promise.withResolvers();
    fake.state.gate = gate.promise;
    const first = await app.inject({ method: "GET", url: "/api/room" });
    assert.equal(first.statusCode, 200);
    const state = first.json();
    assert.equal(state.layoutVersion, 1);
    assert.deepEqual(state.milestones, []);
    assert.deepEqual(state.census, { ...EMPTY_CENSUS, sessionsEver: 2, since: SESSION_AT }, "since is the oldest session's createdAt");
    assert.equal(state.environment.source, "none");
    assert.deepEqual([state.environment.latitude, state.environment.longitude, state.environment.timezone], [52.52, 13.4, "Europe/Berlin"]);
    assert.equal(state.environment.weather, null);
    assert.equal(fake.calls.length, 1, "the read started the lookup and did not wait on it");

    gate.resolve();
    await until(() => appContext(app).room.environment.current().weather !== null);
    const environment = await app.inject({ method: "GET", url: "/api/room/environment" });
    assert.equal(environment.statusCode, 200);
    const resolved = environment.json();
    assert.equal(resolved.source, "ip");
    assert.equal(resolved.weather.condition, "rain");
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/room" })).json().environment, resolved);
  });
});

test("POST /api/room/refresh looks everything up again past the caches and is origin-checked", async (t) => {
  await withApp(t, { env: { PORTAL_LOCATION: "40.5,-3.25" } }, async ({ app, fake }) => {
    const refreshed = await app.inject({ method: "POST", url: "/api/room/refresh" });
    assert.equal(refreshed.statusCode, 200);
    const state = refreshed.json();
    assert.equal(state.environment.source, "config");
    assert.deepEqual([state.environment.latitude, state.environment.longitude], [40.5, -3.25]);
    assert.equal(state.environment.weather.condition, "rain");
    assert.equal(state.layoutVersion, 1);
    await app.inject({ method: "POST", url: "/api/room/refresh" });
    assert.equal(fake.count("weather"), 2, "forced past the 20-minute cache");
    assert.equal(fake.count("ipify"), 0, "a configured location is never looked up");

    const crossSite = await app.inject({ method: "POST", url: "/api/room/refresh", headers: { origin: "https://evil.example", host: "portal.local" } });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(fake.count("weather"), 2);
  });
});

test("PORTAL_ROOM_OFFLINE: the routes answer without any outbound call", async (t) => {
  await withApp(t, { env: { PORTAL_ROOM_OFFLINE: "1" } }, async ({ app, fake }) => {
    assert.equal((await app.inject({ method: "GET", url: "/api/room" })).json().environment.source, "none");
    assert.equal((await app.inject({ method: "POST", url: "/api/room/refresh" })).statusCode, 200);
    assert.deepEqual(fake.calls, []);
  });
});

test("loadConfig reads PORTAL_LOCATION and PORTAL_ROOM_OFFLINE", () => {
  assert.deepEqual(loadConfig({}).location, null);
  assert.equal(loadConfig({}).roomOffline, false);
  assert.deepEqual(loadConfig({ PORTAL_LOCATION: " 51.5, -0.12 " }).location, { latitude: 51.5, longitude: -0.12 });
  assert.equal(loadConfig({ PORTAL_ROOM_OFFLINE: "1" }).roomOffline, true);
  for (const bad of ["51.5", "a,b", "91,0", "0,181", "1,2,3", ",4"]) assert.throws(() => loadConfig({ PORTAL_LOCATION: bad }), /PORTAL_LOCATION/, bad);
});

test("the portal stream opens with the room's state and pushes it when the environment changes", async (t) => {
  await withApp(t, { orchestrator: true }, async ({ app, fake, clock }) => {
    const ctx = appContext(app);
    await ctx.orchestrator.ready;
    const gate = Promise.withResolvers();
    fake.state.gate = gate.promise;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`http://127.0.0.1:${port}/api/portal/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const events = [];
    async function next() {
      for (;;) {
        const frames = buffer.split("\n\n");
        buffer = frames.pop();
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
        if (events.length) return events.shift();
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += value;
      }
    }
    const opening = [];
    for (let i = 0; i < 8; i++) opening.push(await next());
    assert.deepEqual(opening.map((event) => event.type), ["status", "items", "threads", "approvals", "intents", "tracked", "workspace", "room"]);
    assert.equal(opening[7].state.environment.source, "none");
    assert.equal(opening[7].state.layoutVersion, 1);

    gate.resolve();
    let event;
    do event = await next(); while (event.type !== "room");
    assert.equal(event.state.environment.source, "ip");
    assert.equal(event.state.environment.weather.condition, "rain");
    // The orchestrator logs on its own as the stream opens (the presence refresh), so the hearth's count is not pinned here.
    assert.deepEqual({ ...event.state.census, activityLastHour: 0 }, { ...EMPTY_CENSUS, since: clock.now() }, "without sessions since is the first count's time");
    controller.abort();
  });
});
