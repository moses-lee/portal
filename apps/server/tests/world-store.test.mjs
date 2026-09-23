import assert from "node:assert/strict";
import test from "node:test";
import { createPgWorldStore } from "../src/orchestrator/world/pg-store.ts";
import { createMemoryWorldStore } from "../src/orchestrator/world/store.ts";
import { T0 } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

function world(at, overrides = {}) {
  return {
    at, login: "moses-lee", projects: [], repos: [{ repo: "acme/app", defaultBranch: "main", projectIds: ["p1"] }], sessions: [], terminals: [],
    pulls: [], intents: [], jobs: [], items: [], errors: [], snapshot: { at, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [] }, ...overrides,
  };
}

function storeBehaviour(label, open) {
  test(`${label}: an empty store has no latest build`, async (t) => {
    const store = await open(t);
    assert.equal(await store.latest(), null);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.prune(5), 0);
  });

  test(`${label}: builds are appended, the newest is the latest, and lists page newest first`, async (t) => {
    const store = await open(t);
    const first = await store.append(world(T0), "tick");
    const second = await store.append(world(T0 + 1000, { login: "other" }), "manual");
    assert.ok(second.id > first.id);
    assert.deepEqual(second, { id: second.id, at: T0 + 1000, reason: "manual", world: world(T0 + 1000, { login: "other" }) });
    assert.deepEqual(await store.latest(), second);
    assert.deepEqual((await store.list()).map((b) => b.reason), ["manual", "tick"]);
    assert.deepEqual((await store.list({ limit: 1 })).map((b) => b.id), [second.id]);
    assert.deepEqual((await store.list({ before: second.id })).map((b) => b.id), [first.id]);
  });

  test(`${label}: NUL bytes are stripped and the stored copy does not change with the caller's object`, async (t) => {
    const store = await open(t);
    const input = world(T0, { errors: ["bad\u0000byte"] });
    await store.append(input, "tick");
    input.errors.push("later");
    assert.deepEqual((await store.latest()).world.errors, ["badbyte"]);
  });

  test(`${label}: prune keeps the newest builds only`, async (t) => {
    const store = await open(t);
    for (let i = 0; i < 7; i++) await store.append(world(T0 + i), `b${i}`);
    assert.equal(await store.prune(3), 4);
    assert.deepEqual((await store.list()).map((b) => b.reason), ["b6", "b5", "b4"]);
    assert.equal(await store.prune(3), 0);
    assert.equal(await store.prune(0), 3);
    assert.equal(await store.latest(), null);
  });
}

storeBehaviour("memory", async () => createMemoryWorldStore());
storeBehaviour("postgres", async (t) => createPgWorldStore({ db: (await temporaryDatabase(t)).db }));
