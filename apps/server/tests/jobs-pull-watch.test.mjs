import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MONITOR_CHECK_MS, describeSnapshot, pullChanges, pullWatchOf } from "../src/orchestrator/jobs/pull-watch.ts";
import { POLL_MS } from "../src/orchestrator/jobs/worker.ts";
import { attentionPull } from "./fixtures/orchestrator-fakes.mjs";
import { T0, call, flush, jobsHarness, started, toolContext } from "./fixtures/jobs-harness.mjs";

const MIN = 60_000;

/** A PR's status as `pullStatus` answers it: open, checks passing, review pending, mergeable. */
function status(overrides = {}) {
  return {
    repo: "acme/app", number: 42, url: "https://github.com/acme/app/pull/42", title: "Add billing", author: "someone", state: "open", draft: false,
    baseBranch: "main", headBranch: "feat/billing", checks: "passing", reviewDecision: "review_required", mergeable: "mergeable", updatedAt: T0,
    headSha: "abc", reviews: 0, comments: 0, lastReview: null, ...overrides,
  };
}

const snap = (overrides) => {
  const { repo: _r, number: _n, url: _u, title: _t, author: _a, baseBranch: _b, headBranch: _h, updatedAt: _at, ...rest } = status(overrides);
  return rest;
};

test("pullChanges names each state change once, and a new review counts even when the decision stays", () => {
  const events = (before, after) => pullChanges(snap(before), snap(after)).map((change) => change.event);
  assert.deepEqual(events({}, {}), []);
  assert.deepEqual(events({}, { state: "merged" }), ["merged"]);
  assert.deepEqual(events({}, { state: "closed" }), ["closed"]);
  assert.deepEqual(events({}, { checks: "failing" }), ["checks_failing"]);
  assert.deepEqual(events({ checks: "failing" }, { checks: "passing" }), ["checks_passing"]);
  assert.deepEqual(events({ checks: "pending" }, { checks: "passing" }), [], "pending to passing is not news");
  assert.deepEqual(events({}, { mergeable: "conflicting" }), ["conflicts"]);
  assert.deepEqual(events({ mergeable: "conflicting" }, { mergeable: "mergeable" }), ["conflicts"]);
  assert.deepEqual(events({ mergeable: "unknown" }, { mergeable: "mergeable" }), []);
  const review = (state, at, author = "ana") => ({ lastReview: { author, state, at }, reviews: at });
  assert.deepEqual(events({}, { reviewDecision: "changes_requested", ...review("changes_requested", 1) }), ["changes_requested"]);
  assert.deepEqual(events({ reviewDecision: "approved", ...review("approved", 1) }, { reviewDecision: "approved", ...review("approved", 2, "bo") }), ["approved"]);
  assert.deepEqual(events({}, { ...review("commented", 1) }), ["comments"]);
  assert.deepEqual(events({}, { comments: 3 }), ["comments"]);
  const text = pullChanges(snap({}), snap({ reviewDecision: "approved", ...review("approved", 5, "ana") }))[0].text;
  assert.equal(text, "it was approved by ana");
  assert.equal(describeSnapshot(snap({ checks: "failing", mergeable: "conflicting" })), "open, checks failing, review pending, conflicting");
  assert.equal(describeSnapshot(snap({ state: "merged" })), "merged");
});

