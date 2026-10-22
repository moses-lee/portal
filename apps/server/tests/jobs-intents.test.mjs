import assert from "node:assert/strict";
import test from "node:test";
import { POLL_MS } from "../src/orchestrator/jobs/worker.ts";
import { createPgJobsStore } from "../src/orchestrator/jobs/pg-store.ts";
import { DEFAULT_LIFETIME_MS, MAX_LIFETIME_MS, firingTitle, isQuiet } from "../src/orchestrator/jobs/intents.ts";
import { CATCH_UP_MS, sessionEventsOf } from "../src/orchestrator/jobs/watch-events.ts";
import { T0, call, flush, jobsHarness, started, textStep, toolContext, toolStep, toolsStep } from "./fixtures/jobs-harness.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";
import { liveness, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const pull = { repo: "acme/app", number: 42, url: "https://github.com/acme/app/pull/42" };

const intentArgs = (overrides = {}) => ({
  text: "tell me when the status page clears", trigger: "status.example.com shows the incident resolved", action: "Tell me",
  scope: { pulls: [pull] }, checkEveryMinutes: 2, ...overrides,
});

async function withIntent(h, overrides) {
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "create_watch", intentArgs(overrides));
  assert.equal(created.error, undefined, created.error);
  return { tools, created };
}

/** A session's events: a prompt, the agent's answer, and the end of its turn. */
function transcript(answer, { stopReason = "end_turn" } = {}) {
  let seq = 0;
  return [
    { seq: seq++, ts: T0, type: "user", text: "Rebase onto main" },
    { seq: seq++, ts: T0, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } },
    { seq: seq++, ts: T0, type: "turn_end", stopReason },
  ];
}

/** A settled session whose last turn ended at `turnEndedAt`. */
const settled = (overrides = {}) => sessionMeta({ busy: false, turnEndedAt: T0 - 5 * MIN, queue: [], liveness: liveness("idle"), ...overrides });

