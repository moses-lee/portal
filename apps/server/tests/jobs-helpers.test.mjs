import assert from "node:assert/strict";
import test from "node:test";
import { MAX_HELPER_DEPTH } from "../src/orchestrator/jobs/helpers.ts";
import { T0, call, flush, jobsHarness, started, textStep, toolContext } from "./fixtures/jobs-harness.mjs";

const MIN = 60_000;

/** A chat run to hang tool calls on, as a chat turn would have. */
async function chatRun(h) {
  return h.jobs.startRun({ kind: "chat", trigger: "user", threadId: "main" });
}

test("run_helper with wait runs a sub-turn inside the chat turn, records it as a child run, and returns its answer", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("The monorepo is acme/app; PR 2367 touches billing.")] }));
  const parent = await chatRun(h);
  const tools = h.jobs.tools(toolContext(h, { runId: parent.id }));
  const answer = await call(tools, "run_helper", { prompt: "Which repo has PR 2367 and what does it touch?", wait: true, maxSteps: 4 });
  assert.equal(answer.text, "The monorepo is acme/app; PR 2367 touches billing.");
  const run = await h.jobs.getRun(answer.runId);
  assert.deepEqual(
    { kind: run.kind, parentRunId: run.parentRunId, status: run.status, trigger: run.trigger, jobId: run.jobId, threadId: run.threadId },
    { kind: "helper", parentRunId: parent.id, status: "succeeded", trigger: "agent", jobId: null, threadId: "main" },
  );
  assert.equal(run.summary, "The monorepo is acme/app; PR 2367 touches billing.");
  // The helper saw the read-only set, nothing that changes things, and no job tools.
  const offered = h.model.doGenerateCalls[0].tools.map((tool) => tool.name);
  assert.ok(offered.includes("get_pull") && offered.includes("read_transcript"));
  for (const name of ["run_command", "send_prompt", "delete_session", "create_intent", "run_helper"]) assert.ok(!offered.includes(name), name);
  assert.match(JSON.stringify(h.model.doGenerateCalls[0].prompt), /running as a helper/);
  assert.deepEqual(await h.runtime.history(), [], "an inline helper posts nothing; the chat turn answers");
});

test("run_helper without wait schedules a helper job now; it runs in the background and posts its answer to the thread", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("Found three stale worktrees.")] }));
  const side = await h.store.createThread({ title: "Cleanup" });
  const parent = await h.jobs.startRun({ kind: "chat", trigger: "user", threadId: side.id });
  const tools = h.jobs.tools(toolContext(h, { runId: parent.id, threadId: side.id }));
  const scheduled = await call(tools, "run_helper", { prompt: "List stale worktrees.", tools: ["list_projects"] });
  assert.equal(scheduled.scheduled, true);
  await flush();
  const job = await h.jobs.getJob(scheduled.jobId);
  assert.deepEqual(
    { kind: job.kind, status: job.status, threadId: job.threadId, createdBy: job.createdBy, schedule: job.schedule.type },
    { kind: "helper", status: "done", threadId: side.id, createdBy: "agent", schedule: "at" },
  );
  assert.deepEqual(job.payload, { prompt: "List stale worktrees.", tools: ["list_projects"], parentRunId: parent.id, depth: 1 });
  const [run] = await h.jobs.listRuns({ jobId: job.id });
  assert.equal(run.parentRunId, parent.id);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(h.model.doGenerateCalls[0].tools.map((tool) => tool.name), ["list_projects"], "only the tools it was given");
  const [note] = await h.runtime.history(side.id);
  assert.equal(note.parts[0].text, "Found three stale worktrees.");
  assert.deepEqual(note.metadata.run, { id: run.id, kind: "helper" });
  const scheduledEntry = (await h.hub.activity.list({ kind: "job.scheduled" })).find((entry) => entry.refs.jobId === job.id);
  assert.equal(scheduledEntry.actor, "agent");
  assert.equal(scheduledEntry.refs.runId, parent.id);
});

test("helpers nest at most two levels; a background turn cannot wait and schedules instead", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("level two")] }));
  const chat = await chatRun(h);
  const one = await h.jobs.startRun({ kind: "helper", trigger: "agent", threadId: "main", parentRunId: chat.id });
  const two = await h.jobs.startRun({ kind: "helper", trigger: "agent", threadId: "main", parentRunId: one.id });
  assert.equal(MAX_HELPER_DEPTH, 2);

  const fromOne = h.jobs.tools(toolContext(h, { runId: one.id }));
  assert.equal((await call(fromOne, "run_helper", { prompt: "Go deeper.", wait: true })).text, "level two", "depth two is allowed");
  const fromTwo = h.jobs.tools(toolContext(h, { runId: two.id }));
  assert.match((await call(fromTwo, "run_helper", { prompt: "Deeper still.", wait: true })).error, /at most 2 levels/);
  assert.match((await call(fromTwo, "run_helper", { prompt: "Deeper, later." })).error, /at most 2 levels/, "scheduling counts too");

  // A helper job's own turn (origin job) naming run_helper: wait is not possible there.
  const jobCtx = toolContext(h, { runId: chat.id, kind: "helper", origin: "job", interactive: true });
  const fallback = await call(h.jobs.tools(jobCtx), "run_helper", { prompt: "Summarize later.", wait: true });
  assert.equal(fallback.scheduled, true);
  assert.match(fallback.note, /cannot wait/);
});

