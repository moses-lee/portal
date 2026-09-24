import assert from "node:assert/strict";
import test from "node:test";
import { CONSOLIDATE_JOB_ID, nightlySchedule } from "../src/orchestrator/jobs/consolidate-job.ts";
import { nextRunAt } from "../src/orchestrator/jobs/schedule.ts";
import { RECONFIRM_FINGERPRINT } from "../src/orchestrator/memory/consolidate.ts";
import { MAX_REMOVAL_SHARE, REMOVAL_FLOOR, mayReplace, resolvePlan } from "../src/orchestrator/memory/curation.ts";
import { newRecordId } from "../src/orchestrator/memory/store.ts";
import { T0, flush, jobsHarness, started, textStep, toolStep } from "./fixtures/jobs-harness.mjs";
import { memorySetup } from "./fixtures/memory-setup.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const scope = { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] };

/** A record as the store holds it; `authority` picks its trust. */
function record(entityId, key, body, overrides = {}) {
  const authority = overrides.authority ?? "observed";
  const trust = { user_stated: 1, user_confirmed: 0.9, observed: 0.6, inferred: 0.4 }[authority];
  return {
    id: newRecordId(), entityId, type: "convention", key, body, status: "active", scope, authority, trust, pinned: false, reviewBy: null,
    source: authority === "user_stated" ? { kind: "message", quote: body } : { kind: "session", sessionId: "s1", quote: body },
    supersedes: null, supersededBy: null, createdAt: T0 - DAY, updatedAt: T0 - DAY, ...overrides,
  };
}

async function insert(memory, records) {
  await memory.store.commit(records.map((entry) => ({ op: "insert", record: entry, revision: { actor: "system", action: "created" } })));
  return records;
}

/** A model that submits `plan()` (built once the records exist), then answers one sentence; every pass the same. */
function scripted(plan) {
  let calls = 0;
  return async () => (calls++ % 2 === 0 ? toolStep("submit_curation_plan", plan(), `plan-${calls}`) : textStep("Curated."));
}

/** Wait for a run to end. */
async function finished(h, id) {
  for (let i = 0; i < 20; i++) {
    const run = await h.jobs.getRun(id);
    if (run && run.status !== "running") return run;
    await flush();
  }
  throw new Error(`Run ${id} did not finish.`);
}

async function curateNow(h) {
  const run = await h.jobs.runNow(CONSOLIDATE_JOB_ID, "manual");
  assert.ok(run, "the curation job runs now");
  return finished(h, run.id);
}

