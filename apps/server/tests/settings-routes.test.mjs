import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { credentials } from "../src/db/schema.ts";
import { defaultSettings } from "@portal/shared/settings";
import { temporaryDatabase } from "./helpers/db.mjs";

async function setup(t) {
  const database = await temporaryDatabase(t);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-settings-routes-")));
  const portalHome = path.join(root, "home");
  const app = await buildApp({ config: { ...loadConfig(), portalHome }, database, orchestrator: false });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const patch = (payload, headers = {}) => app.inject({ method: "PATCH", url: "/api/settings", payload, headers });
  return { app, database, portalHome, patch };
}

test("GET /api/settings answers the defaults", async (t) => {
  const { app } = await setup(t);
  const response = await app.inject({ method: "GET", url: "/api/settings" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { settings: defaultSettings });
});

test("PATCH /api/settings round-trips, masks keys, and seals them under the server key", async (t) => {
  const { app, database, portalHome, patch } = await setup(t);
  const response = await patch({
    gitActions: { prompts: { checks: " Look at CI " } },
    orchestrator: { model: "claude-x", provider: "anthropic", apiKeys: { anthropic: "sk-ant-secret" } },
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("sk-ant"), "the key never reaches the wire");
  const { settings } = response.json();
  assert.equal(settings.gitActions.prompts.checks, "Look at CI");
  assert.deepEqual(settings.orchestrator, { ...defaultSettings.orchestrator, provider: "anthropic", model: "claude-x", apiKeys: { openai: false, anthropic: true } });

  const read = await app.inject({ method: "GET", url: "/api/settings" });
  assert.deepEqual(read.json(), { settings });
  assert.ok(!read.body.includes("sk-ant"));
  assert.ok(existsSync(path.join(portalHome, "server.key")), "the key lives in config.portalHome");
  const rows = await database.db.select().from(credentials);
  assert.deepEqual(rows.map(({ name }) => name), ["anthropic"]);
  assert.ok(!rows[0].ciphertext.includes("sk-ant"));

  // The server side can still read the key; "" clears it.
  const cleared = await patch({ orchestrator: { apiKeys: { anthropic: "" } } });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().settings.orchestrator.apiKeys.anthropic, false);
  assert.deepEqual(await database.db.select().from(credentials), []);
});

test("PATCH /api/settings answers 400 { error } for bad bodies", async (t) => {
  const { app, patch } = await setup(t);
  const cases = [
    [{ gitActions: { prompts: { deploy: "x" } } }, /Unknown git action "deploy"/],
    [{ orchestrator: { intervalMinutes: 0 } }, /intervalMinutes must be a whole number/],
    [{ orchestrator: { apiKeys: { google: "sk" } } }, /Unknown provider "google"/],
    [[1, 2], /Expected a JSON object/],
    ["null", /Expected a JSON object/],
  ];
  for (const [payload, pattern] of cases) {
    const response = typeof payload === "string"
      ? await app.inject({ method: "PATCH", url: "/api/settings", payload, headers: { "content-type": "application/json" } })
      : await patch(payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.match(response.json().error, pattern);
  }
  // No body at all.
  const empty = await app.inject({ method: "PATCH", url: "/api/settings" });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, "Expected a JSON body.");
  // Malformed JSON is Fastify's own 400, still as { error }.
  const bad = await app.inject({ method: "PATCH", url: "/api/settings", payload: "{ nope", headers: { "content-type": "application/json" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(typeof bad.json().error, "string");
  // Nothing changed.
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings" })).json(), { settings: defaultSettings });
});

test("/api/settings refuses cross-origin requests with 403", async (t) => {
  const { app, patch } = await setup(t);
  const cross = await patch({ gitActions: { prompts: { checks: "x" } } }, { origin: "https://evil.example", host: "portal.local" });
  assert.equal(cross.statusCode, 403);
  assert.match(cross.json().error, /Cross-origin/);
  const site = await patch({ gitActions: { prompts: { checks: "x" } } }, { "sec-fetch-site": "cross-site" });
  assert.equal(site.statusCode, 403);
  const get = await app.inject({ method: "GET", url: "/api/settings", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(get.statusCode, 403);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings" })).json(), { settings: defaultSettings }, "nothing was written");

  // Same origin through the proxy is fine.
  const same = await patch({ gitActions: { prompts: { checks: "x" } } }, { origin: "http://portal.local:3000", "x-forwarded-host": "portal.local:3000" });
  assert.equal(same.statusCode, 200);
});
