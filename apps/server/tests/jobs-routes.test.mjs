import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { jobRuns } from "../src/db/schema.ts";
import { T0, fakeDeps, fakeSettings, fakeTimers, flush } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

// Nothing here may touch the real ~/.portal.
const home = mkdtempSync(path.join(os.tmpdir(), "portal-jobs-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { appContext, buildApp } = await import("../src/app.ts");

const MIN = 60_000;

/** The app over a throwaway database, with the live Postgres jobs store and a runtime that never reaches a provider. */
async function setup(t) {
  const database = await temporaryDatabase(t);
  const timers = fakeTimers();
  const { deps } = fakeDeps({});
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("no model in this test"); } });
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings({ key: "sk-test" }), deps, timers, model: () => model } });
  t.after(() => app.close());
  const runtime = appContext(app).orchestrator;
  await runtime.ready;
  return { app, runtime, jobs: runtime.hub.jobs, timers };
}

const inject = (app, method, url, payload) => app.inject({ method, url, payload });

test("jobs: listing by status, patching (pause, reschedule, cancel), run now, and their errors", async (t) => {
  const { app, jobs } = await setup(t);
  const listed = (await inject(app, "GET", "/api/portal/jobs")).json().jobs;
  assert.deepEqual(listed.map((job) => [job.id, job.kind, job.status]), [["consolidate", "consolidate", "active"]], "never the world refresh");

  const { intent, job } = await jobs.createIntent({ text: "tell me when #7 merges", trigger: "acme/app#7 merged", action: "tell me", check: { type: "every", everyMs: 5 * MIN } }, { actor: "agent" });
  assert.deepEqual((await inject(app, "GET", "/api/portal/jobs?status=active,paused")).json().jobs.map((entry) => entry.id), [job.id, "consolidate"]);
  assert.deepEqual((await inject(app, "GET", "/api/portal/jobs?status=done")).json(), { jobs: [] });
  assert.equal((await inject(app, "GET", "/api/portal/jobs?status=bogus")).statusCode, 400);

  const paused = await inject(app, "PATCH", `/api/portal/jobs/${job.id}`, { status: "paused" });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().job.status, "paused");
  assert.equal(paused.json().job.nextRunAt, null);
  const moved = await inject(app, "PATCH", `/api/portal/jobs/${job.id}`, { status: "active", schedule: { type: "every", everyMs: 15 * MIN }, title: "Watch #7" });
  assert.deepEqual([moved.json().job.status, moved.json().job.title, moved.json().job.nextRunAt], ["active", "Watch #7", T0 + 15 * MIN]);
  const logged = (await jobs.listRuns({})).length;
  assert.equal(logged, 0);
  const entries = await appContext(app).orchestrator.hub.activity.list({ kind: "job.updated" });
  assert.equal(entries[0].actor, "user");

  for (const [body, pattern] of [
    [{ status: "done" }, /"status" must be one of active, paused, cancelled/],
    [{ schedule: { type: "every", everyMs: 10 } }, /between one minute/],
    [{ schedule: { type: "cron", expr: "nope" } }, /Invalid cron/],
    [{ title: "" }, /"title"/],
  ]) {
    const bad = await inject(app, "PATCH", `/api/portal/jobs/${job.id}`, body);
    assert.equal(bad.statusCode, 400, JSON.stringify(body));
    assert.match(bad.json().error, pattern);
  }
  assert.deepEqual((await inject(app, "PATCH", `/api/portal/jobs/${job.id}`, ["x"])).json(), { error: "Expected a JSON object body." });
  assert.equal((await inject(app, "PATCH", "/api/portal/jobs/nope", { status: "paused" })).statusCode, 404);
  // The world refresh is nobody's to change or run: it is unknown here.
  for (const body of [{ status: "cancelled" }, { status: "paused" }, { schedule: { type: "every", everyMs: 5 * MIN } }]) {
    assert.equal((await inject(app, "PATCH", "/api/portal/jobs/tick", body)).statusCode, 404, JSON.stringify(body));
  }
  assert.equal((await inject(app, "POST", "/api/portal/jobs/tick/run")).statusCode, 404);

  // Run now: answered with its run; an unknown or finished job is a 404.
  const ran = await inject(app, "POST", `/api/portal/jobs/${job.id}/run`);
  assert.equal(ran.statusCode, 200);
  assert.equal(ran.json().run.kind, "intent_check");
  assert.equal(ran.json().run.trigger, "manual");
  await flush();
  assert.equal((await inject(app, "POST", "/api/portal/jobs/nope/run")).statusCode, 404);

  const cancelled = await inject(app, "PATCH", `/api/portal/jobs/${job.id}`, { status: "cancelled" });
  assert.equal(cancelled.json().job.status, "cancelled");
  assert.equal((await jobs.getIntent(intent.id)).status, "cancelled", "cancelling the check cancels its intent");
  assert.equal((await inject(app, "POST", `/api/portal/jobs/${job.id}/run`)).statusCode, 404);
  assert.equal((await inject(app, "PATCH", `/api/portal/jobs/${job.id}`, { status: "active" })).statusCode, 409);
});