test("a pass applies the plan: promotions, a supersession the authority rule allows, a rejection, expiry, re-confirm, and summaries", async (t) => {
  let ids = {};
  const h = jobsHarness(t, {
    doGenerate: scripted(() => ({
      decisions: [
        { recordId: ids.rebase.id, action: "supersede", reason: "Seen in three sessions this week." },
        { recordId: ids.docsFirst.id, action: "supersede", reason: "Seen once." },
        { recordId: ids.ci.id, action: "promote", reason: "Two sessions and a PR say so." },
        { recordId: ids.ciAgain.id, action: "reject", reason: "Repeats the CI claim." },
        { recordId: "m-unknown", action: "promote", reason: "Hallucinated." },
      ],
      summaries: [
        { entityId: ids.repo.id, summary: "PRs are rebased and merged; CI runs on every push; reviews start with tests." },
        { entityId: ids.person.id, summary: "Octocat prefers small PRs." },
      ],
      note: "One contradiction needs you.",
    })),
  });
  await started(h);
  const memory = h.hub.memory;
  const repo = await memory.store.ensureEntity({ type: "repo", key: "acme/app" });
  const person = await memory.store.ensureEntity({ type: "person", key: "octocat" });
  const [squash, testsFirst, stale, deploy] = await insert(memory, [
    record(repo.id, "merge-style", "PRs are squash-merged."),
    record(repo.id, "review-style", "Review tests first.", { authority: "user_stated" }),
    record(repo.id, "old-fact", "The staging box is called kiwi.", { reviewBy: T0 - MIN }),
    record(repo.id, "deploy", "Deploys go out on Tuesdays.", { authority: "user_stated", reviewBy: T0 - MIN }),
    ...["a", "b", "c", "d", "e", "f"].map((key) => record(person.id, `pref-${key}`, `Octocat likes ${key}.`, { authority: "user_stated" })),
  ]);
  const [rebase, docsFirst, ci, ciAgain] = await insert(memory, [
    record(repo.id, "merge-style", "PRs are rebased and merged.", { status: "proposed", supersedes: squash.id }),
    record(repo.id, "review-style", "Review docs first.", { status: "proposed", supersedes: testsFirst.id }),
    record(repo.id, "ci", "CI runs on every push.", { status: "proposed" }),
    record(repo.id, "ci-push", "CI runs on each push.", { status: "proposed", authority: "inferred" }),
  ]);
  ids = { repo, person, rebase, docsFirst, ci, ciAgain };
  await memory.core();

  const run = await curateNow(h);
  assert.equal(run.status, "succeeded", run.error ?? "");
  assert.equal(run.trigger, "manual");
  assert.deepEqual(run.model, { provider: "anthropic", model: "claude-opus-5-5" }, "the chat role curates");
  assert.deepEqual(h.model.doGenerateCalls[0].tools.map((tool) => tool.name).sort(), ["search_memory", "submit_curation_plan"]);
  assert.match(JSON.stringify(h.model.doGenerateCalls[0].prompt), /Inbox \(4\)/);

  const get = (entry) => memory.store.getRecord(entry.id);
  assert.equal((await get(squash)).status, "superseded");
  assert.equal((await get(squash)).supersededBy, rebase.id);
  const promoted = await get(rebase);
  assert.deepEqual([promoted.status, promoted.authority, promoted.pinned, promoted.supersedes], ["active", "observed", false, squash.id], "promotion keeps the authority");
  assert.equal((await get(ci)).status, "active");
  assert.equal((await get(ciAgain)).status, "rejected");
  assert.equal((await get(docsFirst)).status, "proposed", "the user's own claim is never replaced");
  assert.equal((await get(testsFirst)).status, "active");
  assert.equal((await get(stale)).status, "expired");
  assert.equal((await get(deploy)).status, "active", "the user's overdue claim is listed, not expired");

  const revisions = await memory.store.listRevisions({ limit: 50 });
  const byRecord = (id) => revisions.find((revision) => revision.recordId === id);
  for (const [entry, action] of [[rebase, "approved"], [squash, "superseded"], [ciAgain, "rejected"], [stale, "expired"]]) {
    assert.deepEqual([byRecord(entry.id).action, byRecord(entry.id).actor, byRecord(entry.id).runId], [action, "consolidator", run.id]);
  }
  assert.equal(byRecord(ciAgain.id).reason, "Repeats the CI claim.");
  const summaries = revisions.filter((revision) => revision.action === "summarized");
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every((revision) => revision.recordId === null && revision.actor === "consolidator"));
  assert.match((await memory.store.getEntity(repo.id)).summary, /rebased and merged/);

  const result = run.result;
  assert.deepEqual(result.counts, { promoted: 2, superseded: 1, rejected: 1, expired: 1, left: 1, reconfirm: 1, summarized: 2 });
  assert.equal(result.refused, null);
  assert.equal(result.note, "One contradiction needs you.");
  assert.deepEqual(result.considered, { inbox: 4, active: 10, overdue: 2, entities: 2 });
  const superseded = result.changes.find((change) => change.action === "superseded");
  assert.deepEqual([superseded.before.status, superseded.after.status, superseded.replacedBy, superseded.entity], ["active", "superseded", rebase.id, "repo acme/app"]);
  const left = result.changes.find((change) => change.action === "left");
  assert.equal(left.recordId, docsFirst.id);
  assert.match(left.reason, /the user's own claim \(user_stated\)/);
  assert.match(result.digest, /\*\*Left for you\*\*/);
  assert.match(result.digest, /\*\*Please re-confirm\*\*\n- repo acme\/app · `deploy`/);
  assert.match(result.digest, /> One contradiction needs you\./);
  assert.ok(run.log.some((line) => /m-unknown is not in the inbox/.test(line)));
  assert.equal(result.line, "Memory curation promoted 2, replaced 1, rejected 1, expired 1, rewrote 2 summaries; 1 claim of yours needs re-confirming; 1 left in the inbox.");
  assert.equal(run.summary, result.line);

  // The digest line in the main thread points at the run.
  const [message] = (await h.store.readMessages("main")).slice(-1);
  assert.equal(message.parts[0].text, result.line);
  assert.deepEqual(message.metadata.run, { id: run.id, kind: "consolidate" });
  assert.ok(h.events.some((event) => event.type === "messages" && event.threadId === "main"));

  // The user's overdue claim is a Needs-you item that links to the job.
  const item = await h.store.findItemByFingerprint(RECONFIRM_FINGERPRINT);
  assert.equal(item.kind, "memory_reconfirm");
  assert.match(item.body, /`deploy`: Deploys go out on Tuesdays\./);
  assert.equal(item.links.jobId, CONSOLIDATE_JOB_ID);

  // Activity, the memory event, and a fresh CORE.md.
  const kinds = (await h.hub.activity.list({ kind: "memory." })).map((entry) => entry.kind);
  for (const kind of ["memory.promoted", "memory.superseded", "memory.rejected", "memory.expired", "memory.summarized", "memory.consolidated"]) assert.ok(kinds.includes(kind), kind);
  const consolidated = (await h.hub.activity.list({ kind: "memory.consolidated" }))[0];
  assert.equal(consolidated.refs.runId, run.id);
  assert.ok(h.events.some((event) => event.type === "memory" && event.recordIds.includes(rebase.id)));
  assert.match((await memory.core()).text, /\bci\b/, "CORE.md is built again after curation");
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).failures, 0);
});

