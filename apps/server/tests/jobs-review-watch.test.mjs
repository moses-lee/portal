import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_CHECK_MS, findingsItem, reviewWatchOf, sessionProgress } from "../src/orchestrator/jobs/review-watch.ts";
import { POLL_MS } from "../src/orchestrator/jobs/worker.ts";
import { fakeDeps, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { T0, flush, jobsHarness, started, textStep, toolStep } from "./fixtures/jobs-harness.mjs";

const url = (n) => `https://github.com/acme/app/pull/${n}`;
const reviewSessions = [
  { pr: 1, url: url(1), sessionId: "s1", projectId: "p2", title: "Add login", author: "someone" },
  { pr: 2, url: url(2), sessionId: "s2", projectId: "p3", title: "Fix logout", author: "other" },
];

/** A session's events: the review prompt, the agent's answer, and (unless `open`) the end of its turn. */
function transcript(answer, { open = false, stopReason = "end_turn" } = {}) {
  let seq = 0;
  const events = [
    { seq: seq++, ts: T0, type: "user", text: "Review this PR" },
    { seq: seq++, ts: T0, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } },
  ];
  if (!open) events.push({ seq: seq++, ts: T0, type: "turn_end", stopReason });
  return events;
}

async function reviewGoal(h, overrides = {}) {
  return h.jobs.createIntent({
    text: "Review PRs 1, 2 on acme/app", trigger: "Every review session has finished its turn.", action: "Summarize the findings.",
    scope: { sessionIds: ["s1", "s2"], pulls: reviewSessions.map((entry) => ({ repo: "acme/app", number: entry.pr, url: entry.url })), repos: ["acme/app"] },
    fireBudget: 1, check: { type: "every", everyMs: REVIEW_CHECK_MS }, checkNow: true,
    checkPayload: { review: { repo: "acme/app", sessions: reviewSessions, memoryIds: ["m1"] } }, ...overrides,
  }, { actor: "agent", threadId: "main" });
}

test("sessionProgress reads a finished turn, a working or waiting session, and the ways a review can end without finishing", async () => {
  const sessions = [
    sessionMeta({ id: "done" }), sessionMeta({ id: "busy", busy: true }), sessionMeta({ id: "perm", awaitingPermission: true }),
    sessionMeta({ id: "cut" }), sessionMeta({ id: "empty" }), sessionMeta({ id: "lost", link: { status: "offline", error: "crashed" } }), sessionMeta({ id: "stopped" }),
  ];
  const { deps } = fakeDeps({
    sessions, events: { done: transcript("ok"), cut: transcript("half", { open: true }), stopped: transcript("partial", { stopReason: "cancelled" }) },
  });
  const states = {};
  for (const id of ["done", "busy", "perm", "cut", "empty", "lost", "stopped", "missing"]) states[id] = await sessionProgress(deps, id);
  assert.deepEqual(states.done, { state: "finished" });
  assert.equal(states.busy.state, "working");
  assert.equal(states.perm.state, "waiting");
  assert.deepEqual(states.cut, { state: "failed", note: "the turn stopped without finishing" });
  assert.equal(states.empty.state, "failed");
  assert.deepEqual(states.lost, { state: "failed", note: "the agent was lost: crashed" });
  assert.deepEqual(states.stopped, { state: "finished", note: "the turn ended: cancelled" });
  assert.equal(states.missing.state, "gone");
});

