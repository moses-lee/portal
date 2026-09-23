import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_WAIT_MS, EXPIRY_MS, createApprovalsService } from "../src/orchestrator/approvals/service.ts";
import { createMemoryApprovalStore } from "../src/orchestrator/approvals/store.ts";
import { createJobsService } from "../src/orchestrator/jobs/service.ts";
import { createOrchestratorRuntime } from "../src/orchestrator/runtime.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { createTools } from "../src/orchestrator/tools/index.ts";
import { emptyScope } from "../src/orchestrator/types.ts";
import { T0, fakeDeps, fakePresence, fakeSettings, fakeTimers, flush, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const worktree = project({ id: "p2", name: "feat-x", path: "/nonexistent/wt/feat-x", worktree: { parentId: "p1", branch: "feat-x" } });

/** A runtime over fakes whose job service records `runNow`; no key, so no tick is ever planned. */
function setup(t, { approvals: approvalStore = createMemoryApprovalStore(), store = createMemoryOrchestratorStore(), timers = fakeTimers(), exec } = {}) {
  const { deps, state } = fakeDeps({
    sessions: [sessionMeta(), sessionMeta({ id: "s2", title: "Other" })],
    projects: [project(), worktree],
    originUrl: async (dir) => (dir === "/repo" || dir.startsWith("/nonexistent/wt") ? "https://github.com/acme/app.git" : dir === "/other" ? "git@github.com:acme/other.git" : null),
    fs: { exec: exec ?? (async (command) => ({ code: 0, stdout: `ran ${command}`, stderr: "", timedOut: false })) },
  });
  const resumed = [];
  const events = [];
  const runtime = createOrchestratorRuntime({
    store, settingsStore: fakeSettings({ key: null }), deps, timers, presence: fakePresence(),
    domains: {
      // No worker: these tests drive the clock and count timers, and only need runNow recorded.
      jobs: (hub) => ({ ...createJobsService(hub), start: () => {}, runNow: async (jobId, trigger) => { resumed.push([jobId, trigger]); return null; } }),
      approvals: (hub) => createApprovalsService(hub, { store: approvalStore }),
    },
  });
  runtime.subscribe((event) => events.push(event));
  t.after(() => runtime.dispose());
  const hub = runtime.hub;
  const activity = async (prefix = "approval.") => (await hub.activity.list({ kind: prefix })).map((entry) => entry.kind).reverse();
  return { runtime, hub, deps, state, store, timers, resumed, events, activity, approvalStore };
}

/** The turn's tools, gated, as `prepareTurn` would build them. */
function toolsFor(hub, turn = {}) {
  const info = { runId: "run1", kind: "chat", role: "chat", origin: "chat", threadId: "main", jobId: null, intentId: null, scope: emptyScope(), ...turn };
  const ctx = {
    store: hub.store, settings: hub.settings, deps: hub.deps, touched: new Set(), interactive: true, now: () => hub.timers.now(),
    self: { digest: async () => null, schedule: async () => ({}), lastTick: async () => null }, hub, turn: info,
  };
  return hub.approvals.gate(createTools(ctx), ctx);
}

const call = (tool, input, options = {}) => tool.execute(input, { toolCallId: "c1", messages: [], ...options });

/** Start a gated call and return it with the pending request it raised. */
async function asked(hub, tool, input, options) {
  const result = call(tool, input, options);
  await flush();
  const [approval] = await hub.approvals.pending();
  assert.ok(approval, "a request is pending");
  return { result, approval };
}

test("ungated tools and read-only commands run straight through", async (t) => {
  const { hub, state } = setup(t);
  const tools = toolsFor(hub);
  assert.deepEqual(await call(tools.send_prompt, { sessionId: "s1", text: "go" }), { sessionId: "s1", sent: true });
  assert.equal((await call(tools.run_command, { cwd: "/repo", command: "git status" })).stdout, "ran git status");
  assert.deepEqual(state.prompts, [{ id: "s1", text: "go" }]);
  assert.deepEqual(await hub.approvals.pending(), []);
});

test("chat: the call waits, and approving runs it and hands the result back to the turn", async (t) => {
  const { hub, state, events, activity, store } = setup(t);
  const tools = toolsFor(hub);
  const { result, approval } = await asked(hub, tools.delete_session, { sessionId: "s1" });
  assert.equal(approval.origin, "chat");
  assert.equal(approval.tool, "delete_session");
  assert.equal(approval.risk, "destructive");
  assert.equal(approval.repo, "acme/app");
  assert.deepEqual([approval.threadId, approval.runId], ["main", "run1"]);
  assert.equal(approval.expiresAt, T0 + EXPIRY_MS.chat);
  assert.deepEqual(approval.input, { sessionId: "s1" });
  assert.ok(events.some((event) => event.type === "approvals" && event.approvals.length === 1 && event.approvals[0].id === approval.id));
  assert.equal(state.sessions.length, 2, "nothing ran yet");
  assert.equal(await hub.approvals.hasPendingFor("run1"), true);

  const decided = await hub.approvals.decide(approval.id, { approve: true });
  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.result, { sessionId: "s1", deleted: true });
  assert.deepEqual(await result, { sessionId: "s1", deleted: true });
  assert.deepEqual(state.sessions.map((session) => session.id), ["s2"]);
  assert.deepEqual(await activity(), ["approval.requested", "approval.decided", "approval.executed"]);
  assert.deepEqual(await store.readMessages("main"), [], "the turn got the result, so no note is posted");
  assert.deepEqual(events.findLast((event) => event.type === "approvals").approvals, []);
  assert.equal(await hub.approvals.hasPendingFor("run1"), false);
  await assert.rejects(hub.approvals.decide(approval.id, { approve: true }), (err) => err.status === 409);
});