test("schedule_job, update_job, cancel_job, list_jobs, list_runs, and get_schedule cover the agent's own scheduling", async (t) => {
  const h = await started(jobsHarness(t, { presence: 1, settings: { intervalMinutes: 10, idleIntervalMinutes: 60 } }));
  const tools = h.jobs.tools(toolContext(h));

  const nightly = await call(tools, "schedule_job", { title: "Nightly digest", prompt: "Summarize today's sessions.", schedule: { cron: "0 22 * * *", tz: "UTC" } });
  assert.equal(nightly.schedule, "cron 0 22 * * * (UTC)");
  assert.equal(nightly.nextRunAt, "2023-11-15T22:00:00.000Z", "T0 is 22:13 UTC: tomorrow");
  const later = await call(tools, "schedule_job", { title: "Check back", prompt: "Look at acme/app#7 again.", schedule: { inMinutes: 90 } });
  assert.equal(later.nextRunAt, new Date(T0 + 90 * MIN).toISOString());
  const at = await call(tools, "schedule_job", { title: "At noon", prompt: "p", schedule: { at: "2023-11-15T12:00:00Z" }, report: false });
  assert.equal(at.schedule, "once at 2023-11-15T12:00:00.000Z");
  assert.equal((await h.jobs.getJob(at.id)).payload.report, false);
  const often = await call(tools, "schedule_job", { title: "Often", prompt: "p", schedule: { everyMinutes: 5, idleEveryMinutes: 30 } });
  assert.equal(often.schedule, "every 5 min (30 min idle)");
  assert.equal(often.nextRunAt, new Date(T0 + 5 * MIN).toISOString(), "a browser is present: the attended cadence");
  assert.match((await call(tools, "schedule_job", { title: "Bad", prompt: "p", schedule: { everyMinutes: 5, cron: "* * * * *" } })).error, /exactly one/);
  assert.match((await call(tools, "schedule_job", { title: "Bad", prompt: "p", schedule: { at: "tomorrow-ish" } })).error, /ISO 8601/);
  assert.equal((await call(tools, "schedule_job", { title: "Bad", prompt: "p", schedule: { everyMinutes: 0.5 } })).invalidInput, true);

  const listed = await call(tools, "list_jobs", {});
  assert.deepEqual(listed.jobs.map((job) => job.title), ["Check for changes", "Often", "Check back", "At noon", "Nightly digest"]);
  assert.deepEqual((await call(tools, "list_jobs", { kind: "tick" })).jobs.map((job) => job.id), ["tick"]);

  const moved = await call(tools, "update_job", { id: later.id, schedule: { inMinutes: 10 }, title: "Check back soon" });
  assert.equal(moved.title, "Check back soon");
  assert.equal(moved.nextRunAt, new Date(T0 + 10 * MIN).toISOString());
  const paused = await call(tools, "update_job", { id: often.id, status: "paused" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextRunAt, null);
  const resumed = await call(tools, "update_job", { id: often.id, status: "active" });
  assert.equal(resumed.nextRunAt, new Date(T0 + 5 * MIN).toISOString());
  const cancelled = await call(tools, "cancel_job", { id: nightly.id });
  assert.equal(cancelled.status, "cancelled");
  assert.match((await call(tools, "update_job", { id: nightly.id, status: "active" })).error, /cancelled; schedule a new one/);
  assert.match((await call(tools, "cancel_job", { id: "nope" })).error, /Unknown job/);
  const kinds = (await h.hub.activity.list({ kind: "job." })).map((entry) => entry.kind);
  assert.ok(kinds.includes("job.scheduled") && kinds.includes("job.updated") && kinds.includes("job.cancelled"));

  await h.runtime.runTick("manual");
  const runs = await call(tools, "list_runs", { kind: "tick" });
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].jobId, "tick");
  assert.equal(runs.runs[0].summary, "Nothing changed.");

  const schedule = await call(tools, "get_schedule", {});
  assert.equal(schedule.ready, true);
  assert.equal(schedule.presence, 1);
  assert.equal(schedule.tick.schedule, "every 10 min (1 h idle)");
  assert.equal(schedule.tick.followsSettings, true);
  assert.equal(schedule.upcoming[0].title, "Often");
  assert.deepEqual(schedule.running, []);
});

test("only the turns that should see them get the job tools", async (t) => {
  const h = await started(jobsHarness(t));
  const chat = Object.keys(h.jobs.tools(toolContext(h))).sort();
  assert.deepEqual(chat, [
    "cancel_intent", "cancel_job", "create_intent", "get_schedule", "list_intents", "list_jobs", "list_runs", "run_helper", "schedule_job", "update_intent", "update_job",
  ]);
  assert.deepEqual(h.jobs.tools(toolContext(h, { kind: "tick", origin: "job", interactive: false })), {}, "the tick pays for no job schemas");
  assert.deepEqual(h.jobs.tools(toolContext(h, { kind: "intent_check", origin: "job", interactive: false })), {}, "a check without an intent gets nothing");
  assert.deepEqual(h.jobs.tools(toolContext(h, { kind: "helper", origin: "job", interactive: false })), {});
});
