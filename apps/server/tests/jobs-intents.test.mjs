import assert from "node:assert/strict";
import test from "node:test";
import { POLL_MS } from "../src/orchestrator/jobs/worker.ts";
import { T0, call, flush, jobsHarness, started, textStep, toolContext, toolStep } from "./fixtures/jobs-harness.mjs";

const MIN = 60_000;
const pull = { repo: "acme/app", number: 42, url: "https://github.com/acme/app/pull/42" };

const intentArgs = (overrides = {}) => ({
  text: "tell me when #42 merges", trigger: "PR acme/app#42 is merged or closed", action: "Tell me, and offer to remove the worktree",
  scope: { pulls: [pull] }, checkEveryMinutes: 2, ...overrides,
});

async function withIntent(h, overrides) {
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "create_intent", intentArgs(overrides));
  assert.equal(created.error, undefined, created.error);
  return { tools, created };
}

test("create_intent stores the intent and its check job at the agent's cadence, logs it, and announces the active intents", async (t) => {
  const h = await started(jobsHarness(t));
  const { created } = await withIntent(h, { cooldownMinutes: 5, fireBudget: 2, expiresAt: new Date(T0 + 86_400_000).toISOString(), idleCheckEveryMinutes: 15 });
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(
    { text: intent.text, trigger: intent.trigger, status: intent.status, fireBudget: intent.fireBudget, cooldownMs: intent.cooldownMs, expiresAt: intent.expiresAt, threadId: intent.threadId },
    { text: "tell me when #42 merges", trigger: "PR acme/app#42 is merged or closed", status: "active", fireBudget: 2, cooldownMs: 5 * MIN, expiresAt: T0 + 86_400_000, threadId: "main" },
  );
  assert.deepEqual(intent.scope.pulls, [pull]);
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.equal(job.kind, "intent_check");
  assert.equal(job.createdBy, "agent");
  assert.deepEqual(job.schedule, { type: "every", everyMs: 2 * MIN, idleEveryMs: 15 * MIN });
  assert.equal(job.nextRunAt, T0 + 15 * MIN, "nobody is present: the idle cadence");
  assert.deepEqual(job.payload, { intentId: intent.id });
  assert.equal(created.checkJob.id, job.id);
  const [logged] = await h.hub.activity.list({ kind: "intent.created" });
  assert.equal(logged.actor, "agent");
  assert.equal(logged.refs.intentId, intent.id);
  assert.equal(logged.refs.jobId, job.id);
  assert.deepEqual(h.events.findLast((event) => event.type === "intents").intents.map((entry) => entry.id), [intent.id]);
  assert.equal((await h.runtime.status()).counts.intents, 1);

  const tools = h.jobs.tools(toolContext(h));
  assert.equal((await call(tools, "list_intents", {})).intents[0].id, intent.id);
  assert.match((await call(tools, "create_intent", intentArgs({ expiresAt: new Date(T0 - 1).toISOString() }))).error, /in the past/);
  assert.match((await call(tools, "create_intent", intentArgs({ checkEveryMinutes: undefined, checkCron: "not a cron" }))).error, /Invalid cron/);
  assert.equal((await call(tools, "create_intent", intentArgs({ fireBudget: 0 }))).invalidInput, true);
});