async function settle(ms = 0) {
  for (let i = 0; i < 5; i++) await flush();
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// The pure parts
// ---------------------------------------------------------------------------------------------

test("a session's state shows one event with a stable key: a stall, then a permission wait, then a settled turn end", () => {
  assert.deepEqual(sessionEventsOf(settled({ id: "s1", turnEndedAt: T0 }), T0 + 1).map((event) => event.key), [`s1:turn:${T0}`]);
  assert.deepEqual(sessionEventsOf(settled({ id: "s1", busy: true }), T0), [], "a turn in progress is no event");
  assert.deepEqual(sessionEventsOf(settled({ id: "s1", queue: [{ id: "q" }] }), T0), [], "a queued prompt starts the next turn at once");
  assert.deepEqual(sessionEventsOf(sessionMeta({ id: "s1", busy: false }), T0), [], "no turn has ended yet");
  const waiting = sessionEventsOf(settled({ id: "s1", awaitingPermission: true, lastActiveAt: T0 - 9 }), T0);
  assert.deepEqual(waiting.map((event) => [event.kind, event.key]), [["permission", `s1:permission:${T0 - 9}`]]);
  const lost = sessionEventsOf(settled({ id: "s1", liveness: liveness("dead", "dead: Portal restarted", { lost: { reason: "portal_restarted", detail: "x", at: T0 - 3 } }) }), T0);
  assert.deepEqual(lost.map((event) => [event.kind, event.key]), [["stalled", `s1:stalled:dead:${T0 - 3}`]]);
  const hung = sessionEventsOf(settled({ id: "s1", busy: true, liveness: liveness("hung", "hung", { turnStartedAt: T0 - 50 }) }), T0);
  assert.deepEqual(hung.map((event) => event.key), [`s1:stalled:hung:${T0 - 50}`]);
});

test("a run's reply is quiet when empty, [quiet] first, or the old NO_UPDATE; a firing's title is its first sentence", () => {
  for (const text of ["", "  ", "[quiet] nothing new", "[QUIET]", "NO_UPDATE"]) assert.equal(isQuiet(text), true, text);
  for (const text of ["The session finished.", "No update was needed, but the PR merged."]) assert.equal(isQuiet(text), false, text);
  assert.equal(firingTitle("The #3313 session finished its rebase. It pushed 6c23c1e and CI runs."), "The #3313 session finished its rebase.");
  assert.equal(firingTitle("\n- PR #42 merged\nmore"), "PR #42 merged");
});

// ---------------------------------------------------------------------------------------------
// Poll watches: a condition only a model can check, on the job's schedule
// ---------------------------------------------------------------------------------------------

test("create_watch without sessions makes a poll watch at the agent's cadence that expires in a week unless asked otherwise", async (t) => {
  const h = await started(jobsHarness(t));
  const { created } = await withIntent(h, { idleCheckEveryMinutes: 15 });
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(
    { source: intent.source, status: intent.status, fireBudget: intent.fireBudget, cooldownMs: intent.cooldownMs, expiresAt: intent.expiresAt },
    { source: { type: "poll" }, status: "active", fireBudget: null, cooldownMs: 0, expiresAt: T0 + DEFAULT_LIFETIME_MS },
  );
  assert.equal(created.wakes, "checked on a schedule");
  assert.equal(created.expiresAt, new Date(T0 + DEFAULT_LIFETIME_MS).toISOString(), "the answer says when it expires");
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.deepEqual(job.schedule, { type: "every", everyMs: 2 * MIN, idleEveryMs: 15 * MIN });
  assert.equal(job.nextRunAt, T0 + 15 * MIN, "nobody is present: the idle cadence");
  const [logged] = await h.hub.activity.list({ kind: "intent.created" });
  assert.match(logged.summary, /checked every 2 min/);
  assert.deepEqual(h.events.findLast((event) => event.type === "intents").intents.map((entry) => entry.id), [intent.id]);

  const tools = h.jobs.tools(toolContext(h));
  const once = await call(tools, "create_watch", intentArgs({ once: true, expiresInHours: 2 }));
  assert.equal(once.once, true);
  assert.equal((await h.jobs.getIntent(once.id)).fireBudget, 1);
  assert.equal(once.expiresAt, new Date(T0 + 2 * HOUR).toISOString());
  assert.equal((await call(tools, "create_watch", intentArgs({ expiresInHours: 5000 }))).invalidInput, true, "at most thirty days");
  assert.match((await call(tools, "create_watch", intentArgs({ checkEveryMinutes: undefined, checkCron: "not a cron" }))).error, /Invalid cron/);
  for (const gone of ["fireBudget", "cooldownMinutes", "role", "expiresAt"]) assert.ok(!(gone in tools.create_watch.inputSchema.shape), gone);
});

test("a poll watch's run is a full agent turn on the watch model; its reply fires: a Needs-you item and a note in the chat", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: [
      toolStep("run_command", { command: "curl -s https://status.example.com/api/v2/status.json", cwd: "/repo" }, "c1"),
      textStep("The status page shows the incident resolved at 14:02. Codex should work again."),
    ],
  }));
  const { created } = await withIntent(h, { checkNow: true, once: true });
  await h.timers.advance(POLL_MS);
  await settle();

  const calls = h.model.doGenerateCalls;
  const offered = calls[0].tools.map((tool) => tool.name);
  for (const name of ["run_command", "read_transcript", "get_pull", "send_prompt", "create_session", "update_watch", "end_watch", "renew_watch"]) assert.ok(offered.includes(name), name);
  for (const name of ["create_watch", "monitor_pull", "schedule_job", "run_helper", "fire_watch", "close_watch", "use_tools"]) assert.ok(!offered.includes(name), name);
  const system = calls[0].prompt[0].content;
  assert.match(system, /This turn is a watch's run/);
  assert.doesNotMatch(system, /Background work is yours to schedule/);
  assert.match(JSON.stringify(calls[0].prompt), /Nothing woke this run but its schedule/);

  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual({ fires: intent.fires, status: intent.status }, { fires: 1, status: "done" }, "once: the first firing ends it");
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  const [run] = await h.jobs.listRuns({ jobId: job.id });
  assert.deepEqual(run.model, { provider: "anthropic", model: "claude-sonnet-5-5" }, "runs use the watch role's model");
  assert.match(run.summary, /^Fired: The status page shows the incident resolved at 14:02\./);
  const [item] = await h.store.listItems();
  assert.deepEqual(
    { kind: item.kind, title: item.title, fingerprint: item.fingerprint, links: item.links },
    { kind: "intent_update", title: "The status page shows the incident resolved at 14:02.", fingerprint: `intent_update:${intent.id}`, links: { intentId: intent.id, pull } },
  );
  const [note] = (await h.runtime.history()).messages;
  assert.equal(note.parts[0].text, "The status page shows the incident resolved at 14:02. Codex should work again.");
  assert.deepEqual(note.metadata.run, { id: run.id, kind: "intent_check" });
  assert.deepEqual(note.metadata.itemIds, [item.id]);
});