test("the guard refuses a plan that would take more than a quarter of the active records out of force: nothing is applied and the run fails with its digest", async (t) => {
  let proposals = [];
  const h = jobsHarness(t, {
    doGenerate: scripted(() => ({
      decisions: proposals.map((entry) => ({ recordId: entry.id, action: "supersede", reason: "Newer." })),
      summaries: [],
    })),
  });
  await started(h);
  const memory = h.hub.memory;
  const repo = await memory.store.ensureEntity({ type: "repo", key: "acme/app" });
  const active = await insert(memory, ["a", "b", "c", "d", "e"].map((key) => record(repo.id, key, `Claim ${key}.`)));
  proposals = await insert(memory, ["a", "b", "c", "d"].map((key) => record(repo.id, key, `Newer claim ${key}.`, { status: "proposed" })));

  const run = await curateNow(h);
  assert.equal(run.status, "failed");
  assert.match(run.error, /take 4 of 5 active records out of force \(80%\), more than the 25% limit; nothing was applied/);
  assert.equal(run.result.refused, run.error);
  assert.match(run.result.digest, /^\*\*Refused\.\*\*/);
  assert.match(run.result.digest, /\*\*Would have replaced\*\*/);
  assert.deepEqual(run.result.changes.filter((change) => change.action === "promoted").map((change) => change.after), [null, null, null, null]);
  for (const entry of proposals) assert.equal((await memory.store.getRecord(entry.id)).status, "proposed");
  for (const entry of active) assert.equal((await memory.store.getRecord(entry.id)).status, "active");
  assert.equal((await memory.store.listRevisions({ action: "superseded" })).length, 0);
  assert.equal((await h.hub.activity.list({ kind: "memory.consolidated" })).length, 0);
  // The model heard the refusal while it planned.
  assert.match(JSON.stringify(h.model.doGenerateCalls[1].prompt), /more than the 25% limit/);
  const [message] = (await h.store.readMessages("main")).slice(-1);
  assert.match(message.parts[0].text, /^Memory curation was refused: /);
  const job = await h.jobs.getJob(CONSOLIDATE_JOB_ID);
  assert.equal(job.status, "active", "a refusal never stops the job");
  assert.equal(job.failures, 1);
});

test("without an API key a run is skipped: nothing read, nothing posted, not counted against the job", async (t) => {
  const h = await started(jobsHarness(t, { key: null }));
  const repo = await h.hub.memory.store.ensureEntity({ type: "repo", key: "acme/app" });
  await insert(h.hub.memory, [record(repo.id, "a", "A.", { status: "proposed" })]);
  const run = await curateNow(h);
  assert.equal(run.status, "succeeded");
  assert.equal(run.result.skipped, true);
  assert.equal(run.summary, "No API key is stored; memory was not curated.");
  assert.equal(run.model, null);
  assert.equal(h.model.doGenerateCalls.length, 0);
  assert.deepEqual(await h.store.readMessages("main"), []);
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).failures, 0);
});

