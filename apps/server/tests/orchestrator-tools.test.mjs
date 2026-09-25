import assert from "node:assert/strict";
import { REVIEWER_PROMPT } from "../src/orchestrator/tools/composite.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execCommand, readFileCapped } from "../src/orchestrator/deps.ts";
import { STALE_PULL_MS } from "../src/orchestrator/digest.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { REDACTED } from "../src/orchestrator/tools/context.ts";
import { BACKGROUND_TOOLS, createTools } from "../src/orchestrator/tools/index.ts";
import { DEFAULT_FILE_BYTES, OUTPUT_CAP } from "../src/orchestrator/tools/shell.ts";
import { TRANSCRIPT_CAP } from "../src/orchestrator/tools/sessions.ts";
import { T0, attentionPull, fakeDeps, fakeSettings, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const options = { toolCallId: "call", messages: [] };


function setup({ interactive = true, settings = fakeSettings(), memory = [], ...overrides } = {}) {
  const store = createMemoryOrchestratorStore();
  const { deps, state } = fakeDeps(overrides);
  const touched = new Set();
  // Turns build the classic tools over the domain context; setup_pr_reviews reaches the jobs service through it.
  const intents = [];
  const hub = {
    jobs: {
      createIntent: async (input, how) => {
        intents.push({ input, how });
        return { intent: { id: `i${intents.length}`, ...input }, job: { id: `j${intents.length}` } };
      },
    },
    // `memory` seeds entities as { type, key, records }; recordsFor answers the ones asked for that exist.
    memory: {
      recordsFor: async (wanted) => wanted.flatMap(({ type, key }) => memory.filter((entry) => entry.type === type && entry.key === key.toLowerCase())
        .map((entry) => ({ entity: { id: `e-${entry.key}`, type: entry.type, key: entry.key }, records: entry.records }))),
    },
  };
  const ctx = {
    store, deps, touched, settings, interactive, now: () => T0,
    hub, turn: { runId: "run1", threadId: "main", kind: "chat", origin: interactive ? "chat" : "job" },
  };
  return { tools: createTools(ctx), store, deps, state, touched, intents };
}

/** Call a tool the way the SDK does: the input goes through its zod schema first, so bounds are asserted for real. */
async function run(tool, input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), invalidInput: true };
  return tool.execute(parsed.data, options);
}

test("every tool has a description and an input schema; a background turn gets the fixed subset", () => {
  const { tools } = setup();
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.description && tool.description.length > 10, `${name} has a description`);
    assert.ok(tool.inputSchema, `${name} has an input schema`);
    assert.equal(typeof tool.execute, "function", `${name} executes`);
  }
  assert.ok(Object.keys(tools).length >= 43);
  for (const name of BACKGROUND_TOOLS) assert.ok(tools[name], `${name} exists`);

  const { tools: background } = setup({ interactive: false });
  assert.deepEqual(Object.keys(background).sort(), [...BACKGROUND_TOOLS].sort());
  for (const name of ["run_command", "read_file", "delete_session", "remove_project", "send_prompt", "create_session", "setup_pr_reviews", "write_memory", "answer_permission"]) {
    assert.equal(background[name], undefined, `${name} is not a background tool`);
  }
});

