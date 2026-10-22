import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { credentials } from "../src/db/schema.ts";
import { defaultSettings, exportSettings } from "@portal/shared/settings";
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

test("PATCH /api/settings round-trips the sessions clocks", async (t) => {
  const { app, patch } = await setup(t);
  const response = await patch({ sessions: { worktrees: { removeAfterHours: 168 }, idleStop: { enabled: false, afterMinutes: 30 } } });
  assert.equal(response.statusCode, 200);
  const { settings } = response.json();
  assert.deepEqual(settings.sessions, { worktrees: { removeAfterHours: 168 }, idleStop: { enabled: false, afterMinutes: 30 } });
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings" })).json(), { settings });
});

test("PATCH /api/settings round-trips the monitoring section, expanding ~ in watched folders", async (t) => {
  const { app, patch } = await setup(t);
  const response = await patch({ monitoring: { disk: { warnFreeGb: 50, criticalFreeGb: 20 }, watchedFolders: ["~/.codex", "/opt/cache"] } });
  assert.equal(response.statusCode, 200);
  const { settings } = response.json();
  assert.deepEqual(settings.monitoring, { disk: { warnFreeGb: 50, criticalFreeGb: 20 }, watchedFolders: [path.join(os.homedir(), ".codex"), "/opt/cache"] });
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings" })).json(), { settings });
  const inverted = await patch({ monitoring: { disk: { criticalFreeGb: 60 } } });
  assert.equal(inverted.statusCode, 400);
  assert.match(inverted.json().error, /warning level \(50 GB\) must be above the critical level \(60 GB\)/);
  assert.equal((await patch({ monitoring: { watchedFolders: ["relative"] } })).statusCode, 400);
});

test("PATCH /api/settings answers 400 { error } for bad bodies", async (t) => {
  const { app, patch } = await setup(t);
  const cases = [
    [{ gitActions: { prompts: { deploy: "x" } } }, /Unknown git action "deploy"/],
    [{ orchestrator: { model: 5 } }, /model must be a string/],
    [{ orchestrator: { apiKeys: { google: "sk" } } }, /Unknown provider "google"/],
    [{ sessions: { worktrees: { removeAfterHours: 12.5 } } }, /sessions\.worktrees\.removeAfterHours must be a whole number of hours/],
    [{ sessions: { idleStop: { afterMinutes: 5 } } }, /sessions\.idleStop\.afterMinutes must be a whole number of minutes between 10 and 10080/],
    [{ sessions: { idleStop: { enabled: "yes" } } }, /sessions\.idleStop\.enabled must be true or false/],
    [{ sessions: { idleStop: 1 } }, /sessions\.idleStop must be an object/],
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

test("PUT /api/settings imports a full export and leaves stored keys alone", async (t) => {
  const { app, patch } = await setup(t);
  assert.equal((await patch({ orchestrator: { apiKeys: { anthropic: "sk-ant-secret" } } })).statusCode, 200);
  const exported = exportSettings(defaultSettings);
  assert.ok(!("apiKeys" in exported.orchestrator), "exports carry no keys");
  const body = structuredClone(exported);
  body.gitActions.prompts.checks = "Look at CI";
  body.orchestrator.provider = "openai";
  body.orchestrator.model = "gpt-x";
  body.sessions.idleStop = { enabled: false, afterMinutes: 30 };
  body.monitoring.watchedFolders = ["/tmp"];
  const response = await app.inject({ method: "PUT", url: "/api/settings", payload: body });
  assert.equal(response.statusCode, 200, response.body);
  const { settings } = response.json();
  assert.deepEqual(exportSettings(settings), body);
  assert.deepEqual(settings.orchestrator.apiKeys, { ...defaultSettings.orchestrator.apiKeys, anthropic: true });
  // Importing the defaults puts every setting back.
  const reset = await app.inject({ method: "PUT", url: "/api/settings", payload: exported });
  assert.deepEqual(exportSettings(reset.json().settings), exported);
});

test("PUT /api/settings refuses partial, extra, keyed, and invalid imports", async (t) => {
  const { app } = await setup(t);
  const full = () => structuredClone(exportSettings(defaultSettings));
  const without = (edit) => {
    const body = full();
    edit(body);
    return body;
  };
  const cases = [
    [{ version: 1, sessions: full().sessions }, /gitActions is missing; an import must include every setting/],
    [without((b) => delete b.orchestrator.watch.model), /orchestrator\.watch\.model is missing/],
    [without((b) => delete b.version), /version is missing/],
    [without((b) => (b.version = 2)), /version must be 1/],
    [without((b) => (b.extra = true)), /Unknown setting extra/],
    [without((b) => (b.sessions.worktrees.days = 3)), /Unknown setting sessions\.worktrees\.days/],
    [without((b) => (b.orchestrator.apiKeys = { anthropic: "sk-ant" })), /API keys cannot be imported/],
    [without((b) => (b.orchestrator.stalls = 5)), /orchestrator\.stalls must be an object/],
    [without((b) => (b.sessions.idleStop.afterMinutes = 5)), /sessions\.idleStop\.afterMinutes must be a whole number/],
    [without((b) => (b.monitoring.disk = { warnFreeGb: 10, criticalFreeGb: 20 })), /must be above the critical level/],
    [[1], /Expected a JSON object/],
  ];
  for (const [payload, pattern] of cases) {
    const response = await app.inject({ method: "PUT", url: "/api/settings", payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.match(response.json().error, pattern);
  }
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/settings" })).json(), { settings: defaultSettings }, "nothing was written");
  const cross = await app.inject({ method: "PUT", url: "/api/settings", payload: full(), headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(cross.statusCode, 403);
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