test("with nothing to curate no model is called; the re-confirm item is kept in place, resolved when cleared, and a dismissed list is not raised again", async (t) => {
  const h = await started(jobsHarness(t));
  const memory = h.hub.memory;
  const repo = await memory.store.ensureEntity({ type: "repo", key: "acme/app" });
  await memory.store.setEntitySummary(repo.id, "Deploys on Tuesdays.", { actor: "consolidator", action: "summarized" });
  const [deploy] = await insert(memory, [record(repo.id, "deploy", "Deploys go out on Tuesdays.", { authority: "user_stated", reviewBy: T0 - MIN })]);

  const first = await curateNow(h);
  assert.equal(first.status, "succeeded");
  assert.equal(h.model.doGenerateCalls.length, 0, "only the review dates needed checking");
  assert.equal(first.model, null);
  assert.equal(first.result.line, "Memory curation changed nothing; 1 claim of yours needs re-confirming.");
  const item = await h.store.findItemByFingerprint(RECONFIRM_FINGERPRINT);
  assert.equal(item.title, "Re-confirm a memory claim of yours");

  await curateNow(h);
  assert.equal((await h.store.listItems()).filter((entry) => entry.fingerprint === RECONFIRM_FINGERPRINT).length, 1, "updated in place, not duplicated");

  await h.store.updateItem(item.id, { status: "dismissed" });
  await curateNow(h);
  assert.equal(await h.store.findItemByFingerprint(RECONFIRM_FINGERPRINT), null, "the list the user dismissed stays dismissed");

  await h.store.updateItem(item.id, { status: "open" });
  await memory.edit(deploy.id, { reviewBy: null }, { actor: "user" });
  const cleared = await curateNow(h);
  assert.equal((await h.store.getItem(item.id)).status, "resolved");
  assert.equal(cleared.result.line, "Memory curation changed nothing.");
  assert.equal((await h.store.readMessages("main")).length, 3, "a pass that changed nothing and needs nobody posts nothing");
});

test("the nightly run follows the settings in the server's time zone; off leaves the job unscheduled but runnable; changes resync it", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: scripted(() => ({ decisions: [], summaries: [] })), settings: { consolidation: { nightlyAt: "04:30", inboxThreshold: 10, minIntervalMinutes: 60 } } }));
  const planned = (at) => nextRunAt(nightlySchedule(at), { now: h.timers.now(), lastRunAt: null, present: false });
  let job = await h.jobs.getJob(CONSOLIDATE_JOB_ID);
  assert.deepEqual([job.kind, job.title, job.createdBy, job.status], ["consolidate", "Curate memory", "system", "active"]);
  assert.deepEqual(job.schedule, { type: "cron", expr: "30 4 * * *", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  assert.equal(job.nextRunAt, planned("04:30"));

  await h.settings.change({ consolidation: { nightlyAt: "02:05", inboxThreshold: 10, minIntervalMinutes: 60 } });
  await flush();
  job = await h.jobs.getJob(CONSOLIDATE_JOB_ID);
  assert.equal(job.schedule.expr, "5 2 * * *");
  assert.equal(job.nextRunAt, planned("02:05"));
  assert.match((await h.hub.activity.list({ kind: "job.updated" }))[0].summary, /Memory curation follows the new settings \(cron 5 2 \* \* \*/);

  await h.settings.change({ consolidation: { nightlyAt: null, inboxThreshold: 10, minIntervalMinutes: 60 } });
  await flush();
  job = await h.jobs.getJob(CONSOLIDATE_JOB_ID);
  assert.deepEqual([job.status, job.nextRunAt], ["active", null]);
  assert.equal((await h.hub.activity.list({ kind: "job.updated" }))[0].summary, "Nightly memory curation is off");
  const manual = await curateNow(h);
  assert.equal(manual.status, "succeeded");
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt, null, "Run now does not bring the nightly run back");

  await h.settings.change({ consolidation: { nightlyAt: "03:00", inboxThreshold: 10, minIntervalMinutes: 60 } });
  await flush();
  const next = (await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt;
  assert.equal(next, planned("03:00"));

  // At the nightly time the worker runs it on schedule, and plans the next night.
  await h.timers.advance(next - h.timers.now() + 1);
  await flush();
  const [nightly] = await h.jobs.listRuns({ jobId: CONSOLIDATE_JOB_ID, limit: 1 });
  assert.equal(nightly.trigger, "schedule");
  assert.equal(nightly.log[0], "Nightly run.");
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt, next + DAY);
});