test("an intent check fires the intent: a Needs-you item with its links, a note in the thread, and a spent budget finishes the intent and its job", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: [
      toolStep("get_pull", { repo: "acme/app", number: 42 }, "c1"),
      toolStep("fire_intent", { title: "acme/app#42 merged", body: "It merged a minute ago. The worktree can go." }, "c2"),
      textStep("acme/app#42 merged; its worktree can be removed."),
    ],
  }));
  const { created } = await withIntent(h, { checkNow: true });
  await h.timers.advance(POLL_MS);
  await flush();

  const calls = h.model.doGenerateCalls;
  assert.ok(calls.length >= 3);
  const offered = calls[0].tools.map((tool) => tool.name);
  assert.ok(offered.includes("fire_intent") && offered.includes("close_intent") && offered.includes("update_intent"));
  assert.ok(!offered.includes("create_intent") && !offered.includes("run_command") && !offered.includes("schedule_job"), offered.join(","));
  assert.match(JSON.stringify(calls[0].prompt), /PR acme\/app#42 is merged or closed/);

  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.fires, 1);
  assert.equal(intent.status, "done", "a budget of one is spent by one firing");
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.equal(job.status, "done");
  assert.equal(job.nextRunAt, null);
  const [run] = await h.jobs.listRuns({ jobId: job.id });
  assert.equal(run.kind, "intent_check");
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.model, { provider: "anthropic", model: "claude-haiku-4-5" }, "checks run on the bookkeeping model");
  assert.match(run.summary, /^Fired/);

  const [item] = await h.store.listItems();
  assert.deepEqual(
    { list: item.list, kind: item.kind, title: item.title, fingerprint: item.fingerprint, links: item.links },
    { list: "needs_you", kind: "intent_update", title: "acme/app#42 merged", fingerprint: `intent_update:${intent.id}`, links: { intentId: intent.id, threadId: "main", pull } },
  );
  assert.deepEqual(item.actions, [{ type: "open_url", url: pull.url, label: "Open PR" }]);
  const [note] = await h.runtime.history();
  assert.equal(note.parts[0].text, "acme/app#42 merged; its worktree can be removed.");
  assert.deepEqual(note.metadata.run, { id: run.id, kind: "intent_check" });
  assert.deepEqual(note.metadata.itemIds, [item.id]);
  const kinds = (await h.hub.activity.list()).map((entry) => entry.kind);
  for (const kind of ["intent.fired", "intent.closed", "run.finished", "tool.call"]) assert.ok(kinds.includes(kind), kind);
});

test("a check whose trigger does not hold rewrites the notes, posts nothing, and stays scheduled", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: [toolStep("update_intent", { notes: "Still open; CI running." }), textStep("NO_UPDATE")],
  }));
  const { created } = await withIntent(h, { checkNow: true });
  await flush();
  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.notes, "Still open; CI running.");
  assert.equal(intent.fires, 0);
  assert.equal(intent.lastCheckedAt, T0, "checkNow: checked as soon as it was created");
  assert.deepEqual(await h.runtime.history(), []);
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.equal(job.status, "active");
  assert.equal(job.nextRunAt, T0 + 2 * MIN);
  assert.equal((await h.jobs.getRun(job.lastRunId)).summary, "Checked; the trigger does not hold yet.");
});

test("the server enforces cooldown and fire budget, whatever the model asks", async (t) => {
  const h = await started(jobsHarness(t));
  const { created } = await withIntent(h, { fireBudget: 2, cooldownMinutes: 30 });
  const check = h.jobs.tools(toolContext(h, { kind: "intent_check", intentId: created.id, runId: "run-check" }));
  assert.deepEqual(Object.keys(check).sort(), ["close_intent", "fire_intent", "update_intent"]);

  const first = await call(check, "fire_intent", { title: "Checks failed", body: "CI is red." });
  assert.deepEqual(first, { fired: true, itemId: first.itemId, firesLeft: 1, done: false });
  const cooling = await call(check, "fire_intent", { title: "Checks failed again", body: "Still red." });
  assert.equal(cooling.fired, false);
  assert.match(cooling.reason, /cooling down until/);
  assert.equal((await h.jobs.getIntent(created.id)).fires, 1);

  h.timers.tick(30 * MIN);
  const second = await call(check, "fire_intent", { title: "Checks failed again", body: "Still red." });
  assert.equal(second.fired, true);
  assert.equal(second.done, true);
  assert.equal(second.itemId, first.itemId, "one item per intent, updated on each firing");
  assert.equal((await h.store.getItem(first.itemId)).title, "Checks failed again");
  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.status, "done");
  assert.equal(intent.fires, 2);
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  assert.equal(job.status, "done");

  h.timers.tick(60 * MIN);
  const spent = await call(check, "fire_intent", { title: "Again", body: "x" });
  assert.equal(spent.fired, false);
  assert.match(spent.reason, /intent is done/);

  // Unlimited: no budget, just the cooldown.
  const { created: open } = await withIntent(h, { fireBudget: null, cooldownMinutes: 0 });
  const openCheck = h.jobs.tools(toolContext(h, { kind: "intent_check", intentId: open.id }));
  for (let i = 0; i < 3; i++) assert.equal((await call(openCheck, "fire_intent", { title: `Firing ${i}`, body: "x" })).fired, true);
  assert.equal((await h.jobs.getIntent(open.id)).status, "active");
});