test("a quiet reply fires nothing and posts nothing; the watch stays on its schedule", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: [toolStep("update_watch", { notes: "Still degraded at 14:00." }), textStep("[quiet] Still degraded; nothing changed.")],
  }));
  const { created } = await withIntent(h, { checkNow: true });
  await settle();
  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.notes, "Still degraded at 14:00.");
  assert.equal(intent.fires, 0);
  assert.equal(intent.lastCheckedAt, T0);
  assert.deepEqual((await h.runtime.history()).messages, []);
  assert.deepEqual(await h.store.listItems(), []);
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.equal(job.nextRunAt, T0 + 2 * MIN);
  assert.equal((await h.jobs.getRun(job.lastRunId)).summary, "Quiet: Still degraded; nothing changed.");
});

test("a poll watch's reply that repeats the last firing's title is refused; a changed one fires", async (t) => {
  const replies = ["The page shows a new incident: API errors.", "The page shows a new incident: API errors!", "The incident is resolved."];
  const h = await started(jobsHarness(t, { doGenerate: async () => textStep(replies.shift()) }));
  const { created } = await withIntent(h, { checkNow: true });
  await settle();
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  await h.timers.advance(2 * MIN);
  await settle();
  assert.match((await h.jobs.getRun((await h.jobs.getJob(job.id)).lastRunId)).summary, /^Not fired: this repeats the last firing/);
  assert.equal((await h.jobs.getIntent(created.id)).fires, 1, "a refused repeat spends nothing");
  await h.timers.advance(2 * MIN);
  await settle();
  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.fires, 2);
  assert.equal(intent.lastFiredTitle, "The incident is resolved.");
  assert.equal((await h.runtime.history()).messages.length, 2);
});

test("end_watch ends only a poll watch, and only with evidence; renew_watch extends once within a day of expiry", async (t) => {
  const h = await started(jobsHarness(t));
  const { created } = await withIntent(h, { expiresInHours: 30 });
  const run = h.jobs.tools(toolContext(h, { kind: "intent_check", intentId: created.id, runId: "run-check" }));
  assert.deepEqual(Object.keys(run).sort(), ["end_watch", "list_watches", "renew_watch", "update_watch"]);
  assert.match((await call(run, "renew_watch", { hours: 24, reason: "still waiting" })).error, /does not expire within a day/);
  h.timers.tick(7 * HOUR);
  const renewed = await call(run, "renew_watch", { hours: 48, reason: "The incident is still open." });
  assert.equal(renewed.expiresAt, new Date(T0 + 7 * HOUR + 48 * HOUR).toISOString());
  h.timers.tick(30 * HOUR);
  assert.match((await call(run, "renew_watch", { hours: 24, reason: "again" })).error, /renewed once already/);
  assert.equal((await call(run, "end_watch", { status: "done", reason: "Resolved.", evidence: "" })).invalidInput, true);
  assert.deepEqual(await call(run, "end_watch", { status: "done", reason: "Resolved.", evidence: "status.json says resolved at 14:02" }), { closed: "done" });
  const [closed] = await h.hub.activity.list({ kind: "intent.closed" });
  assert.match(closed.summary, /evidence: status\.json says resolved at 14:02/);
});

test("a run that ends its watch and reports in one go is still heard: the reply fires first, then the watch ends", async (t) => {
  const h = await started(jobsHarness(t, {
    doGenerate: async ({ prompt }) => (JSON.stringify(prompt).includes("tool-result")
      ? textStep("GitHub's status indicator says none: all systems operational.")
      : toolStep("end_watch", { status: "done", reason: "Read and reported.", evidence: "status.json: indicator none" })),
  }));
  const { created } = await withIntent(h, { checkNow: true, once: true });
  await settle();
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual({ status: intent.status, fires: intent.fires }, { status: "done", fires: 1 });
  assert.equal((await h.runtime.history()).messages[0]?.parts[0].text, "GitHub's status indicator says none: all systems operational.");
  assert.equal((await h.store.listItems()).length, 1);
  const closed = await h.hub.activity.list({ kind: "intent.closed" });
  assert.equal(closed.length, 1, "closed once, by the firing that spent its budget or the ending, whichever came first");
});

test("the server enforces the fire budget and cooldown of older watches, whatever the run replies", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: async () => textStep(`Firing at ${new Date(h.timers.now()).toISOString()}.`) }));
  const { created } = await withIntent(h, { checkNow: true });
  await h.jobsStore.updateIntent(created.id, { fireBudget: 2, cooldownMs: 30 * MIN });
  await settle();
  assert.equal((await h.jobs.getIntent(created.id)).fires, 1);
  await h.timers.advance(2 * MIN);
  await settle();
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  assert.match((await h.jobs.getRun((await h.jobs.getJob(job.id)).lastRunId)).summary, /^Not fired: the watch is cooling down/);
  await h.timers.advance(30 * MIN);
  await settle();
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual({ fires: intent.fires, status: intent.status }, { fires: 2, status: "done" });
  assert.equal((await h.store.listItems()).length, 1, "one item per watch, updated on each firing");
});