test("the inbox trigger starts a run once the inbox reaches the threshold, and at most once per interval", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: scripted(() => ({ decisions: [], summaries: [] })),
    settings: { consolidation: { nightlyAt: null, inboxThreshold: 3, minIntervalMinutes: 60 } },
  }));
  const memory = h.hub.memory;
  const propose = (n) => memory.propose({ entity: { type: "repo", key: "acme/app" }, type: "fact", key: `fact-${n}`, body: `Fact number ${n}.`, authority: "observed", source: { kind: "session", sessionId: "s1", quote: `fact ${n}` } }, { actor: "agent" });
  const runs = () => h.jobs.listRuns({ jobId: CONSOLIDATE_JOB_ID });

  await propose(1);
  await propose(2);
  await flush();
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt, null);
  assert.equal((await runs()).length, 0);

  await propose(3);
  await flush();
  let done = await runs();
  assert.equal(done.length, 1);
  await finished(h, done[0].id);
  done = await runs();
  assert.equal(done[0].log[0], "Started because the inbox held 3 proposals.");
  assert.equal(done[0].trigger, "schedule");
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt, null, "back to unscheduled: the nightly run is off");

  // Within the interval: the next run waits for it.
  h.timers.tick(10 * MIN);
  await propose(4);
  await flush();
  assert.equal((await runs()).length, 1);
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt, done[0].startedAt + 60 * MIN);
  assert.match((await h.hub.activity.list({ kind: "job.updated" }))[0].summary, /inbox holds 4 proposals: curation runs at /);
  await propose(5);
  await flush();
  assert.equal((await h.jobs.getJob(CONSOLIDATE_JOB_ID)).nextRunAt, done[0].startedAt + 60 * MIN, "debounced, not pushed back");

  await h.timers.advance(50 * MIN);
  await flush();
  done = await runs();
  assert.equal(done.length, 2);
  await finished(h, done[0].id);

  // Off: the inbox no longer starts runs.
  await h.settings.change({ consolidation: { nightlyAt: null, inboxThreshold: null, minIntervalMinutes: 60 } });
  await h.timers.advance(2 * 60 * MIN);
  await propose(6);
  await flush();
  assert.equal((await runs()).length, 2);
});

test("rejecting every proposal of a small memory is not a removal: the pass applies", async (t) => {
  let proposals = [];
  const h = jobsHarness(t, {
    doGenerate: scripted(() => ({
      decisions: proposals.map((entry) => ({ recordId: entry.id, action: "reject", reason: "Noise." })),
      summaries: [],
    })),
  });
  await started(h);
  const memory = h.hub.memory;
  const repo = await memory.store.ensureEntity({ type: "repo", key: "acme/app" });
  proposals = await insert(memory, ["a", "b", "c", "d"].map((key) => record(repo.id, key, `Claim ${key}.`, { status: "proposed" })));
  await insert(memory, [record(repo.id, "kept", "Kept.", { authority: "user_stated" })]);
  const run = await curateNow(h);
  assert.equal(run.status, "succeeded");
  assert.equal(run.result.refused, null);
  assert.equal(run.result.counts.rejected, 4);
  for (const entry of proposals) assert.equal((await memory.store.getRecord(entry.id)).status, "rejected");
  assert.equal(run.result.considered.active, 1);
});