test("a review goal waits without a model call, then summarizes the reviews into one findings item per PR and finishes", async (t) => {
  const sessions = [sessionMeta({ id: "s1", busy: true, projectId: "p2" }), sessionMeta({ id: "s2", projectId: "p3" })];
  const events = { s1: [], s2: transcript("Looks fine. Nit: rename `x`.") };
  const h = await started(jobsHarness(t, {
    sessions, events,
    doGenerate: [
      toolStep("report_review", {
        pr: 1, verdict: "request_changes", summary: "The token is never refreshed.",
        findings: [
          { severity: "blocking", title: "Token never refreshed", where: "src/auth.ts:42", detail: "Sessions expire after an hour." },
          { severity: "nit", title: "Typo in a comment" },
        ],
      }, "c1"),
      toolStep("report_review", { pr: 2, verdict: "approve", summary: "Small, correct change.", findings: [{ severity: "nit", title: "Rename x" }] }, "c2"),
      toolStep("report_review", { pr: 9, verdict: "approve", summary: "Not ours.", findings: [] }, "c3"),
      textStep("One PR needs changes, the other is ready."),
    ],
  }));
  const { intent, job } = await reviewGoal(h);
  await h.timers.advance(POLL_MS);
  await flush();
  let [run] = await h.jobs.listRuns({ jobId: job.id });
  assert.equal(run.status, "succeeded");
  assert.match(run.summary, /Waiting for 1 of 2 review session/);
  assert.equal(run.model, null, "the wait costs no model call");
  assert.equal(h.model.doGenerateCalls.length, 0);
  assert.equal((await h.jobs.getIntent(intent.id)).status, "active");

  // The first review finishes; the next check summarizes both.
  sessions[0].busy = false;
  events.s1.push(...transcript("BLOCKING: the token is never refreshed (src/auth.ts:42)."));
  await h.timers.advance(REVIEW_CHECK_MS);
  await flush();

  assert.equal(h.model.doGenerateCalls.length, 4);
  const prompt = JSON.stringify(h.model.doGenerateCalls[0].prompt);
  assert.match(prompt, /PR acme\/app#1 \\"Add login\\" by someone/);
  assert.match(prompt, /the token is never refreshed/);
  assert.match(prompt, /Rename `x`|rename `x`/);
  const offered = h.model.doGenerateCalls[0].tools.map((tool) => tool.name).sort();
  assert.deepEqual(offered, ["get_pull", "get_session", "read_transcript", "report_review"]);

  const items = (await h.store.listItems()).filter((item) => item.kind === "review_findings");
  assert.equal(items.length, 2);
  const first = items.find((item) => item.links.pull.number === 1);
  assert.equal(first.title, "Review of acme/app#1: needs changes (1 blocking, 1 nit)");
  assert.match(first.body, /^The token is never refreshed\.\n\n\*\*Blocking\*\*\n- Token never refreshed \(`src\/auth.ts:42`\): Sessions expire after an hour\./);
  assert.match(first.body, /_Brief written from memory: m1_/);
  assert.deepEqual(first.links, { pull: { repo: "acme/app", number: 1, url: url(1) }, sessionId: "s1", projectId: "p2", intentId: intent.id, threadId: "main" });
  assert.deepEqual(first.actions, [{ type: "open_url", url: url(1), label: "Open PR" }, { type: "open_session", sessionId: "s1", label: "Open review" }]);
  assert.equal(items.find((item) => item.links.pull.number === 2).title, "Review of acme/app#2: looks good (1 nit)");
  assert.equal((await h.store.listItems()).filter((item) => item.kind === "intent_update").length, 0, "no generic goal item beside the findings");

  assert.equal((await h.jobs.getIntent(intent.id)).status, "done");
  const [finalJob] = await h.jobs.listJobs({ intentId: intent.id });
  assert.equal(finalJob.status, "done");
  [run] = await h.jobs.listRuns({ jobId: job.id, kind: "intent_check" });
  assert.match(run.summary, /^Reviews finished on acme\/app: #1 needs changes \(1 blocking, 1 nit\); #2 looks good \(1 nit\)/);
  const [helper] = await h.jobs.listRuns({ kind: "helper" });
  assert.equal(helper.parentRunId, run.id, "the summarizer is a child run of the check");
  assert.deepEqual(helper.model, { provider: "anthropic", model: "claude-opus-5-5" }, "summaries use the chat model");
  const note = (await h.store.readMessages()).at(-1);
  assert.match(note.parts[0].text, /^Reviews finished on acme\/app/);
  assert.deepEqual(note.metadata.itemIds.sort(), items.map((item) => item.id).sort());
});

test("a review that ended without a report still gets an item saying so, and a deleted session counts as ended", async (t) => {
  const sessions = [sessionMeta({ id: "s1", projectId: "p2" })];
  const h = await started(jobsHarness(t, {
    sessions, events: { s1: transcript("half done", { open: true }) },
    doGenerate: [textStep("Neither review finished.")],
  }));
  const { intent } = await reviewGoal(h);
  await h.timers.advance(POLL_MS);
  await flush();
  const items = (await h.store.listItems()).filter((item) => item.kind === "review_findings");
  assert.deepEqual(items.map((item) => item.title).sort(), ["Review of acme/app#1: review incomplete", "Review of acme/app#2: review incomplete"]);
  assert.match(items.find((item) => item.links.pull.number === 1).body, /did not finish: the turn stopped without finishing/);
  assert.match(items.find((item) => item.links.pull.number === 2).body, /did not finish: the session was deleted/);
  assert.equal((await h.jobs.getIntent(intent.id)).status, "done");
});

test("without a key the summary waits for the next check instead of failing the goal", async (t) => {
  const h = await started(jobsHarness(t, { key: null, sessions: [sessionMeta({ id: "s1" }), sessionMeta({ id: "s2" })], events: { s1: transcript("a"), s2: transcript("b") } }));
  const { intent, job } = await reviewGoal(h);
  await h.timers.advance(POLL_MS);
  await flush();
  const [run] = await h.jobs.listRuns({ jobId: job.id });
  assert.match(run.summary, /No API key/);
  assert.equal((await h.jobs.getIntent(intent.id)).status, "active");
  assert.equal((await h.jobs.getJob(job.id)).failures, 0);
});

test("reviewWatchOf keeps only well-formed sessions, and findingsItem caps the body", () => {
  assert.equal(reviewWatchOf({}), null);
  assert.equal(reviewWatchOf({ review: { repo: "acme/app", sessions: [{ pr: "1" }] } }), null);
  assert.deepEqual(reviewWatchOf({ review: { repo: "acme/app", sessions: [reviewSessions[0], { nope: true }], memoryIds: ["m1", 3] } }), {
    repo: "acme/app", sessions: [reviewSessions[0]], memoryIds: ["m1"],
  });
  const many = Array.from({ length: 30 }, (_, i) => ({ severity: "should_fix", title: `Finding ${i}`, detail: "x".repeat(500) }));
  const item = findingsItem({ pr: 1, verdict: "comment", summary: "Lots.", findings: many }, reviewSessions[0], "acme/app");
  assert.ok(item.body.length <= 4000);
  assert.equal(item.fingerprint, "review_findings:acme/app#1:s1");
});

test("a review waiting for a permission raises the tick's waiting item at once and resolves it when the session moves on", async (t) => {
  const sessions = [sessionMeta({ id: "s1", awaitingPermission: true, busy: true }), sessionMeta({ id: "s2", busy: true })];
  const h = await started(jobsHarness(t, { sessions, events: { s1: [], s2: [] } }));
  const { job } = await reviewGoal(h);
  await h.timers.advance(POLL_MS);
  await flush();
  let [item] = (await h.store.listItems()).filter((entry) => entry.kind === "session_waiting");
  assert.equal(item.fingerprint, "session_waiting:s1", "the tick's fingerprint, so the tick updates rather than duplicates it");
  assert.equal(item.title, "The review of acme/app#1 is waiting for your permission");
  assert.deepEqual(item.actions, [{ type: "open_session", sessionId: "s1", label: "Answer" }]);
  assert.match((await h.jobs.listRuns({ jobId: job.id }))[0].summary, /1 waiting for a permission/);

  // Another check while it still waits adds nothing.
  await h.timers.advance(REVIEW_CHECK_MS);
  await flush();
  assert.equal((await h.store.listItems()).filter((entry) => entry.kind === "session_waiting").length, 1);

  sessions[0].awaitingPermission = false;
  await h.timers.advance(REVIEW_CHECK_MS);
  await flush();
  [item] = (await h.store.listItems()).filter((entry) => entry.kind === "session_waiting");
  assert.equal(item.status, "resolved");
});