test("chat: declining returns an error the model can read, and nothing runs", async (t) => {
  const { hub, state, store } = setup(t);
  const { result, approval } = await asked(hub, toolsFor(hub).delete_session, { sessionId: "s1" });
  const decided = await hub.approvals.decide(approval.id, { approve: false, scope: "always" });
  assert.equal(decided.status, "denied");
  assert.deepEqual(decided.decision, { approve: false, scope: "once" }, "a refusal never creates a grant");
  assert.match((await result).error, /declined this delete_session call/);
  assert.equal(state.sessions.length, 2);
  assert.deepEqual(await hub.approvals.grants(), []);
  assert.deepEqual(await store.readMessages("main"), []);
});

test("chat: after the wait the call reports pending; a later approval runs it server-side and notes it in the thread", async (t) => {
  const { hub, state, store, timers, events } = setup(t);
  const { result, approval } = await asked(hub, toolsFor(hub, { threadId: "main" }).remove_project, { id: "p1" });
  await timers.advance(CHAT_WAIT_MS);
  const pending = await result;
  assert.equal(pending.pending, true);
  assert.equal(pending.approvalId, approval.id);
  assert.match(pending.note, /runs by itself once they approve/);
  assert.deepEqual(state.removed, []);

  const decided = await hub.approvals.decide(approval.id, { approve: true });
  assert.deepEqual(decided.result, { id: "p1", removed: true, kept: true });
  assert.deepEqual(state.removed, [{ id: "p1", keep: true }]);
  const [note] = await store.readMessages("main");
  assert.equal(note.role, "assistant");
  assert.match(note.parts[0].text, /^\*\*Approved:\*\* Remove project app from Portal\. It ran\.$/);
  assert.ok(events.some((event) => event.type === "messages" && event.threadId === "main"));
});

test("chat: a call the replay fails on records the error and says so in the note", async (t) => {
  const { hub, store, timers } = setup(t, { exec: async () => { throw new Error("spawn failed"); } });
  const { result, approval } = await asked(hub, toolsFor(hub).run_command, { cwd: "/repo", command: "npm install" });
  await timers.advance(CHAT_WAIT_MS);
  await result;
  const decided = await hub.approvals.decide(approval.id, { approve: true });
  assert.equal(decided.error, "spawn failed");
  assert.match((await store.readMessages("main"))[0].parts[0].text, /but it failed: spawn failed/);
});