test("list tools cap their rows and flag the cut; limits are enforced by the schema", async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => sessionMeta({ id: `s${i}`, title: `Task ${i}`, lastActiveAt: T0 - i }));
  const { tools } = setup({ sessions });
  const listed = await run(tools.list_sessions, {});
  assert.equal(listed.sessions.length, 25);
  assert.equal(listed.truncated, true);
  assert.equal(listed.total, 30);
  assert.deepEqual(Object.keys(listed.sessions[0]).sort(), ["activity", "agent", "id", "lastActiveAt", "projectId", "title"]);
  const few = await run(tools.list_sessions, { limit: 3, status: "idle" });
  assert.equal(few.sessions.length, 3);
  assert.equal(few.truncated, true);
  assert.equal((await run(tools.list_sessions, { limit: 101 })).invalidInput, true);
  assert.equal((await run(tools.list_sessions, { limit: 0 })).invalidInput, true);
  assert.equal((await run(tools.list_sessions, { status: "sleeping" })).invalidInput, true);
  const projects = Array.from({ length: 27 }, (_, i) => project({ id: `p${i}`, path: `/r${i}`, ...(i % 2 ? { worktree: { parentId: "p0", branch: `b${i}` } } : {}) }));
  const { tools: projectTools } = setup({ projects });
  const worktrees = await run(projectTools.list_projects, { filter: "worktrees" });
  assert.equal(worktrees.total, 13);
  assert.equal(worktrees.truncated, false);
  assert.ok(worktrees.projects.every((entry) => entry.worktree));
  const all = await run(projectTools.list_projects, {});
  assert.equal(all.projects.length, 25);
  assert.equal(all.truncated, true);
});

test("a failing tool returns { error } instead of throwing", async () => {
  const { tools } = setup();
  assert.deepEqual(await run(tools.get_project, { id: "missing" }), { error: "Unknown project." });
  assert.deepEqual(await run(tools.get_session, { sessionId: "missing" }), { error: "Unknown session." });
  const status = await run(tools.get_github_status, { projectId: "missing" });
  assert.equal(status.error, "Unknown project.");
});

test("create_item dedupes by fingerprint, accepts the digest's shapes, rejects others, and records touched ids", async () => {
  const { tools, store, touched } = setup();
  const input = {
    kind: "pr_checks_failing", title: "Checks failing on acme/app#7", body: "CI is red.",
    links: { pull: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" } },
    actions: [{ type: "open_url", url: "https://github.com/acme/app/pull/7", label: "Open PR" }],
    fingerprint: "pr:acme/app#7",
  };
  const created = await run(tools.create_item, input);
  assert.equal(created.created, true);
  assert.equal(created.status, "open");
  const again = await run(tools.create_item, { ...input, title: "Still failing" });
  assert.equal(again.updated, true);
  assert.equal(again.id, created.id);
  assert.match(again.note, /already existed/);
  const items = await store.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Still failing");
  assert.ok(!("list" in items[0]));
  assert.deepEqual([...touched], [created.id]);

  // The per-repo review form and the classic <kind>:<key> form are fine; anything else is not.
  const perRepo = await run(tools.create_item, { ...input, kind: "pr_review_requested", fingerprint: "pr_review_requested:acme/app" });
  assert.equal(perRepo.created, true);
  const classic = await run(tools.create_item, { ...input, kind: "session_waiting", fingerprint: "session_waiting:s1" });
  assert.equal(classic.created, true);
  for (const fingerprint of ["custom:has space", "nocolon", "Upper:x", "pr:", ":key", "pr-x:key"]) {
    const bad = await run(tools.create_item, { ...input, fingerprint });
    assert.match(bad.error, /fingerprint must look like/, fingerprint);
  }
  assert.equal((await run(tools.create_item, { ...input, fingerprint: "ab" })).invalidInput, true, "too short for the schema");
  assert.equal((await run(tools.create_item, { ...input, kind: "made_up" })).invalidInput, true);
  assert.equal((await run(tools.create_item, { ...input, actions: Array(5).fill(input.actions[0]) })).invalidInput, true);
  assert.equal((await store.listItems()).length, 3);

  // A resolved item with the same fingerprint does not block a new one.
  await run(tools.resolve_item, { id: created.id });
  const fresh = await run(tools.create_item, input);
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.id, created.id);
});