test("monitor_pull watches a PR: the first check is the baseline, then only chosen changes fire, and a merge ends it", async (t) => {
  let current = status();
  const h = await started(jobsHarness(t, { github: { pullStatus: async (repo, number) => ({ ...current, repo, number }) } }));
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "monitor_pull", { repo: "acme/app", number: 42, text: "monitor #42 until it merges" });
  assert.equal(created.error, undefined, created.error);
  assert.deepEqual(created.events, ["merged", "closed", "checks_failing", "checks_passing", "changes_requested", "approved", "conflicts"]);
  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.fireBudget, null, "a monitor fires on every change");
  assert.deepEqual(intent.scope.pulls, [{ repo: "acme/app", number: 42, url: "https://github.com/acme/app/pull/42" }]);
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.deepEqual(job.schedule, { type: "every", everyMs: DEFAULT_MONITOR_CHECK_MS });

  const check = async (next) => {
    if (next) current = { ...current, ...next };
    await h.timers.advance(next ? DEFAULT_MONITOR_CHECK_MS : POLL_MS);
    await flush();
    return (await h.jobs.listRuns({ jobId: job.id }))[0];
  };
  const goalItems = async () => (await h.store.listItems()).filter((item) => item.kind === "intent_update");

  let run = await check();
  assert.match(run.summary, /watching from here \(open, checks passing, review pending\)/);
  assert.deepEqual(await goalItems(), []);
  assert.equal(pullWatchOf((await h.jobs.getJob(job.id)).payload).last.checks, "passing");

  run = await check({ checks: "failing" });
  assert.equal(run.summary, "acme/app#42: checks are failing");
  let [item] = await goalItems();
  assert.equal(item.title, "acme/app#42 checks are failing");
  assert.match(item.body, /^\*\*Add billing\*\*\n- Checks are failing\n\nNow: open, checks failing, review pending\./);
  assert.deepEqual(item.links.pull, intent.scope.pulls[0]);
  assert.equal((await h.store.readMessages()).at(-1).parts[0].text, "acme/app#42 checks are failing.");
  assert.equal(h.model.doGenerateCalls.length, 0, "no model is involved");

  run = await check({ comments: 4 });
  assert.match(run.summary, /no change/, "comments are not reported unless asked for");
  assert.deepEqual(run.result.ignored, ["comments"]);

  run = await check({ checks: "passing", reviewDecision: "approved", lastReview: { author: "ana", state: "approved", at: T0 + 1 }, reviews: 1 });
  assert.equal(run.summary, "acme/app#42: checks pass again; it was approved by ana");
  [item] = await goalItems();
  assert.equal(item.title, "acme/app#42 checks pass again; it was approved by ana", "one item per monitor, updated in place");
  assert.equal((await h.jobs.getIntent(intent.id)).fires, 2);

  run = await check({ state: "merged" });
  assert.equal(run.summary, "acme/app#42 was merged; the monitor is done.");
  assert.equal((await h.jobs.getIntent(intent.id)).status, "done");
  assert.equal((await h.jobs.getJob(job.id)).status, "done");
  assert.equal((await goalItems())[0].title, "acme/app#42 was merged");
  const closed = await h.hub.activity.list({ kind: "intent.closed" });
  assert.match(closed[0].summary, /acme\/app#42 was merged/);
});

test("asking again updates the monitor, comments can be asked for, and cancel_intent stops it by PR number", async (t) => {
  let current = status();
  const h = await started(jobsHarness(t, { github: { pullStatus: async () => current } }));
  const tools = h.jobs.tools(toolContext(h));
  const first = await call(tools, "monitor_pull", { repo: "acme/app", number: 42 });
  const again = await call(tools, "monitor_pull", { repo: "acme/app", number: 42, comments: true, checkEveryMinutes: 2 });
  assert.equal(again.updated, true);
  assert.equal(again.id, first.id);
  assert.ok(again.events.includes("comments"));
  assert.equal((await h.jobs.listIntents({ status: ["active"] })).length, 1);
  const [job] = await h.jobs.listJobs({ intentId: first.id });
  assert.deepEqual(job.schedule, { type: "every", everyMs: 2 * MIN });
  // The update replans the check two minutes out; that one sets the baseline, the next sees the comment.
  await h.timers.advance(2 * MIN);
  await flush();
  assert.deepEqual(await h.store.listItems(), []);
  current = { ...current, comments: 1 };
  await h.timers.advance(2 * MIN);
  await flush();
  assert.equal((await h.store.listItems())[0].title, "acme/app#42 1 comment new");

  assert.match((await call(tools, "cancel_intent", { pull: 7 })).error, /No active monitor watches PR #7/);
  const cancelled = await call(tools, "cancel_intent", { pull: 42, reason: "user asked" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await h.jobs.getJob(job.id)).status, "cancelled");
});

test("monitor_pull resolves a bare number through the world, and a PR that is already merged is reported once and done", async (t) => {
  const h = await started(jobsHarness(t, {
    pulls: [attentionPull({ number: 42 })],
    github: { pullStatus: async () => status({ state: "merged" }) },
  }));
  await h.hub.world.refresh("tick");
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "monitor_pull", { number: 42 });
  assert.equal(created.error, undefined, created.error);
  assert.equal(created.pull.repo, "acme/app");
  await h.timers.advance(POLL_MS);
  await flush();
  assert.equal((await h.jobs.getIntent(created.id)).status, "done");
  assert.equal((await h.store.listItems())[0].title, "acme/app#42 was merged");
  assert.match((await call(tools, "monitor_pull", { number: 99 })).reason, /no GitHub repos to look in/);
});