test("runs and intents: history with filters and paging, one run, cancel, and the intent patch", async (t) => {
  const { app, runtime, jobs, timers } = await setup(t);
  const helpers = [];
  for (let i = 0; i < 3; i++) {
    timers.tick(1_000);
    const run = await jobs.startRun({ kind: "helper", trigger: "agent", summary: `helper ${i}` });
    helpers.push(await jobs.finishRun(run.id, { status: "succeeded", result: { n: i } }));
  }
  // The world refresh runs too; its runs are stored but never listed or found.
  await timers.advance(MIN);
  // The Postgres worker answers in real time: wait for the refresh's run to finish.
  let refreshRun;
  for (let i = 0; i < 200 && refreshRun?.status !== "succeeded"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    [refreshRun] = await runtime.hub.db.select().from(jobRuns).where(eq(jobRuns.kind, "tick"));
  }
  assert.equal(refreshRun?.status, "succeeded");
  assert.deepEqual((await runtime.hub.world.store.list()).map((build) => build.reason), ["tick"]);
  timers.tick(1_000);
  const chat = await jobs.startRun({ kind: "chat", trigger: "user", threadId: "main" });

  const all = (await inject(app, "GET", "/api/portal/runs")).json().runs;
  assert.deepEqual(all.map((run) => run.kind), ["chat", "helper", "helper", "helper"], "newest first, no world refresh");
  assert.equal(all[0].id, chat.id);
  assert.deepEqual((await inject(app, "GET", "/api/portal/runs?kind=tick")).json(), { runs: [] });
  assert.deepEqual((await inject(app, "GET", "/api/portal/runs?jobId=tick")).json(), { runs: [] });
  const listed = (await inject(app, "GET", "/api/portal/runs?kind=helper")).json().runs;
  assert.deepEqual(listed.map((run) => run.id), helpers.map((run) => run.id).reverse());
  const page = (await inject(app, "GET", `/api/portal/runs?kind=helper&limit=2&before=${listed[0].id}`)).json().runs;
  assert.deepEqual(page.map((run) => run.id), listed.slice(1).map((run) => run.id));
  assert.deepEqual((await inject(app, "GET", "/api/portal/runs?threadId=elsewhere")).json(), { runs: [] });
  assert.equal((await inject(app, "GET", "/api/portal/runs?kind=bogus")).statusCode, 400);
  assert.deepEqual((await inject(app, "GET", `/api/portal/runs/${helpers[0].id}`)).json().run.result, { n: 0 });
  assert.equal((await inject(app, "GET", "/api/portal/runs/nope")).statusCode, 404);
  assert.equal((await inject(app, "GET", `/api/portal/runs/${refreshRun.id}`)).statusCode, 404);
  assert.equal((await inject(app, "POST", `/api/portal/runs/${refreshRun.id}/cancel`)).statusCode, 404);
  for (const route of ["/api/portal/tick", "/api/portal/ticks"]) {
    assert.equal((await inject(app, route.endsWith("s") ? "GET" : "POST", route)).statusCode, 404, `${route} is gone`);
  }

  assert.equal((await inject(app, "POST", `/api/portal/runs/${helpers[0].id}/cancel`)).statusCode, 204, "already finished: nothing to do");
  assert.equal((await inject(app, "POST", `/api/portal/runs/${chat.id}/cancel`)).statusCode, 409, "a chat turn is stopped from its thread");
  assert.equal((await inject(app, "POST", "/api/portal/runs/nope/cancel")).statusCode, 404);

  const { intent } = await jobs.createIntent({ text: "watch #9", trigger: "acme/app#9 merged", action: "tell me", check: { type: "every", everyMs: 5 * MIN } }, { actor: "agent" });
  assert.deepEqual((await inject(app, "GET", "/api/portal/intents")).json().intents.map((entry) => entry.id), [intent.id]);
  assert.deepEqual((await inject(app, "GET", "/api/portal/intents?status=cancelled")).json(), { intents: [] });
  assert.equal((await inject(app, "GET", "/api/portal/intents?status=paused")).statusCode, 400);
  const cancelled = await inject(app, "PATCH", `/api/portal/intents/${intent.id}`, { status: "cancelled" });
  assert.equal(cancelled.json().intent.status, "cancelled");
  assert.deepEqual((await jobs.listJobs({ intentId: intent.id })).map((job) => job.status), ["cancelled"]);
  const back = await inject(app, "PATCH", `/api/portal/intents/${intent.id}`, { status: "active" });
  assert.equal(back.json().intent.status, "active");
  assert.equal((await jobs.listJobs({ intentId: intent.id, status: ["active"] })).length, 1);
  assert.equal((await inject(app, "PATCH", `/api/portal/intents/${intent.id}`, { status: "done" })).statusCode, 400);
  assert.equal((await inject(app, "PATCH", "/api/portal/intents/nope", { status: "cancelled" })).statusCode, 404);
  const closed = (await runtime.hub.activity.list({ kind: "intent.closed" }))[0];
  assert.equal(closed.actor, "user");
});