test("snooze, dismiss, and list items", async () => {
  const { tools, store } = setup();
  const item = await store.createItem({ kind: "custom", title: "t", body: "", links: {}, actions: [], fingerprint: "custom:a" });
  const snoozed = await run(tools.snooze_item, { id: item.id, minutes: 30 });
  assert.equal(snoozed.status, "snoozed");
  assert.equal((await store.getItem(item.id)).snoozedUntil, T0 + 30 * 60_000);
  assert.equal((await run(tools.snooze_item, { id: item.id, minutes: 0 })).invalidInput, true);
  assert.equal((await run(tools.snooze_item, { id: item.id, minutes: 8 * 24 * 60 })).invalidInput, true);
  assert.deepEqual((await run(tools.list_items, { status: "snoozed" })).items.map((row) => row.id), [item.id]);
  assert.deepEqual((await run(tools.list_items, {})).items, []);
  const dismissed = await run(tools.dismiss_item, { id: item.id });
  assert.equal(dismissed.status, "dismissed");
  assert.equal((await store.getItem(item.id)).snoozedUntil, null);
});

test("run_command returns exit code and output, truncating long output head and tail", async () => {
  const { tools } = setup({ fs: { exec: execCommand } });
  const ok = await run(tools.run_command, { cwd: os.tmpdir(), command: "echo hello && echo oops 1>&2 && exit 3" });
  assert.equal(ok.code, 3);
  assert.equal(ok.stdout.trim(), "hello");
  assert.equal(ok.stderr.trim(), "oops");
  assert.equal(ok.truncated, false);
  assert.equal(ok.timedOut, false);

  const long = await run(tools.run_command, { cwd: os.tmpdir(), command: `node -e "process.stdout.write('a'.repeat(5000) + 'MIDDLE' + 'z'.repeat(5000))"` });
  assert.equal(long.code, 0);
  assert.equal(long.truncated, true);
  assert.ok(long.stdout.length < OUTPUT_CAP + 200);
  assert.ok(long.stdout.startsWith("aaaa"));
  assert.ok(long.stdout.endsWith("zzzz"));
  assert.match(long.stdout, /characters omitted/);
  assert.ok(!long.stdout.includes("MIDDLE"));

  // Far more than the exec buffer: the collector keeps head and tail without holding it all.
  const huge = await execCommand(`node -e "process.stdout.write('h'.repeat(3000) + 'CENTER' + 't'.repeat(3000))"`, { cwd: os.tmpdir(), timeoutMs: 10_000, maxBytes: 1000 });
  assert.equal(huge.code, 0);
  assert.ok(huge.stdout.startsWith("hhhh"));
  assert.ok(huge.stdout.endsWith("tttt"));
  assert.match(huge.stdout, /\[\.\.\. \d+ bytes omitted \.\.\.\]/);
  assert.ok(!huge.stdout.includes("CENTER"));
  assert.ok(huge.stdout.length < 1100);

  const missing = await execCommand("true", { cwd: path.join(os.tmpdir(), "does-not-exist-portal"), timeoutMs: 5_000, maxBytes: 1000 });
  assert.equal(missing.code, null);
  assert.equal(missing.timedOut, false);
  assert.ok(missing.stderr.length > 0, "a command that never started says why");
});