test("chat: a cancelled turn stops waiting", async (t) => {
  const { hub } = setup(t);
  const controller = new AbortController();
  const { result } = await asked(hub, toolsFor(hub).delete_session, { sessionId: "s1" }, { abortSignal: controller.signal });
  controller.abort();
  assert.equal((await result).pending, true);
});

test("grants: always covers the tool everywhere, repo only that repo, job only that job or intent", async (t) => {
  const { hub, state, activity } = setup(t);
  // repo: approve a command in acme/app for the repository.
  const chat = toolsFor(hub);
  let { result, approval } = await asked(hub, chat.run_command, { cwd: "/repo", command: "npm install" });
  await hub.approvals.decide(approval.id, { approve: true, scope: "repo" });
  await result;
  assert.equal((await call(chat.run_command, { cwd: "/repo", command: "npm test" })).stdout, "ran npm test", "covered by the repo grant");
  ({ result, approval } = await asked(hub, chat.run_command, { cwd: "/other", command: "npm test" }));
  assert.equal(approval.repo, "acme/other", "another repo still asks");
  await hub.approvals.decide(approval.id, { approve: false });
  await result;

  // job: a grant from job j1 covers j1 (and its intent), never j2.
  const job1 = toolsFor(hub, { origin: "job", kind: "helper", jobId: "j1", intentId: "i1", runId: "r-j1", threadId: null });
  const first = await call(job1.pull_fast_forward, { projectId: "p1" });
  assert.equal(first.pending, true);
  await hub.approvals.decide(first.approvalId, { approve: true, scope: "job" });
  const [jobGrant] = (await hub.approvals.grants()).filter((grant) => grant.scope === "job");
  assert.deepEqual([jobGrant.tool, jobGrant.jobId, jobGrant.intentId, jobGrant.repo], ["pull_fast_forward", "j1", "i1", null]);
  // Covered: the call itself runs (and the fake git refuses it).
  assert.match((await call(job1.pull_fast_forward, { projectId: "p1" })).error, /pullFastForward is not available/);
  const viaIntent = toolsFor(hub, { origin: "job", kind: "intent_check", jobId: "j9", intentId: "i1", runId: "r-i1", threadId: null });
  assert.equal((await call(viaIntent.pull_fast_forward, { projectId: "p1" })).pending, undefined, "the intent that asked is covered");
  const job2 = toolsFor(hub, { origin: "job", kind: "helper", jobId: "j2", intentId: null, runId: "r-j2", threadId: null });
  assert.equal((await call(job2.pull_fast_forward, { projectId: "p1" })).pending, true);

  // always: delete_session anywhere, until revoked.
  ({ result, approval } = await asked(hub, chat.delete_session, { sessionId: "s1" }));
  await hub.approvals.decide(approval.id, { approve: true, scope: "always" });
  await result;
  assert.deepEqual(await call(job2.delete_session, { sessionId: "s2" }), { sessionId: "s2", deleted: true });
  assert.deepEqual(state.sessions, []);
  const always = (await hub.approvals.grants()).find((grant) => grant.scope === "always");
  await hub.approvals.revokeGrant(always.id);
  assert.equal((await call(job2.delete_session, { sessionId: "s2" })).pending, true, "a revoked grant asks again");
  assert.ok((await activity()).includes("approval.granted"));
  assert.ok((await activity()).includes("approval.revoked"));
});

test("scopes are checked against the request", async (t) => {
  const { hub } = setup(t);
  const { approval } = await asked(hub, toolsFor(hub).run_command, { cwd: "/elsewhere", command: "make" });
  await assert.rejects(hub.approvals.decide(approval.id, { approve: true, scope: "job" }), (err) => err.status === 400 && /job/.test(err.message));
  await assert.rejects(hub.approvals.decide(approval.id, { approve: true, scope: "repo" }), (err) => err.status === 400 && /repository/.test(err.message));
  await assert.rejects(hub.approvals.decide(approval.id, { approve: true, scope: "forever" }), (err) => err.status === 400);
  await assert.rejects(hub.approvals.decide(approval.id, { approve: "yes" }), (err) => err.status === 400);
  await assert.rejects(hub.approvals.decide("missing", { approve: true }), (err) => err.status === 404);
  assert.equal((await hub.approvals.get(approval.id)).status, "pending", "a refused decision leaves it pending");
});