test("a run that rewrites its notes beside other calls in one step keeps the notes and still fires (Postgres)", async (t) => {
  const { db } = await temporaryDatabase(t);
  const calls = [];
  // The store reads the harness's clock, as the service's own store would; on the real clock every job looks overdue.
  let now = () => T0;
  const h = await started(jobsHarness(t, {
    store: createPgJobsStore({ db, now: () => now() }),
    doGenerate: async ({ prompt }) => {
      calls.push(JSON.stringify(prompt).includes("tool-result") ? "after-tools" : "first");
      return calls.at(-1) === "first"
        ? toolsStep(["update_watch", { notes: "Resolved at 14:02. Reported." }], ["list_watches", {}])
        : textStep("The incident is resolved.");
    },
  }));
  now = () => h.timers.now();
  const { created } = await withIntent(h, { checkNow: true });
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  let run;
  for (let tries = 0; tries < 200; tries++) {
    await flush();
    [run] = await h.jobs.listRuns({ jobId: job.id });
    if (run && run.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(run.status, "succeeded", `${run.error} (model calls: ${calls.join(", ")})`);
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual({ notes: intent.notes, fires: intent.fires, lastFiredTitle: intent.lastFiredTitle }, { notes: "Resolved at 14:02. Reported.", fires: 1, lastFiredTitle: "The incident is resolved." });
  assert.equal((await h.runtime.history()).messages[0]?.parts[0].text, "The incident is resolved.");
  assert.deepEqual(calls, ["first", "after-tools"], "one run, two model steps");
});

// ---------------------------------------------------------------------------------------------
// Session watches: Portal sees the events; the model runs only when one happens
// ---------------------------------------------------------------------------------------------

test("a session watch runs only when its session finishes a turn, reads what the agent said, and fires on it", async (t) => {
  const h = await started(jobsHarness(t, {
    sessions: [settled({ id: "s1", title: "Rebase #3313" })],
    events: { s1: transcript("Rebased onto main and resolved 6 conflicts; pushed 6c23c1e.") },
    doGenerate: async () => textStep("The #3313 session finished its rebase: 6 conflicts resolved, pushed 6c23c1e."),
  }));
  const tools = h.jobs.tools(toolContext(h));
  const created = await call(tools, "create_watch", { text: "tell me when it finishes", trigger: "s1 finishes a turn", action: "Tell me what it did", sessions: ["s1"] });
  assert.equal(created.error, undefined, created.error);
  assert.equal(created.wakes, "on events of its session");
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(intent.source, { type: "session", sessionIds: ["s1"], on: ["turn_end", "permission", "stalled"] });
  assert.deepEqual(intent.events.handled, [`s1:turn:${T0 - 5 * MIN}`], "the turn that ended before the watch is not news");
  const [job] = await h.jobs.listJobs({ intentId: intent.id });
  assert.equal(job.nextRunAt, null, "no schedule: it waits for an event");

  await h.timers.advance(CATCH_UP_MS);
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 0, "nothing happened, so no model ran");

  h.timers.tick(MIN);
  h.state.patchSession("s1", { busy: true });
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 0, "a turn in progress is no event");
  h.state.patchSession("s1", { busy: false, turnEndedAt: h.timers.now() });
  await settle();

  assert.equal(h.model.doGenerateCalls.length, 1);
  const prompt = JSON.stringify(h.model.doGenerateCalls[0].prompt);
  assert.match(prompt, /What woke this run \(Portal saw it happen\)/);
  assert.match(prompt, /Session s1 \\"Rebase #3313\\" \(Claude Code\) finished a turn/);
  assert.match(prompt, /Rebased onto main and resolved 6 conflicts; pushed 6c23c1e\./);
  const after = await h.jobs.getIntent(intent.id);
  assert.equal(after.fires, 1);
  assert.deepEqual(after.events.pending, []);
  const [item] = await h.store.listItems();
  assert.deepEqual(item.links, { intentId: intent.id, sessionId: "s1" });
  assert.deepEqual(item.actions, [{ type: "open_session", sessionId: "s1", label: "Open session" }]);
  assert.equal((await h.runtime.history()).messages.length, 1);
  assert.equal((await h.jobs.getJob(job.id)).nextRunAt, null, "back to waiting");

  // The same state reported again (a title change, the catch-up pass) is no new event.
  h.state.patchSession("s1", { title: "Rebase #3313 (done)" });
  await h.timers.advance(CATCH_UP_MS);
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 1);
});