test("run_command kills the whole process group of a command that exceeds its timeout", async () => {
  const { tools } = setup({ fs: { exec: execCommand } });
  // The shell prints the pid of a background sleep it then waits for; after the timeout, that sleep must be gone too.
  const slow = await run(tools.run_command, { cwd: os.tmpdir(), command: "sleep 30 & echo $!; wait", timeoutSeconds: 1 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.code, null);
  const pid = Number(slow.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `pid in ${JSON.stringify(slow.stdout)}`);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 40 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the orphaned sleep was killed with its group");

  assert.equal((await run(tools.run_command, { cwd: os.tmpdir(), command: "true", timeoutSeconds: 500 })).invalidInput, true);
  assert.equal((await run(tools.run_command, { cwd: os.tmpdir(), command: "true", timeoutSeconds: 0 })).invalidInput, true);
});

test("tool outputs never carry a stored API key, and read_file refuses the settings file", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portal-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previousHome = process.env.PORTAL_HOME;
  process.env.PORTAL_HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PORTAL_HOME;
    else process.env.PORTAL_HOME = previousHome;
  });
  const secret = "sk-live-abc123XYZ";
  const settingsFile = path.join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ orchestrator: { apiKeys: { openai: secret } } }));
  const leak = path.join(dir, "notes.txt");
  writeFileSync(leak, `token=${secret}\nrest of file`);
  const { tools } = setup({ settings: fakeSettings({ key: secret }), fs: { exec: execCommand, readFile: readFileCapped } });

  const refused = await run(tools.read_file, { path: settingsFile });
  assert.match(refused.error, /settings file cannot be read/);
  assert.match((await run(tools.read_file, { path: `${dir}/../${path.basename(dir)}/settings.json` })).error, /settings file/, "no path tricks");

  const file = await run(tools.read_file, { path: leak });
  assert.equal(file.text, `token=${REDACTED}\nrest of file`);
  assert.equal(file.truncated, false);

  const cat = await run(tools.run_command, { cwd: dir, command: `cat ${JSON.stringify(settingsFile)}` });
  assert.equal(cat.code, 0);
  assert.ok(!cat.stdout.includes(secret));
  assert.ok(cat.stdout.includes(REDACTED));
  const echo = await run(tools.run_command, { cwd: dir, command: `echo ${secret} ${secret}` });
  assert.equal(echo.stdout.trim(), `${REDACTED} ${REDACTED}`);
  assert.equal((await run(tools.read_file, { path: "relative/path" })).error, "Path must be absolute (or start with ~/).");

  // The server key is redacted too: a read-only command like `grep -r ~` could otherwise print it.
  const serverKey = "c2VydmVyLWtleS1ieXRlcy1mb3ItdGVzdHMtb25seQ==";
  const keyed = setup({ settings: { ...fakeSettings({ key: secret }), serverSecrets: async () => [serverKey] }, fs: { exec: execCommand, readFile: readFileCapped } });
  const grep = await run(keyed.tools.run_command, { cwd: dir, command: `echo server.key:${serverKey}` });
  assert.equal(grep.stdout.trim(), `server.key:${REDACTED}`);
});

test("read_file caps at 8 KB by default and at 32 KB at most", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portal-read-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "big.txt");
  writeFileSync(file, "b".repeat(20 * 1024));
  const { tools } = setup({ fs: { readFile: readFileCapped } });
  const capped = await run(tools.read_file, { path: file });
  assert.equal(Buffer.byteLength(capped.text, "utf8"), DEFAULT_FILE_BYTES);
  assert.equal(capped.truncated, true);
  assert.equal(capped.bytes, 20 * 1024);
  const more = await run(tools.read_file, { path: file, maxBytes: 16 * 1024 });
  assert.equal(more.text.length, 16 * 1024);
  assert.equal((await run(tools.read_file, { path: file, maxBytes: 64 * 1024 })).invalidInput, true);
});

test("read_transcript renders the last turns as plain text and caps it from the front", async () => {
  const chunk = (text, seq) => ({ seq, ts: T0 + seq, type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  const events = [
    { seq: 0, ts: T0, type: "user", text: "Fix the bug" },
    { seq: 1, ts: T0, type: "turn_start" },
    { seq: 2, ts: T0, type: "update", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } },
    { seq: 3, ts: T0, type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read src/app.ts", kind: "read", status: "pending" } },
    { seq: 4, ts: T0, type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } },
    chunk("I found ", 5), chunk("the bug.", 6),
    { seq: 7, ts: T0, type: "turn_end", stopReason: "end_turn" },
    { seq: 8, ts: T0, type: "user", text: "Now fix it" },
    { seq: 9, ts: T0, type: "turn_start" },
    chunk("Done.", 10),
    { seq: 11, ts: T0, type: "turn_end", stopReason: "max_tokens" },
  ];
  const { tools } = setup({ sessions: [sessionMeta()], events: { s1: events } });
  const one = await run(tools.read_transcript, { sessionId: "s1", lastTurns: 1 });
  assert.deepEqual(one, { sessionId: "s1", turns: 1, text: "User: Now fix it\nAssistant: Done.\n[turn ended: max_tokens]", truncated: false });
  const both = await run(tools.read_transcript, { sessionId: "s1" });
  assert.equal(both.turns, 2);
  assert.equal(both.text, "User: Fix the bug\n[tool] Read src/app.ts\nAssistant: I found the bug.\nUser: Now fix it\nAssistant: Done.\n[turn ended: max_tokens]");
  assert.ok(!both.text.includes("thinking"), "thoughts are left out");
  assert.equal((await run(tools.read_transcript, { sessionId: "s1", lastTurns: 21 })).invalidInput, true);

  const huge = [{ seq: 0, ts: T0, type: "user", text: "go" }, chunk("x".repeat(TRANSCRIPT_CAP * 2), 1)];
  const { tools: capped } = setup({ sessions: [sessionMeta()], events: { s1: huge } });
  const cut = await run(capped.read_transcript, { sessionId: "s1" });
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.startsWith("[earlier text omitted]\n"));
  assert.ok(cut.text.length <= TRANSCRIPT_CAP + 30);
});