test("an intent past its expiry is expired by the worker, its job ends, and a late firing is refused", async (t) => {
  const h = await started(jobsHarness(t));
  const { created } = await withIntent(h, { expiresAt: new Date(T0 + 10 * MIN).toISOString(), checkEveryMinutes: 60 });
  const check = h.jobs.tools(toolContext(h, { kind: "intent_check", intentId: created.id }));
  h.timers.tick(10 * MIN);
  const late = await call(check, "fire_intent", { title: "Too late", body: "x" });
  assert.equal(late.fired, false);
  assert.match(late.reason, /expired/);
  assert.equal((await h.jobs.getIntent(created.id)).status, "expired");

  const { created: other } = await withIntent(h, { expiresAt: new Date(T0 + 20 * MIN).toISOString(), checkEveryMinutes: 60 });
  await h.timers.advance(15 * MIN);
  await flush();
  const expired = await h.jobs.getIntent(other.id);
  assert.equal(expired.status, "expired");
  const [job] = await h.jobs.listJobs({ intentId: other.id });
  assert.equal(job.status, "done");
  const closed = (await h.hub.activity.list({ kind: "intent.closed" })).map((entry) => entry.summary);
  assert.ok(closed.every((summary) => /^Expired:/.test(summary)) && closed.length === 2, closed.join(" | "));
  assert.deepEqual(h.events.findLast((event) => event.type === "intents").intents, []);
});

test("update_intent rewrites the intent and reschedules its check; cancel_intent and cancelling the check job both end it", async (t) => {
  const h = await started(jobsHarness(t, { presence: 1 }));
  const { tools, created } = await withIntent(h);
  const updated = await call(tools, "update_intent", { id: created.id, trigger: "PR acme/app#42 is merged", checkEveryMinutes: 30, scope: { repos: ["acme/app"] }, expiresAt: null });
  assert.equal(updated.trigger, "PR acme/app#42 is merged");
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(intent.scope.pulls, [pull], "a partial scope merges with the stored one");
  assert.deepEqual(intent.scope.repos, ["acme/app"]);
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  assert.deepEqual(job.schedule, { type: "every", everyMs: 30 * MIN });
  assert.equal(job.nextRunAt, T0 + 2 * MIN, "a sooner plan for a job that never ran stays");
  assert.match((await h.hub.activity.list({ kind: "intent.updated" }))[0].summary, /trigger, scope, expiresAt, cadence/);

  const cancelled = await call(tools, "cancel_intent", { id: created.id, reason: "The user merged it by hand." });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await h.jobs.getJob(job.id)).status, "cancelled");
  assert.match((await call(tools, "update_intent", { id: created.id, notes: "x" })).error, /cancelled; create a new one/);

  const { created: second } = await withIntent(h);
  const [secondJob] = await h.jobs.listJobs({ intentId: second.id });
  const viaJob = await call(tools, "cancel_job", { id: secondJob.id });
  assert.equal(viaJob.status, "cancelled");
  assert.equal((await h.jobs.getIntent(second.id)).status, "cancelled", "an intent without its check is cancelled with it");

  // The UI may re-activate a cancelled intent: a fresh check job at the old cadence.
  const back = await h.jobs.updateIntent(second.id, { status: "active" }, "user");
  assert.equal(back.status, "active");
  const live = (await h.jobs.listJobs({ intentId: second.id, status: ["active"] }));
  assert.equal(live.length, 1);
  assert.deepEqual(live[0].schedule, { type: "every", everyMs: 2 * MIN });
  assert.equal(live[0].createdBy, "user");
});

test("a check job whose intent is gone or closed ends itself without calling the model", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("should not run")] }));
  const { created } = await withIntent(h);
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  // Closed behind the job's back (another process); its job was not told.
  await h.jobsStore.updateIntent(created.id, { status: "done" });
  await h.timers.advance(2 * MIN);
  await flush();
  assert.equal(h.model.doGenerateCalls.length, 0);
  assert.equal((await h.jobs.getJob(job.id)).status, "done");
  assert.equal((await h.jobs.getRun((await h.jobs.getJob(job.id)).lastRunId)).summary, "The intent is done.");
});