test("an event the user watched happen is recorded as seen, not reported; one after they looked away is reported with it noted", async (t) => {
  const h = await started(jobsHarness(t, {
    sessions: [settled({ id: "s1" })], events: { s1: transcript("Done.") },
    doGenerate: async () => textStep("The session finished another turn."),
  }));
  const created = await call(h.jobs.tools(toolContext(h)), "create_watch", { text: "watch s1", trigger: "s1 turns", action: "Tell me", sessions: ["s1"] });
  h.presence.setWatching(["s1"]);
  h.timers.tick(MIN);
  h.state.patchSession("s1", { turnEndedAt: h.timers.now() });
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 0);
  const seen = (await h.jobs.getIntent(created.id)).events;
  assert.deepEqual(seen.seen.map((event) => event.key), [`s1:turn:${T0 + MIN}`]);
  assert.ok(seen.handled.includes(`s1:turn:${T0 + MIN}`));

  h.presence.setWatching([]);
  h.timers.tick(MIN);
  h.state.patchSession("s1", { turnEndedAt: h.timers.now() });
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 1);
  assert.match(JSON.stringify(h.model.doGenerateCalls[0].prompt), /The user watched these happen live/);
});

test("a permission wait and a stall wake a session watch too; a failed run puts its events back for the retry", async (t) => {
  let fail = true;
  const h = await started(jobsHarness(t, {
    sessions: [settled({ id: "s1" })],
    doGenerate: async () => {
      if (fail) throw new Error("overloaded");
      return textStep("The session waits on a permission to run bazel.");
    },
  }));
  const created = await call(h.jobs.tools(toolContext(h)), "create_watch", { text: "watch s1", trigger: "s1 needs me", action: "Tell me", sessions: ["s1"], on: ["permission", "stalled"] });
  h.timers.tick(MIN);
  h.state.patchSession("s1", { turnEndedAt: h.timers.now() });
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 0, "turn ends are not asked for");

  h.state.patchSession("s1", { awaitingPermission: true, lastActiveAt: T0 + MIN });
  await settle(20);
  assert.ok(h.model.doGenerateCalls.length >= 1);
  const pending = (await h.jobs.getIntent(created.id)).events.pending;
  assert.deepEqual(pending.map((event) => event.key), [`s1:permission:${T0 + MIN}`], "the event waits for the retry");
  fail = false;
  await h.timers.advance(10 * MIN);
  await settle(20);
  const intent = await h.jobs.getIntent(created.id);
  assert.equal(intent.fires, 1);
  assert.deepEqual(intent.events.pending, []);
});

test("a session watch whose session is deleted is done", async (t) => {
  const h = await started(jobsHarness(t, { sessions: [settled({ id: "s1" }), settled({ id: "s2" })] }));
  const tools = h.jobs.tools(toolContext(h));
  const one = await call(tools, "create_watch", { text: "watch s1", trigger: "t", action: "a", sessions: ["s1"] });
  const two = await call(tools, "create_watch", { text: "watch both", trigger: "t", action: "a", sessions: ["s1", "s2"] });
  h.state.sessions = h.state.sessions.filter((session) => session.id !== "s1");
  h.state.change("s1", "deleted");
  await settle();
  assert.equal((await h.jobs.getIntent(one.id)).status, "done");
  const [closed] = await h.hub.activity.list({ kind: "intent.closed" });
  assert.match(closed.summary, /its session was removed/);
  const both = await h.jobs.getIntent(two.id);
  assert.equal(both.status, "active");
  assert.deepEqual(both.source.sessionIds, ["s2"]);
});

test("events missed while nobody listened are caught up at start and on the catch-up pass", async (t) => {
  const h = await started(jobsHarness(t, { sessions: [settled({ id: "s1" })], doGenerate: async () => textStep("It finished.") }));
  const created = await call(h.jobs.tools(toolContext(h)), "create_watch", { text: "watch s1", trigger: "t", action: "a", sessions: ["s1"] });
  // Changed without telling anyone (a dropped listener, a restart in between).
  h.state.sessions = [settled({ id: "s1", turnEndedAt: T0 + 1 })];
  await h.timers.advance(CATCH_UP_MS);
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 1);
  assert.equal((await h.jobs.getIntent(created.id)).fires, 1);
});