test("resolvePlan: the authority rule, one promotion per key, and the removal guard with its floor", () => {
  assert.equal(mayReplace("observed", "observed"), true);
  assert.equal(mayReplace("observed", "inferred"), true);
  assert.equal(mayReplace("inferred", "observed"), false, "a weaker claim never replaces a stronger one");
  assert.equal(mayReplace("observed", "user_confirmed"), false);
  assert.equal(mayReplace("observed", "user_stated"), false);

  const entity = { id: "e1", type: "repo", key: "acme/app", name: "acme/app", summary: "Old.", activeRecords: 0, createdAt: T0, updatedAt: T0 };
  const active = [record("e1", "k", "Old claim.", { authority: "observed" }), ...["a", "b", "c", "d", "e"].map((key) => record("e1", key, key, { authority: "user_stated" }))];
  const inbox = [record("e1", "k", "New claim.", { status: "proposed" }), record("e1", "k", "Another new claim.", { status: "proposed" })];
  const snapshot = { now: T0, entities: [entity], inbox, active };
  const resolved = resolvePlan(snapshot, {
    decisions: [
      { recordId: inbox[0].id, action: "promote", reason: "r" },
      { recordId: inbox[1].id, action: "supersede", reason: "r" },
      { recordId: inbox[0].id, action: "reject", reason: "twice" },
    ],
    summaries: [{ entityId: "e1", summary: "  New.  " }, { entityId: "e-none", summary: "x" }],
  });
  assert.deepEqual(resolved.promote.map((entry) => [entry.record.id, entry.replaces?.id]), [[inbox[0].id, active[0].id]]);
  assert.deepEqual(resolved.left.map((entry) => entry.record.id), [inbox[1].id]);
  assert.equal(resolved.issues.length, 3);
  assert.deepEqual(resolved.summaries.map((entry) => entry.after), ["New."]);
  // 1 of 6 active records replaced: allowed.
  assert.equal(resolved.refused, null);
  assert.deepEqual([resolved.removals, resolved.base], [1, 6]);
  assert.equal(resolved.removals / resolved.base <= MAX_REMOVAL_SHARE, true);

  // The guard counts only active records taken out of force: rejecting every proposal removes nothing.
  const rejectAll = (n) => {
    const proposals = Array.from({ length: n }, (_, i) => record("e1", `p${i}`, `P${i}`, { status: "proposed" }));
    return resolvePlan({ now: T0, entities: [entity], inbox: proposals, active: active.slice(0, 1) }, {
      decisions: proposals.map((p) => ({ recordId: p.id, action: "reject", reason: "r" })), summaries: [],
    });
  };
  assert.deepEqual([rejectAll(6).refused, rejectAll(6).removals, rejectAll(6).base], [null, 0, 1]);

  // Supersessions do count, against the active records, with a floor: a small memory may still lose a few.
  const replaceAll = (activeCount, replaced) => {
    const holders = Array.from({ length: activeCount }, (_, i) => record("e1", `k${i}`, `Old ${i}`));
    const newer = holders.slice(0, replaced).map((h) => record("e1", h.key, `New ${h.key}`, { status: "proposed" }));
    return resolvePlan({ now: T0, entities: [entity], inbox: newer, active: holders }, {
      decisions: newer.map((p) => ({ recordId: p.id, action: "supersede", reason: "r" })), summaries: [],
    });
  };
  assert.equal(replaceAll(3, 3).refused, null, `${REMOVAL_FLOOR} removals are always allowed, even all of a small memory`);
  assert.match(replaceAll(4, 4).refused, /take 4 of 4 active records out of force \(100%\)/);
  assert.match(replaceAll(13, 4).refused, /take 4 of 13 active records out of force \(31%\)/);
  assert.equal(replaceAll(16, 4).refused, null, "4 of 16 is exactly 25%");
  assert.match(replaceAll(16, 5).refused, /5 of 16/);
});

test("postgres: a resolved plan is written in one commit with its summaries and revisions", async (t) => {
  const database = await temporaryDatabase(t);
  const { memory, events } = await memorySetup(t, { database });
  const repo = await memory.store.ensureEntity({ type: "repo", key: "acme/app" });
  const [old] = await insert(memory, [
    record(repo.id, "merge-style", "PRs are squash-merged."),
    ...["a", "b", "c"].map((key) => record(repo.id, key, key, { authority: "user_stated" })),
  ]);
  const [proposal] = await insert(memory, [record(repo.id, "merge-style", "PRs are rebased.", { status: "proposed" })]);
  const resolved = resolvePlan(await memory.curationSnapshot(), {
    decisions: [{ recordId: proposal.id, action: "supersede", reason: "Seen twice." }],
    summaries: [{ entityId: repo.id, summary: "PRs are rebased." }],
  });
  assert.equal(resolved.refused, null);
  const { written, entities } = await memory.applyCuration(resolved, { runId: "run-pg" });
  assert.deepEqual([written.get(old.id).status, written.get(proposal.id).status, written.get(proposal.id).supersedes], ["superseded", "active", old.id]);
  assert.equal(entities[0].summary, "PRs are rebased.");
  assert.equal((await memory.store.getEntity(repo.id)).summary, "PRs are rebased.");
  const revisions = await memory.store.listRevisions({ limit: 10 });
  assert.deepEqual(revisions.slice(0, 3).map((revision) => [revision.action, revision.actor, revision.runId]), [
    ["summarized", "consolidator", "run-pg"], ["approved", "consolidator", "run-pg"], ["superseded", "consolidator", "run-pg"],
  ]);
  assert.ok(events.some((event) => event.type === "memory" && event.recordIds.includes(proposal.id)));
});
