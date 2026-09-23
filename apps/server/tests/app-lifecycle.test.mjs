import assert from "node:assert/strict";
import test from "node:test";
import { appContext, buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeDeps, fakeSettings, fakeTimers } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

/** Reads a fetch body until it ends; resolves with how the stream finished. */
async function drain(response) {
  const reader = response.body.getReader();
  try {
    for (;;) if ((await reader.read()).done) return "ended";
  } catch {
    return "reset";
  }
}

test("closing an app with open event streams disposes the services first and finishes promptly", async (t) => {
  const database = await temporaryDatabase(t);
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings(), deps: fakeDeps().deps, timers: fakeTimers() } });
  const ctx = appContext(app);
  const calls = [];
  for (const [service, method] of [[ctx.orchestrator, "dispose"], [ctx.sessions, "dispose"], [ctx.terminals, "disposeAll"]]) {
    const original = service[method];
    service[method] = (...args) => {
      // Recorded with the browsers' presence at that moment: the streams still count until they are ended.
      calls.push(`${method === "disposeAll" ? "terminals" : service === ctx.orchestrator ? "orchestrator" : "sessions"}@${ctx.presence.count()}`);
      return original(...args);
    };
  }
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const streams = await Promise.all(["/api/sessions/stream", "/api/portal/stream"].map((url) => fetch(base + url, { signal: controller.signal })));
  assert.deepEqual(streams.map((response) => response.status), [200, 200]);
  const finished = streams.map(drain);
  for (let i = 0; i < 100 && ctx.presence.count() < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ctx.presence.count(), 2, "both streams are open");

  const started = Date.now();
  await app.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `app.close() took ${elapsed} ms`);
  // The orchestrator stops while the tabs are still there; the streams end before the sessions go.
  assert.deepEqual(calls, ["orchestrator@2", "sessions@0", "terminals@0"]);
  assert.deepEqual(await Promise.all(finished), ["ended", "ended"], "the browsers see the streams end cleanly");
});

test("a second app on the same database refuses to boot until the first one closes", async (t) => {
  const database = await temporaryDatabase(t);
  // The first app owns its pool (as the server does), the others share the test's.
  const first = await buildApp({ config: { ...loadConfig(), databaseUrl: database.url }, orchestrator: false });
  await assert.rejects(buildApp({ database, orchestrator: false }), /another Portal server is already using the database "portal_test_/i);

  const shared = await buildApp({ database, orchestrator: false, singleInstance: false });
  await shared.close();

  await first.close();
  const third = await buildApp({ database, orchestrator: false });
  const response = await third.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  await assert.rejects(buildApp({ database, orchestrator: false }), /another Portal server/i);
  await third.close();
  // pg_locks lists the whole cluster; other test files hold their own databases' locks meanwhile.
  const [{ held }] = await database.sql`select count(*)::int as held from pg_locks
    where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`;
  assert.equal(held, 0, "closing releases the lock instead of leaving it on a pooled connection");
});