// ---------------------------------------------------------------------------------------------
// The standing rule: every session Portal starts
// ---------------------------------------------------------------------------------------------

test("the first session Portal starts makes the standing rule; each one after joins it; turned off, none does", async (t) => {
  const h = await started(jobsHarness(t, { projects: [project()], doGenerate: async () => textStep("The new session finished its first turn.") }));
  await h.jobs.sessionStarted("s1");
  const [rule] = await h.jobs.listIntents({ status: ["active"] });
  assert.deepEqual({ text: rule.text, source: rule.source, expiresAt: rule.expiresAt, fireBudget: rule.fireBudget }, {
    text: "Report on every session Portal starts", source: { type: "portal_sessions", sessionIds: ["s1"], on: ["turn_end", "permission", "stalled"] }, expiresAt: null, fireBudget: null,
  });
  h.state.sessions.push(settled({ id: "s2", turnEndedAt: null }));
  await h.jobs.sessionStarted("s2");
  await h.jobs.sessionStarted("s2");
  assert.deepEqual((await h.jobs.getIntent(rule.id)).source.sessionIds, ["s1", "s2"]);

  h.timers.tick(MIN);
  h.state.patchSession("s2", { turnEndedAt: h.timers.now() });
  await settle();
  const [item] = await h.store.listItems();
  assert.equal(item.fingerprint, `intent_update:${rule.id}:s2`, "the rule keeps one item per session");
  assert.equal(item.links.sessionId, "s2");

  await h.jobs.updateIntent(rule.id, { status: "cancelled" }, "user");
  await h.jobs.sessionStarted("s3");
  assert.equal((await h.jobs.listIntents({})).length, 1, "a rule the user turned off is not made again");
  assert.deepEqual((await h.jobs.getIntent(rule.id)).source.sessionIds, ["s1", "s2"]);
  const back = await h.jobs.updateIntent(rule.id, { status: "active" }, "user");
  assert.equal(back.expiresAt, null, "the rule never expires");
});

test("a session with a watch of its own is reported there, and the standing rule stays out", async (t) => {
  const h = await started(jobsHarness(t, { sessions: [settled({ id: "s1" })], doGenerate: async () => textStep("The session found the bug in auth.ts.") }));
  await h.jobs.sessionStarted("s1");
  const own = await call(h.jobs.tools(toolContext(h)), "create_watch", { text: "tell me when s1 finishes", trigger: "s1 finishes", action: "Tell me", sessions: ["s1"], once: true });
  h.timers.tick(MIN);
  h.state.patchSession("s1", { turnEndedAt: h.timers.now() });
  await settle();
  assert.equal(h.model.doGenerateCalls.length, 1, "one run, not two");
  assert.equal((await h.jobs.getIntent(own.id)).fires, 1);
  const rule = (await h.jobs.listIntents({ status: ["active"] })).find((intent) => intent.source.type === "portal_sessions");
  assert.equal(rule.fires, 0);
  assert.deepEqual(rule.events.pending, []);
});