test("get_pending_permission finds the open request", async () => {
  const events = [
    { seq: 0, ts: T0, type: "user", text: "rm it" },
    { seq: 1, ts: T0, type: "permission_request", requestId: "req-1", toolCall: { toolCallId: "t1", title: "Run rm -rf build" }, options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
    ] },
  ];
  const { tools } = setup({ sessions: [sessionMeta({ awaitingPermission: true })], events: { s1: events } });
  const pending = await run(tools.get_pending_permission, { sessionId: "s1" });
  assert.deepEqual(pending, {
    sessionId: "s1",
    pending: { requestId: "req-1", tool: "Run rm -rf build", options: [{ id: "allow", name: "Allow once", kind: "allow_once" }, { id: "reject", name: "Reject", kind: "reject_once" }] },
  });
  const { tools: idle } = setup({ sessions: [sessionMeta()] });
  assert.deepEqual(await run(idle.get_pending_permission, { sessionId: "s1" }), { sessionId: "s1", pending: null });
});

test("stop_session cancels a busy session's turn, waits until it is idle, and answers the state it confirmed", async () => {
  const { tools, deps, state } = setup({ sessions: [sessionMeta({ busy: true })], events: { s1: [{ seq: 0, ts: T0, type: "turn_start" }] } });
  const cancels = [];
  let polls = 0;
  deps.sessions.get = async (id) => {
    const meta = state.sessions.find((session) => session.id === id);
    // The agent acknowledges the cancel a few looks later, as a real one does.
    if (cancels.length && ++polls === 3) {
      meta.busy = false;
      state.events.s1.push({ seq: 1, ts: T0, type: "turn_end", stopReason: "cancelled" });
    }
    return meta;
  };
  deps.sessions.cancel = async (id) => { cancels.push(id); };
  const result = await run(tools.stop_session, { sessionId: "s1" });
  assert.deepEqual(result, { sessionId: "s1", stopped: true, activity: "idle", stopReason: "cancelled" });
  assert.deepEqual(cancels, ["s1"]);
  assert.ok(polls >= 3, "it waited for the session to go idle");

  // Nothing to stop: no cancel is sent.
  assert.deepEqual(await run(tools.stop_session, { sessionId: "s1" }), { sessionId: "s1", stopped: false, activity: "idle", note: "The session had no turn to stop." });
  assert.deepEqual(cancels, ["s1"]);
  assert.match((await run(tools.stop_session, { sessionId: "nope" })).error, /Unknown session/);
});

test("stop_session reports a session that stays busy past the timeout as not stopped", async () => {
  const { tools } = setup({ sessions: [sessionMeta({ busy: true })] });
  const result = await run(tools.stop_session, { sessionId: "s1", timeoutSeconds: 1 });
  assert.deepEqual(result, { sessionId: "s1", stopped: false, activity: "working", note: "The session was still busy 1s after the stop was sent." });
});