test("job: the call returns pending at once, raises a Needs-you item, and approving runs it, resolves the item, and resumes the job", async (t) => {
  const { hub, store, resumed, state, activity } = setup(t);
  const tools = toolsFor(hub, { origin: "job", kind: "helper", jobId: "j1", intentId: null, runId: "r1", threadId: null });
  const output = await call(tools.remove_project, { id: "p2", deleteWorktree: true });
  assert.equal(output.pending, true);
  assert.match(output.note, /Needs-you item/);
  const approval = await hub.approvals.get(output.approvalId);
  assert.deepEqual([approval.origin, approval.jobId, approval.runId, approval.risk], ["job", "j1", "r1", "destructive"]);
  assert.equal(approval.expiresAt, T0 + EXPIRY_MS.job);
  assert.equal(await hub.approvals.hasPendingFor("r1"), true);
  const [item] = await store.listItems();
  assert.deepEqual([item.kind, item.status], ["approval_needed", "open"]);
  assert.deepEqual(item.links, { approvalId: approval.id, jobId: "j1" });
  assert.equal(item.title, "Approve: Remove worktree feat-x of app");
  assert.match(item.body, /background job is paused/);

  // The job asks again on its next run: the same request, not a second one.
  assert.equal((await call(tools.remove_project, { id: "p2", deleteWorktree: true })).approvalId, approval.id);
  assert.equal((await store.listItems()).length, 1);

  await hub.approvals.decide(approval.id, { approve: true });
  assert.deepEqual(state.removed, [{ id: "p2", keep: false }]);
  assert.equal((await store.getItem(item.id)).status, "resolved");
  assert.deepEqual(resumed, [["j1", "approval"]]);
  assert.equal(await hub.approvals.hasPendingFor("r1"), false);
  assert.deepEqual(await activity(), ["approval.requested", "approval.decided", "approval.executed"]);
});

test("job: declining resolves the item, notes the thread, and does not resume the job", async (t) => {
  const { hub, store, resumed, state } = setup(t);
  const side = await store.createThread({ title: "Review #7" });
  const tools = toolsFor(hub, { origin: "job", kind: "helper", jobId: "j1", intentId: null, runId: "r1", threadId: side.id });
  const output = await call(tools.delete_session, { sessionId: "s1" });
  await hub.approvals.decide(output.approvalId, { approve: false });
  assert.equal(state.sessions.length, 2);
  assert.equal((await store.listItems())[0].status, "resolved");
  assert.deepEqual(resumed, []);
  assert.match((await store.readMessages(side.id))[0].parts[0].text, /^\*\*Declined:\*\* Delete session Fix the login bug\. It did not run\.$/);
});

test("expiry: an unanswered request expires on its timer, resolves its item, and can never run", async (t) => {
  const { hub, store, timers, state, activity } = setup(t);
  const tools = toolsFor(hub, { origin: "job", kind: "helper", jobId: "j1", intentId: null, runId: "r1", threadId: "main" });
  const output = await call(tools.delete_session, { sessionId: "s1" });
  await timers.advance(EXPIRY_MS.job - 1);
  assert.equal((await hub.approvals.get(output.approvalId)).status, "pending");
  await timers.advance(2);
  assert.equal((await hub.approvals.get(output.approvalId)).status, "expired");
  assert.equal((await store.listItems())[0].status, "resolved");
  assert.match((await store.readMessages("main"))[0].parts[0].text, /^\*\*Expired:\*\*/);
  await assert.rejects(hub.approvals.decide(output.approvalId, { approve: true }), (err) => err.status === 409 && /expired/.test(err.message));
  assert.equal(state.sessions.length, 2);
  assert.ok((await activity()).includes("approval.expired"));
  assert.equal(timers.pending.length, 0, "no sweep is planned once nothing is pending");
});