test("at start, older watches move onto sources: per-session 'always watch' ones hand over to the rule, others become session watches", async (t) => {
  const h = jobsHarness(t, { sessions: [settled({ id: "s1" }), settled({ id: "s2" }), settled({ id: "s3" })] });
  const old = (text, sessionIds, extra = {}) => h.jobsStore.createIntent({ text, trigger: "t", action: "a", scope: { sessionIds }, fireBudget: 1, ...extra });
  const always = await old("Always watch every session Portal starts and report when it finishes a turn.", ["s1"]);
  const always2 = await old("Always watch every session Portal starts and report when each finishes a turn.", ["s2"]);
  const review = await old("Watch the #3533 review session and report when it finishes", ["s3"], { expiresAt: T0 + MAX_LIFETIME_MS * 2 });
  const site = await old("watch the status page", []);
  for (const intent of [always, always2, review, site]) {
    await h.jobsStore.createJob({ kind: "intent_check", title: "Check", schedule: { type: "every", everyMs: 5 * MIN }, payload: { intentId: intent.id }, nextRunAt: T0 + 5 * MIN, intentId: intent.id, createdBy: "agent" });
  }
  await started(h);
  await settle();
  assert.equal((await h.jobs.getIntent(always.id)).status, "done");
  assert.equal((await h.jobs.getIntent(always2.id)).status, "done");
  const rule = (await h.jobs.listIntents({ status: ["active"] })).find((intent) => intent.source.type === "portal_sessions");
  assert.deepEqual([...rule.source.sessionIds].sort(), ["s1", "s2"]);
  const converted = await h.jobs.getIntent(review.id);
  assert.deepEqual({ source: converted.source, fireBudget: converted.fireBudget, expiresAt: converted.expiresAt }, {
    source: { type: "session", sessionIds: ["s3"], on: ["turn_end", "permission", "stalled"] }, fireBudget: null, expiresAt: T0 + MAX_LIFETIME_MS,
  });
  assert.deepEqual(converted.events.handled, [`s3:turn:${T0 - 5 * MIN}`]);
  const [convertedJob] = await h.jobs.listJobs({ intentId: review.id });
  assert.equal(convertedJob.nextRunAt, null);
  const poll = await h.jobs.getIntent(site.id);
  assert.deepEqual({ source: poll.source, expiresAt: poll.expiresAt }, { source: { type: "poll" }, expiresAt: T0 + DEFAULT_LIFETIME_MS });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

test("a watch past its expiry is expired by the worker, leaves an item saying so, and re-activates for another week", async (t) => {
  const h = await started(jobsHarness(t));
  const { created } = await withIntent(h, { expiresInHours: 1, checkEveryMinutes: 120 });
  await h.timers.advance(HOUR + POLL_MS);
  await settle();
  const expired = await h.jobs.getIntent(created.id);
  assert.equal(expired.status, "expired");
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  assert.equal(job.status, "done");
  const item = (await h.store.listItems()).find((entry) => entry.fingerprint === `intent_expired:${created.id}`);
  assert.match(item.title, /^Watch expired: tell me when the status page clears/);
  assert.match(item.body, /Re-activate it in Watches/);
  const back = await h.jobs.updateIntent(created.id, { status: "active" }, "user");
  assert.equal(back.expiresAt, h.timers.now() + DEFAULT_LIFETIME_MS);
});

test("three failed runs in a row stop a watch's job and raise an item saying so", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: async () => { throw new Error("model unavailable"); } }));
  const { created } = await withIntent(h, { checkNow: true });
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  for (let i = 0; i < 6 && (await h.jobs.getJob(job.id)).status === "active"; i++) {
    await h.timers.advance(60 * MIN);
    await settle();
  }
  assert.equal((await h.jobs.getJob(job.id)).status, "failed");
  const item = (await h.store.listItems()).find((entry) => entry.fingerprint === `intent_failing:${created.id}`);
  assert.ok(item, "an item says the watch stopped");
  assert.match(item.body, /model unavailable/);
  assert.equal(item.actions[0].type, "ask_portal");
});

test("update_watch rewrites the watch and its expiry and reschedules a poll check; cancel_watch and cancelling the check job both end it", async (t) => {
  const h = await started(jobsHarness(t, { presence: 1 }));
  const { tools, created } = await withIntent(h);
  const updated = await call(tools, "update_watch", { id: created.id, trigger: "the page shows resolved", checkEveryMinutes: 30, scope: { repos: ["acme/app"] }, expiresInHours: 48 });
  assert.equal(updated.trigger, "the page shows resolved");
  assert.equal(updated.expiresAt, new Date(T0 + 48 * HOUR).toISOString());
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(intent.scope.pulls, [pull], "a partial scope merges with the stored one");
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  assert.deepEqual(job.schedule, { type: "every", everyMs: 30 * MIN });
  assert.match((await h.hub.activity.list({ kind: "intent.updated" }))[0].summary, /trigger, scope, expiresAt, cadence/);

  const cancelled = await call(tools, "cancel_watch", { id: created.id, reason: "Not needed." });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await h.jobs.getJob(job.id)).status, "cancelled");
  assert.match((await call(tools, "update_watch", { id: created.id, notes: "x" })).error, /cancelled; create a new one/);

  const { created: second } = await withIntent(h);
  const [secondJob] = await h.jobs.listJobs({ intentId: second.id });
  assert.equal((await call(tools, "cancel_job", { id: secondJob.id })).status, "cancelled");
  assert.equal((await h.jobs.getIntent(second.id)).status, "cancelled", "a watch without its check is cancelled with it");
  const back = await h.jobs.updateIntent(second.id, { status: "active" }, "user");
  assert.equal(back.status, "active");
  const live = await h.jobs.listJobs({ intentId: second.id, status: ["active"] });
  assert.equal(live.length, 1);
  assert.deepEqual(live[0].schedule, { type: "every", everyMs: 2 * MIN });
});

