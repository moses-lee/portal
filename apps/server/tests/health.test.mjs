import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

test("GET /api/health answers on a migrated database", async (t) => {
  const database = await temporaryDatabase(t);
  const app = await buildApp({ database, orchestrator: false });
  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, service: "portal-server" });
  } finally {
    await app.close();
  }
});

test("loadConfig has development defaults and validates the port", () => {
  const config = loadConfig({});
  assert.equal(config.port, 3100);
  assert.equal(config.host, "127.0.0.1");
  assert.match(config.databaseUrl, /^postgres:\/\//);
  assert.throws(() => loadConfig({ PORTAL_SERVER_PORT: "nope" }), /PORTAL_SERVER_PORT/);
});