test("expiry also applies on read, before any timer fires", async (t) => {
  const { hub, timers } = setup(t);
  const { result, approval } = await asked(hub, toolsFor(hub).delete_session, { sessionId: "s1" });
  timers.tick(EXPIRY_MS.chat);
  assert.deepEqual(await hub.approvals.pending(), []);
  assert.equal((await hub.approvals.get(approval.id)).status, "expired");
  assert.match((await result).error, /expired/);
});

test("guardAction: remove_worktree always asks; start_session and send_prompt ask unless an always grant covers them", async (t) => {
  const { runtime, hub, store, state } = setup(t);
  const item = await store.createItem({
    kind: "worktree_merged", title: "feat-x was merged", body: "", links: { projectId: "p2" }, fingerprint: "worktree_merged:p2",
    actions: [
      { type: "remove_worktree", projectId: "p2", label: "Remove" },
      { type: "start_session", projectId: "p1", prompt: "Clean up\n\nthe branch" },
      { type: "open_url", url: "https://example.com" },
    ],
  });
  assert.equal(await hub.approvals.guardAction(item, 2, item.actions[2]), null, "browser actions are not the server's to guard");

  const start = await hub.approvals.guardAction(item, 1, item.actions[1]);
  assert.deepEqual([start.origin, start.tool, start.itemId, start.risk], ["card", "start_session", item.id, "write"]);
  assert.match(start.summary, /```\nClean up\n\nthe branch\n```/);
  assert.deepEqual(start.input, { itemId: item.id, actionIndex: 1, action: item.actions[1] });
  const again = await hub.approvals.guardAction(item, 1, item.actions[1]);
  assert.equal(again.id, start.id, "clicking twice asks once");
  await assert.rejects(hub.approvals.decide(start.id, { approve: true, scope: "repo" }), (err) => err.status === 400);
  const ran = await hub.approvals.decide(start.id, { approve: true, scope: "always" });
  assert.deepEqual(ran.result, { sessionId: "s3" });
  assert.deepEqual(state.prompts, [{ id: "s3", text: "Clean up\n\nthe branch" }]);
  assert.equal(await hub.approvals.guardAction(item, 1, item.actions[1]), null, "the always grant covers the next click");

  const remove = await hub.approvals.guardAction(item, 0, item.actions[0]);
  assert.equal(remove.risk, "destructive");
  await assert.rejects(hub.approvals.decide(remove.id, { approve: true, scope: "always" }), (err) => err.status === 400 && /only be approved once/.test(err.message));
  // Through the runtime: the click waits for the approval, and the approval runs the same code path.
  const clicked = await runtime.performAction(item.id, 0);
  assert.equal(clicked.approvalId, remove.id);
  assert.deepEqual(state.removed, []);
  await hub.approvals.decide(remove.id, { approve: true });
  assert.deepEqual(state.removed, [{ id: "p2", keep: false }]);
  const logged = (await hub.activity.list({ kind: "item.action" })).map((entry) => entry.summary);
  assert.ok(logged.includes('Ran "Remove" on feat-x was merged'));
});

test("after a restart an approval still replays: the tool is rebuilt from a plain context", async (t) => {
  const approvals = createMemoryApprovalStore();
  const store = createMemoryOrchestratorStore();
  const before = setup(t, { approvals, store });
  const output = await call(toolsFor(before.hub, { origin: "job", kind: "helper", jobId: "j1", intentId: null, runId: "r1", threadId: null }).delete_session, { sessionId: "s1" });
  await before.runtime.dispose();

  const after = setup(t, { approvals, store });
  await after.runtime.ready;
  const decided = await after.hub.approvals.decide(output.approvalId, { approve: true });
  assert.deepEqual(decided.result, { sessionId: "s1", deleted: true });
  assert.deepEqual(after.state.sessions.map((session) => session.id), ["s2"]);
  assert.deepEqual(after.resumed, [["j1", "approval"]]);
});

test("status counts pending approvals", async (t) => {
  const { runtime, hub } = setup(t);
  await asked(hub, toolsFor(hub).delete_session, { sessionId: "s1" });
  assert.equal((await runtime.status()).counts.approvals, 1);
});
