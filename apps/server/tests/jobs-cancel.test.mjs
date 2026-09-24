import assert from "node:assert/strict";
import test from "node:test";
import { JOB_CANCELLED } from "../src/orchestrator/turn.ts";
import { HELPER_TOOLS } from "../src/orchestrator/jobs/helpers.ts";
import { READ_ONLY_TOOLS } from "../src/orchestrator/tools/index.ts";
import { call, deferred, flush, jobsHarness, started, textStep, toolContext, toolStep } from "./fixtures/jobs-harness.mjs";
import { sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

/** A model call that never answers by itself: it waits until the run is aborted. */
const hang = ({ abortSignal }) => new Promise((_, reject) => {
  if (abortSignal?.aborted) reject(new Error("aborted"));
  abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});

async function runOf(h, jobId) {
  await flush();
  const run = h.jobs.running().find((entry) => entry.jobId === jobId);
  assert.ok(run, "the job's run is in progress");
  return run;
}

test("cancel_job stops the job's run in progress and says so; the run sends nothing", async (t) => {
  const h = await started(jobsHarness(t, { sessions: [sessionMeta({ id: "s1" })], doGenerate: hang }));
  const chat = await h.jobs.startRun({ kind: "chat", trigger: "user", threadId: "main" });
  const tools = h.jobs.tools(toolContext(h, { runId: chat.id }));
  const job = await call(tools, "schedule_job", { title: "Nudge", prompt: "Tell s1 to rebase.", schedule: { inMinutes: 0 }, tools: ["send_prompt"] });
  const run = await runOf(h, job.id);

  const cancelled = await call(tools, "cancel_job", { id: job.id });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.runStopped, true);
  assert.deepEqual(cancelled.stoppedRunIds, [run.id]);
  await flush();
  assert.equal((await h.jobs.getRun(run.id)).status, "cancelled");
  assert.equal((await h.jobs.getJob(job.id)).status, "cancelled", "the reschedule leaves the cancel standing");
  assert.deepEqual(h.state.prompts, []);

  // Nothing in progress: nothing to stop.
  const idle = await call(tools, "schedule_job", { title: "Later", prompt: "p", schedule: { inMinutes: 60 } });
  const plain = await call(tools, "cancel_job", { id: idle.id });
  assert.equal(plain.runStopped, false);
  assert.equal(plain.stoppedRunIds, undefined);
});

test("a run whose job was cancelled elsewhere checks before its next change, is refused, and stops", async (t) => {
  const gate = deferred();
  const h = await started(jobsHarness(t, {
    sessions: [sessionMeta({ id: "s1" })],
    doGenerate: async (options) => {
      if (h.model.doGenerateCalls.length === 1) {
        await gate.promise;
        return toolStep("send_prompt", { sessionId: "s1", text: "Rebase onto main." });
      }
      return options.abortSignal?.aborted ? hang(options) : textStep("Done.");
    },
  }));
  const tools = h.jobs.tools(toolContext(h));
  const job = await call(tools, "schedule_job", { title: "Nudge", prompt: "Tell s1 to rebase.", schedule: { inMinutes: 0 }, tools: ["send_prompt", "get_session"] });
  const run = await runOf(h, job.id);

  // Another Portal process cancels it: only the table changes, nothing here is aborted.
  await h.jobsStore.updateJob(job.id, { status: "cancelled" });
  gate.resolve();
  await flush(50);

  assert.deepEqual(h.state.prompts, [], "send_prompt did not run");
  const [refused] = (await h.hub.activity.list({ kind: "tool.call" })).filter((entry) => entry.refs.runId === run.id);
  assert.equal(refused.detail.tool, "send_prompt");
  assert.equal(refused.detail.error, JOB_CANCELLED);
  assert.equal((await h.jobs.getRun(run.id)).status, "cancelled");
  assert.equal((await h.jobs.getJob(job.id)).status, "cancelled");
});

test("cancel_intent stops a check of the intent in progress and says so", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: hang }));
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "create_intent", {
    text: "Tell me when s1 is done", trigger: "Session s1 is idle", action: "Tell the user", checkEveryMinutes: 10, checkNow: true,
  });
  const run = await runOf(h, created.checkJob.id);
  const cancelled = await call(tools, "cancel_intent", { id: created.id });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.runStopped, true);
  assert.deepEqual(cancelled.stoppedRunIds, [run.id]);
  await flush();
  assert.equal((await h.jobs.getRun(run.id)).status, "cancelled");
});

test("a check that closes its own intent is not stopped by that", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: async ({ prompt }) => (JSON.stringify(prompt).includes("tool-result") ? textStep("NO_UPDATE") : toolStep("close_intent", { status: "cancelled", reason: "It can never fire." })),
  }));
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "create_intent", { text: "Watch it", trigger: "Never", action: "Tell the user", checkNow: true });
  await flush(50);
  const [run] = await h.jobs.listRuns({ jobId: created.checkJob.id });
  assert.equal(run.status, "succeeded");
  assert.equal((await h.jobs.getIntent(created.id)).status, "cancelled");
});

test("every tool a helper may use by default only looks, so a cancelled job's helper can still read", () => {
  for (const name of HELPER_TOOLS) assert.ok(READ_ONLY_TOOLS.has(name), name);
  for (const name of ["send_prompt", "set_session_config", "stop_session", "cancel_turn", "create_item", "run_command"]) assert.ok(!READ_ONLY_TOOLS.has(name), name);
});
