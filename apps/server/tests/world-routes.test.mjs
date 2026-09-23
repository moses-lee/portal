import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { attentionPull, fakeDeps, fakeSettings, fakeTimers, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

// Nothing here may touch the real ~/.portal.
const home = mkdtempSync(path.join(os.tmpdir(), "portal-world-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { buildApp } = await import("../src/app.ts");

async function setup(t) {
  const database = await temporaryDatabase(t);
  const { deps, state } = fakeDeps({
    projects: [project({ id: "p1", name: "mono", path: "/code/mono" })],
    sessions: [sessionMeta({ id: "s1", projectId: "p1" })],
    pulls: [attentionPull({ repo: "acme/monorepo", number: 2367, roles: ["reviewer"] })],
    originUrl: async () => "git@github.com:acme/monorepo.git",
  });
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings(), deps, timers: fakeTimers(), model: () => new MockLanguageModelV3({}) } });
  t.after(() => app.close());
  return { app, database, state };
}

const rows = async (database) => (await database.sql`select count(*)::int as n from world_snapshots`)[0].n;

test("GET /api/portal/world builds the first world and then answers the stored one", async (t) => {
  const { app, database, state } = await setup(t);
  const first = await app.inject({ method: "GET", url: "/api/portal/world" });
  assert.equal(first.statusCode, 200);
  const body = first.json();
  assert.deepEqual(Object.keys(body).sort(), ["rendered", "tokens", "world"]);
  assert.deepEqual(body.world.repos, [{ repo: "acme/monorepo", defaultBranch: "main", projectIds: ["p1"] }]);
  assert.equal(body.world.pulls[0].localProjectId, "p1");
  assert.match(body.rendered, /acme\/monorepo#2367/);
  assert.equal(body.tokens, Math.ceil(body.rendered.length / 4));
  assert.equal(await rows(database), 1);
  const again = await app.inject({ method: "GET", url: "/api/portal/world" });
  assert.equal(again.json().world.at, body.world.at);
  assert.equal(state.searches.length, 1, "the second request did not rebuild");
  assert.equal(await rows(database), 1);
});

test("POST /api/portal/world/refresh rebuilds and stores; both routes refuse cross-origin requests", async (t) => {
  const { app, database, state } = await setup(t);
  const refreshed = await app.inject({ method: "POST", url: "/api/portal/world/refresh" });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.json().world.login, "moses-lee");
  await app.inject({ method: "POST", url: "/api/portal/world/refresh" });
  assert.equal(state.searches.length, 2);
  assert.equal(await rows(database), 2);
  const headers = { origin: "https://evil.example" };
  assert.equal((await app.inject({ method: "GET", url: "/api/portal/world", headers })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/portal/world/refresh", headers })).statusCode, 403);
  assert.equal(await rows(database), 2);
});