test("create_session mirrors the sessions route, sends the first prompt, and reports a failed prompt without losing the session", async () => {
  const { tools, state } = setup({ projects: [project()] });
  const created = await run(tools.create_session, { projectId: "p1", prompt: "Say hi" });
  assert.deepEqual(created, { sessionId: "s1" });
  assert.deepEqual(state.prompts, [{ id: "s1", text: "Say hi" }]);
  assert.equal(state.created[0].agentId, "claude");
  assert.match((await run(tools.create_session, { projectId: "p1", agentId: "nope" })).error, /Unknown agent/);
  assert.match((await run(tools.create_session, { projectId: "zzz" })).error, /Unknown project/);

  state.promptFailure = "agent not ready";
  const half = await run(tools.create_session, { projectId: "p1", prompt: "Try" });
  assert.deepEqual(half, { sessionId: "s2", promptError: "agent not ready" });
  assert.equal(state.created.length, 2, "the session was created once");
});

test("setup_pr_reviews checks out each PR, starts a review session, and creates one intent that reports the findings", async () => {
  const pulls = { 1: "feat/one", 2: "feat/two", 3: "fork/three" };
  const { tools, state, intents } = setup({
    projects: [project()],
    getPull: async (repoRoot, number) => {
      if (!pulls[number]) throw Object.assign(new Error(`PR #${number} not found.`), { status: 404 });
      // PR 1 is the user's own; PR 2 is someone else's.
      return { number, title: `PR ${number}`, branch: pulls[number], state: "open", updatedAt: T0, fork: number === 3, author: number === 1 ? "Moses-Lee" : "someone" };
    },
    ensureWorktree: async ({ branch }) => ({ path: `/wt/${branch}`, created: true }),
    originUrl: async (dir) => (dir === "/repo" ? "git@github.com:acme/app.git" : null),
  });
  const result = await run(tools.setup_pr_reviews, { repo: "acme/app", numbers: [1, 2, 3, 4] });
  assert.deepEqual(result.sessions, [
    { pr: 1, url: "https://github.com/acme/app/pull/1", sessionId: "s1", projectId: "p2", title: "PR 1", author: "Moses-Lee", worktreeCreated: true },
    { pr: 2, url: "https://github.com/acme/app/pull/2", sessionId: "s2", projectId: "p3", title: "PR 2", author: "someone", worktreeCreated: true },
  ]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /PR #3: .*fork/);
  assert.match(result.errors[1], /PR #4: PR #4 not found/);
  assert.deepEqual(state.added.map((entry) => [entry.path, entry.worktree]), [
    ["/wt/feat/one", { parentId: "p1", branch: "feat/one" }],
    ["/wt/feat/two", { parentId: "p1", branch: "feat/two" }],
  ]);
  assert.equal(state.prompts[0].id, "s1");
  // The user's own PR gets their stored triage prompt; someone else's gets the reviewer's brief.
  assert.equal(state.prompts[0].text, "Review this PR.\n\nPR #1: https://github.com/acme/app/pull/1");
  assert.equal(state.prompts[1].text, `${REVIEWER_PROMPT}\n\nPR #2: https://github.com/acme/app/pull/2`);
  assert.equal(result.intentId, "i1");
  const [{ input, how }] = intents;
  assert.match(input.text, /^Review PRs 1, 2 on acme\/app; tell me the findings when the review sessions finish/);
  assert.match(input.trigger, /s1, s2/);
  assert.match(input.action, /findings/);
  assert.equal(input.fireBudget, 1);
  assert.deepEqual(input.check, { type: "every", everyMs: 2 * 60_000 });
  // The check needs no model: the review watch lists each PR's session.
  assert.deepEqual(input.checkPayload.review, { repo: "acme/app", sessions: result.sessions });
  assert.deepEqual(input.scope.sessionIds, ["s1", "s2"]);
  assert.deepEqual(input.scope.projectIds, ["p1", "p2", "p3"]);
  assert.deepEqual(input.scope.pulls.map((pull) => pull.number), [1, 2]);
  assert.deepEqual(input.scope.repos, ["acme/app"]);
  assert.deepEqual(how, { actor: "agent", runId: "run1", threadId: "main" });

  const custom = await run(tools.setup_pr_reviews, { projectId: "p1", numbers: [1], prompt: "Just summarise." });
  assert.equal(state.prompts.at(-1).text, "Just summarise.\n\nPR #1: https://github.com/acme/app/pull/1");
  assert.equal(custom.sessions[0].projectId, "p2", "the existing worktree project is reused");

  // A prompt that fails still counts the session as started, and says so.
  state.promptFailure = "agent not ready";
  const partial = await run(tools.setup_pr_reviews, { projectId: "p1", numbers: [2] });
  assert.equal(partial.sessions.length, 1);
  assert.equal(partial.sessions[0].promptError, "agent not ready");
  assert.match(partial.errors[0], /PR #2: the session started but the prompt failed: agent not ready/);
  assert.equal((await run(tools.setup_pr_reviews, { repo: "acme/app", numbers: [] })).invalidInput, true);
  assert.equal((await run(tools.setup_pr_reviews, { repo: "not a repo", numbers: [1] })).invalidInput, true);
});

test("setup_pr_reviews asks for a brief written from memory when memory has review guidance for someone else's PR", async () => {
  const record = (id, key, type, body) => ({ id, key, type, body });
  const { tools, state, intents } = setup({
    projects: [project()],
    memory: [
      { type: "person", key: "someone", records: [record("m1", "review-style", "procedure", "Check the migrations first."), record("m2", "timezone", "fact", "Lives in Berlin.")] },
      { type: "task_type", key: "code-review", records: [record("m3", "format", "preference", "Blocking issues first, then nits.")] },
      { type: "repo", key: "acme/app", records: [record("m4", "tests", "convention", "Every change has a test."), record("m5", "owner", "fact", "Owned by infra.")] },
    ],
    getPull: async (repoRoot, number) => ({ number, title: `PR ${number}`, branch: `feat/${number}`, state: "open", updatedAt: T0, fork: false, author: number === 1 ? "moses-lee" : "Someone" }),
    ensureWorktree: async ({ branch }) => ({ path: `/wt/${branch}`, created: true }),
    originUrl: async (dir) => (dir === "/repo" ? "git@github.com:acme/app.git" : null),
  });
  const refused = await run(tools.setup_pr_reviews, { repo: "acme/app", numbers: [2] });
  assert.match(refused.error, /Memory has guidance/);
  for (const id of ["m1", "m3", "m4"]) assert.match(refused.error, new RegExp(`- ${id} \\(`));
  for (const id of ["m2", "m5"]) assert.doesNotMatch(refused.error, new RegExp(`- ${id} `), `${id} is not about reviewing`);
  assert.deepEqual(state.created, [], "nothing started");

  // The user's own PR needs no brief from memory.
  assert.equal((await run(tools.setup_pr_reviews, { repo: "acme/app", numbers: [1] })).sessions.length, 1);

  const done = await run(tools.setup_pr_reviews, { repo: "acme/app", numbers: [2], prompt: "Start with the migrations; blocking issues first.", memoryIds: ["m1", "m3", "not an id"] });
  assert.equal(done.sessions.length, 1);
  assert.equal(state.prompts.at(-1).text, "Start with the migrations; blocking issues first.\n\nPR #2: https://github.com/acme/app/pull/2");
  const { input } = intents.at(-1);
  assert.deepEqual(input.checkPayload.review.memoryIds, ["m1", "m3"]);
  assert.match(input.notes, /Brief written from memory: m1, m3/);
});

test("get_settings masks keys and returns the prompts", async () => {
  const { tools } = setup();
  const settings = await run(tools.get_settings, {});
  assert.deepEqual(settings.prompts, { checks: "Look at CI.", conflicts: "Look at conflicts.", review: "Review this PR." });
  assert.deepEqual(settings.orchestrator.apiKeys, { openai: true, anthropic: false });
  assert.ok(!JSON.stringify(settings).includes("sk-test"));
});

test("the legacy memory-file tools and the tick's self tools are gone", async () => {
  const { tools } = setup();
  for (const name of ["read_memory", "write_memory", "append_memory", "get_tick_digest", "get_last_tick"]) assert.equal(tools[name], undefined, name);
});

test("remove_project runs the pre-deletion script in the worktree before git removes it, and a failure keeps the worktree", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portal-remove-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parentPath = path.join(root, "repo");
  const worktreePath = path.join(root, "worktree");
  for (const dir of [parentPath, worktreePath]) mkdirSync(dir);
  const projects = [
    project({ id: "p1", path: parentPath }),
    project({ id: "p2", name: "feat", path: worktreePath, worktree: { parentId: "p1", branch: "feat/x" } }),
  ];
  const order = [];
  const { tools, state } = setup({
    projects,
    removeWorktree: async (opts) => { order.push(["removeWorktree", opts]); return { branchDeleted: false }; },
    scripts: { run: async (kind, opts) => { order.push([kind, opts]); return { ran: true, ok: true, code: 0, stdout: "", stderr: "", timedOut: false }; } },
  });
  assert.deepEqual(await run(tools.remove_project, { id: "p2", deleteWorktree: true }), { id: "p2", removed: true, kept: false, branchDeleted: false });
  assert.deepEqual(order, [
    ["preWorktreeDelete", { cwd: worktreePath, env: { PORTAL_WORKTREE_PATH: worktreePath, PORTAL_REPO_ROOT: parentPath, PORTAL_BRANCH: "feat/x" } }],
    ["removeWorktree", { repoRoot: parentPath, path: worktreePath, branch: "feat/x", force: false }],
  ]);
  assert.deepEqual(state.removed, [{ id: "p2", keep: false }]);

  // Without deleteWorktree nothing runs; the script is about the folder, not the project record.
  const quiet = setup({ projects: [project({ id: "p1", path: parentPath }), project({ id: "p3", path: worktreePath, worktree: { parentId: "p1", branch: "feat/y" } })], removeWorktree: async () => { throw new Error("should not run"); } });
  assert.deepEqual(await run(quiet.tools.remove_project, { id: "p3" }), { id: "p3", removed: true, kept: false, branchDeleted: false });
  assert.deepEqual(quiet.state.scripts, []);

  // A script that aborts stops before git and before the project record is touched.
  const failing = setup({
    projects: [project({ id: "p1", path: parentPath }), project({ id: "p4", path: worktreePath, worktree: { parentId: "p1", branch: "feat/z" } })],
    removeWorktree: async () => { throw new Error("should not run"); },
    scripts: { run: async () => { throw Object.assign(new Error("The script exited with code 2."), { status: 409 }); } },
  });
  assert.deepEqual(await run(failing.tools.remove_project, { id: "p4", deleteWorktree: true, force: true }), { error: "The script exited with code 2." });
  assert.deepEqual(failing.state.removed, []);
});

test("list_attention_pulls narrows the search to the stale window unless includeStale asks for everything", async () => {
  // The search filters by whole days, so a PR just past the cutoff can come back; the tool drops it like the digest does.
  const { tools, state } = setup({ pulls: [attentionPull({ number: 1 }), attentionPull({ number: 99, updatedAt: T0 - STALE_PULL_MS - 1 })] });
  const narrowed = await run(tools.list_attention_pulls, {});
  assert.deepEqual(narrowed.pulls.map((row) => row.key), ["acme/app#1"]);
  const everything = await run(tools.list_attention_pulls, { includeStale: true });
  assert.deepEqual(everything.pulls.map((row) => row.key), ["acme/app#1", "acme/app#99"]);
  assert.deepEqual(state.searches, [{ updatedSince: T0 - STALE_PULL_MS }, {}]);
});