test("a check job whose watch is gone or closed ends itself without calling the model", async (t) => {
  const h = await started(jobsHarness(t, { doGenerate: [textStep("should not run")] }));
  const { created } = await withIntent(h);
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  await h.jobsStore.updateIntent(created.id, { status: "done" });
  await h.timers.advance(2 * MIN);
  await flush();
  assert.equal(h.model.doGenerateCalls.length, 0);
  assert.equal((await h.jobs.getJob(job.id)).status, "done");
  assert.equal((await h.jobs.getRun((await h.jobs.getJob(job.id)).lastRunId)).summary, "The watch is done.");
});

// The World section shows 8-char prefixes; a real intent was once stored with one and every check read the session as deleted.
const REVIEW = "17329ac6-0c1e-4c4f-9a57-3d2b1f0e9a01";
const PORTAL = "9b1d4e7a-5c6d-4e7f-8a9b-000000000001";
const prefixWorld = {
  projects: [project({ id: PORTAL, name: "portal" })],
  sessions: [
    sessionMeta({ id: REVIEW, projectId: PORTAL, title: "Review auth" }),
    sessionMeta({ id: "5e0f1b2c-0000-4000-8000-000000000002", title: "First" }), sessionMeta({ id: "5e0f9d8e-0000-4000-8000-000000000003", title: "Second" }),
  ],
};

test("create_watch and update_watch store full session and project ids, and refuse ids that name nothing or several", async (t) => {
  const h = await started(jobsHarness(t, prefixWorld));
  const { tools, created } = await withIntent(h, { scope: { projectIds: ["9b1d4e7a"] }, sessions: ["17329ac6"] });
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(intent.scope.sessionIds, [REVIEW]);
  assert.deepEqual(intent.source.sessionIds, [REVIEW]);
  assert.deepEqual(intent.scope.projectIds, [PORTAL]);

  assert.match((await call(tools, "create_watch", intentArgs({ sessions: ["deadbeef"] }))).error, /No session has id "deadbeef"\. Ids in the World section are prefixes/);
  assert.match((await call(tools, "create_watch", intentArgs({ scope: { sessionIds: ["5e0f"] } }))).error, /^scope\.sessionIds: Id "5e0f" is ambiguous: 2 sessions/);
  assert.match((await call(tools, "create_watch", intentArgs({ scope: { projectIds: ["nope-project"] } }))).error, /^scope\.projectIds: No project has id "nope-project"/);
  assert.equal((await h.jobs.listIntents({})).length, 1, "the refused ones stored nothing");

  await h.jobsStore.updateIntent(created.id, { scope: { ...intent.scope, sessionIds: [REVIEW, "gone0000"] } });
  const updated = await call(tools, "update_watch", { id: created.id, scope: { projectIds: ["9b1d4e7a"] } });
  assert.equal(updated.error, undefined, updated.error);
  assert.deepEqual((await h.jobs.getIntent(created.id)).scope.sessionIds, [REVIEW, "gone0000"]);
});

test("a run repairs a scope stored with prefixes, and its item's links, once; a firing links the full id", async (t) => {
  const h = await started(jobsHarness(t, { ...prefixWorld, doGenerate: async () => textStep("The review finished.") }));
  const { created } = await withIntent(h, { scope: { sessionIds: [REVIEW] } });
  await h.jobsStore.updateIntent(created.id, { scope: { ...(await h.jobs.getIntent(created.id)).scope, pulls: [], sessionIds: ["17329ac6"], projectIds: ["9b1d4e7a", "gone0000"] } });
  const old = await h.store.createItem({
    kind: "intent_update", title: "Earlier", body: "x", fingerprint: `intent_update:${created.id}`,
    links: { intentId: created.id, sessionId: "17329ac6" }, actions: [{ type: "open_session", sessionId: "17329ac6", label: "Open session" }],
  });
  const [job] = await h.jobs.listJobs({ intentId: created.id });
  await h.jobs.runNow(job.id, "manual");
  await settle();
  const intent = await h.jobs.getIntent(created.id);
  assert.deepEqual(intent.scope.sessionIds, [REVIEW]);
  assert.deepEqual(intent.scope.projectIds, [PORTAL, "gone0000"], "what names nothing is left as it is");
  const item = await h.store.getItem(old.id);
  assert.deepEqual(item.links, { intentId: created.id, sessionId: REVIEW });
  assert.deepEqual(item.actions, [{ type: "open_session", sessionId: REVIEW, label: "Open session" }]);
  assert.match(JSON.stringify(h.model.doGenerateCalls[0].prompt), /Review auth\W+\[17329ac6\] in portal/, "the run's World shows the session in focus");
});
