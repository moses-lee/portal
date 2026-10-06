import assert from "node:assert/strict";
import { REVIEWER_PROMPT } from "../src/orchestrator/tools/composite.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { execCommand, readFileCapped } from "../src/orchestrator/deps.ts";
import { STALE_PULL_MS } from "../src/orchestrator/digest.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { REDACTED } from "../src/orchestrator/tools/context.ts";
import { GATED_TOOLS } from "../src/orchestrator/approvals/policy.ts";
import { systemPrompt } from "../src/orchestrator/prompt.ts";
import { TOOL_GROUPS } from "../src/orchestrator/tools/groups.ts";
import { BACKGROUND_TOOLS, createTools } from "../src/orchestrator/tools/index.ts";
import { DEFAULT_FILE_BYTES, OUTPUT_CAP } from "../src/orchestrator/tools/shell.ts";
import { TRANSCRIPT_CAP } from "../src/orchestrator/tools/sessions.ts";
import { createTrackedService } from "../src/orchestrator/tracked/service.ts";
import { createMemoryTrackedStore } from "../src/orchestrator/tracked/store.ts";
import { trackedTools } from "../src/orchestrator/tracked/tools.ts";
import { createWorkspaceService } from "../src/workspace/service.ts";
import { createMemoryWorkspaceStore } from "../src/workspace/store.ts";
import { workspaceTools } from "../src/orchestrator/workspace/tools.ts";
import { T0, attentionPull, fakeDeps, fakeSettings, liveness, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

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
  // The tracked list: the real service over a memory store, its activity entries and pushes recorded, the world holding the set.
  const activity = [];
  const events = [];
  const world = { tracked: [] };
  Object.assign(hub, {
    deps, timers: { now: () => T0 }, emit: (event) => events.push(event),
    activity: { log: async (entry) => { activity.push(entry); } },
    world: { current: async () => world, trackedChanged: (ids) => { world.tracked = ids; } },
  });
  hub.tracked = createTrackedService(hub, createMemoryTrackedStore({ sessionExists: (id) => state.sessions.some((meta) => meta.id === id) }));
  hub.workspace = createWorkspaceService(hub, createMemoryWorkspaceStore());
  const ctx = {
    store, deps, touched, settings, interactive, now: () => T0,
    hub, turn: { runId: "run1", threadId: "main", kind: "chat", origin: interactive ? "chat" : "job" },
  };
  return { tools: { ...createTools(ctx), ...trackedTools(ctx), ...workspaceTools(ctx) }, store, deps, state, touched, intents, hub, activity, events, world };
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
  assert.match((await run(tools.get_project, { id: "missing" })).error, /^No project has id "missing"\./);
  assert.match((await run(tools.get_session, { sessionId: "missing" })).error, /^No session has id "missing"\./);
  const status = await run(tools.get_github_status, { projectId: "missing" });
  assert.match(status.error, /^No project has id "missing"\./);
});

// Ids as the World section shows them: 8-char prefixes of uuids. Two sessions share the prefix "5e0f".
const REVIEW = "17329ac6-0c1e-4c4f-9a57-3d2b1f0e9a01";
const FIRST = "5e0f1b2c-7d3e-4a1b-8c2d-000000000002";
const SECOND = "5e0f9d8e-1a2b-4c3d-9e8f-000000000003";
const PORTAL = "9b1d4e7a-5c6d-4e7f-8a9b-00000000000p";

function prefixed() {
  return setup({
    projects: [project({ id: PORTAL, name: "portal" })],
    sessions: [
      sessionMeta({ id: REVIEW, projectId: PORTAL, title: "Review auth" }), sessionMeta({ id: FIRST, projectId: PORTAL, title: "First" }),
      sessionMeta({ id: SECOND, projectId: "", title: "Second" }),
    ],
    events: { [REVIEW]: [{ seq: 1, kind: "user", text: "Review the auth change", at: T0 }] },
  });
}

test("session tools take a unique id prefix and answer with the full id", async () => {
  const { tools, state } = prefixed();
  assert.equal((await run(tools.get_session, { sessionId: "17329ac6" })).id, REVIEW);
  assert.equal((await run(tools.get_session, { sessionId: "17329AC6-0c1e" })).id, REVIEW, "case-insensitive");
  const transcript = await run(tools.read_transcript, { sessionId: "17329ac6" });
  assert.equal(transcript.sessionId, REVIEW);
  assert.equal(transcript.error, undefined);
  assert.deepEqual((await run(tools.send_prompt, { sessionId: "17329ac6", text: "Go on" })), { sessionId: REVIEW, sent: true });
  assert.deepEqual(state.prompts, [{ id: REVIEW, text: "Go on" }]);
  assert.deepEqual((await run(tools.cancel_turn, { sessionId: "5e0f1b2c" })), { sessionId: FIRST, cancelled: true });
  const listed = await run(tools.list_sessions, { projectId: "9b1d4e7a" });
  assert.deepEqual(listed.sessions.map((row) => row.id).sort(), [REVIEW, FIRST].sort(), "a project prefix filters, instead of matching nothing");
  assert.equal((await run(tools.get_project, { id: "9b1d4e7a" })).sessions, 2);
  assert.equal((await run(tools.rename_project, { id: "9b1d4e7a", name: "portal-2" })).id, PORTAL);
});

test("an ambiguous or unknown id is an error that says so, never one that reads like a deletion", async () => {
  const { tools, state } = prefixed();
  const ambiguous = await run(tools.get_session, { sessionId: "5e0f" });
  assert.match(ambiguous.error, /^Id "5e0f" is ambiguous: 2 sessions start with it: /);
  assert.ok(ambiguous.error.includes(`${FIRST} ("First")`) && ambiguous.error.includes(`${SECOND} ("Second")`), ambiguous.error);
  assert.match((await run(tools.send_prompt, { sessionId: "5e0f", text: "x" })).error, /ambiguous/);
  assert.deepEqual(state.prompts, [], "nothing was sent to either");

  const unknown = await run(tools.read_transcript, { sessionId: "deadbeef" });
  assert.equal(unknown.error, 'No session has id "deadbeef". Ids in the World section are prefixes; pass one that is unique or the full id, or use resolve_session.');
  assert.doesNotMatch(unknown.error, /delet|No such session/);
  assert.match((await run(tools.get_session, { sessionId: "173" })).error, /pass one of at least 4 characters/, "too short to be a prefix");
  assert.match((await run(tools.list_sessions, { projectId: "deadbeef" })).error, /^No project has id "deadbeef"\. .*resolve_repo/);
  assert.match((await run(tools.get_github_status, { projectId: "deadbeef" })).error, /^No project has id "deadbeef"/);
});

test("create_item and update_item store full ids in links and actions, and refuse ids that name nothing or several", async () => {
  const { tools, store } = prefixed();
  const input = {
    kind: "custom", title: "Review waits", body: "It asks.", fingerprint: "custom:review",
    links: { sessionId: "17329ac6", projectId: "9b1d4e7a" },
    actions: [{ type: "open_session", sessionId: "17329ac6" }, { type: "start_session", projectId: "9b1d4e7a", prompt: "Go" }, { type: "open_url", url: "https://x" }],
  };
  const created = await run(tools.create_item, input);
  assert.equal(created.created, true, created.error);
  const [item] = await store.listItems();
  assert.deepEqual(item.links, { sessionId: REVIEW, projectId: PORTAL });
  assert.deepEqual(item.actions, [{ type: "open_session", sessionId: REVIEW }, { type: "start_session", projectId: PORTAL, prompt: "Go" }, { type: "open_url", url: "https://x" }]);

  assert.match((await run(tools.create_item, { ...input, fingerprint: "custom:other", links: { sessionId: "deadbeef" } })).error, /^links\.sessionId: No session has id "deadbeef"/);
  assert.match((await run(tools.update_item, { id: item.id, actions: [{ type: "send_prompt", sessionId: "5e0f", prompt: "x" }] })).error, /^actions\[0\]\.sessionId: Id "5e0f" is ambiguous/);
  await run(tools.update_item, { id: item.id, links: { sessionId: "5e0f1b2c" } });
  assert.deepEqual((await store.getItem(item.id)).links, { sessionId: FIRST });
  assert.equal((await store.listItems()).length, 1, "the refused ones stored nothing");
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
  const classic = await run(tools.create_item, { ...input, kind: "worktree_dirty", fingerprint: "worktree_dirty:w1" });
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
  deps.sessions.cancel = async (id) => { cancels.push(id); return []; };
  const result = await run(tools.stop_session, { sessionId: "s1" });
  assert.deepEqual(result, { sessionId: "s1", stopped: true, activity: "idle", stopReason: "cancelled" });
  assert.deepEqual(cancels, ["s1"]);
  assert.ok(polls >= 3, "it waited for the session to go idle");

  // Nothing to stop: no cancel is sent.
  assert.deepEqual(await run(tools.stop_session, { sessionId: "s1" }), { sessionId: "s1", stopped: false, activity: "idle", note: "The session had no turn to stop." });
  assert.deepEqual(cancels, ["s1"]);
  assert.match((await run(tools.stop_session, { sessionId: "nope" })).error, /No session has id "nope"/);
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
  assert.match((await run(tools.create_session, { projectId: "zzz" })).error, /No project has id "zzz"/);

  state.promptFailure = "agent not ready";
  const half = await run(tools.create_session, { projectId: "p1", prompt: "Try" });
  assert.deepEqual(half, { sessionId: "s2", promptError: "agent not ready" });
  assert.equal(state.created.length, 2, "the session was created once");
});

test("sessions Portal starts take on the settings the user last left the agent with; a failure to apply never fails the start", async () => {
  const select = (id, category, currentValue, values) => ({ id, category, name: id, type: "select", currentValue, options: values.map((value) => ({ value, name: value })) });
  const fresh = () => ({
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    configOptions: [select("model", "model", "sonnet", ["sonnet", "fable"]), select("effort", "thought_level", "low", ["low"])],
    commands: [],
  });
  const { tools, state, deps } = setup({ projects: [project()] });
  const live = new Map();
  const calls = [];
  const create = deps.sessions.create;
  deps.sessions.create = async (...args) => {
    const meta = { ...(await create(...args)), state: fresh() };
    live.set(meta.id, meta.state);
    return meta;
  };
  deps.sessions.setConfigOption = async (id, configId, value) => {
    calls.push({ id, configId, value });
    const current = live.get(id);
    // A model switch changes the effort choices, as Claude's does.
    const effort = configId === "model" && value === "fable" ? select("effort", "thought_level", "low", ["low", "max"]) : current.configOptions[1];
    const next = { ...current, configOptions: current.configOptions.map((option) => option.id === configId ? { ...option, currentValue: value } : option.id === "effort" ? effort : option) };
    live.set(id, next);
    return next;
  };
  deps.sessions.setMode = async (id, modeId) => {
    calls.push({ id, modeId });
    const next = { ...live.get(id), modes: { ...live.get(id).modes, currentModeId: modeId } };
    live.set(id, next);
    return next;
  };

  // Nothing remembered: the agent's defaults, no requests.
  assert.deepEqual(await run(tools.create_session, { projectId: "p1" }), { sessionId: "s1" });
  assert.deepEqual(calls, []);

  // Claude's record: Fable, max effort (offered only once Fable is on), plan mode; Codex has its own.
  state.lastSettings.claude = {
    modes: { currentModeId: "plan", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    configOptions: [select("model", "model", "fable", ["sonnet", "fable"]), select("effort", "thought_level", "max", ["low", "max"])],
  };
  state.lastSettings.codex = { modes: null, configOptions: [select("model", "model", "sonnet", ["sonnet"])] };
  assert.deepEqual(await run(tools.create_session, { projectId: "p1", prompt: "Go" }), { sessionId: "s2" });
  assert.deepEqual(calls, [
    { id: "s2", configId: "model", value: "fable" },
    { id: "s2", configId: "effort", value: "max" },
    { id: "s2", modeId: "plan" },
  ]);
  assert.deepEqual(state.prompts, [{ id: "s2", text: "Go" }], "the prompt goes out after the settings");

  // An explicit agent uses that agent's record (already matching here: nothing to send).
  calls.length = 0;
  await run(tools.create_session, { projectId: "p1", agentId: "codex" });
  assert.deepEqual(calls, []);

  // The agent refusing a change is logged; the session still starts and gets its prompt.
  deps.sessions.setConfigOption = async () => { throw new Error("agent says no"); };
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    assert.deepEqual(await run(tools.create_session, { projectId: "p1", prompt: "Still" }), { sessionId: "s4" });
  } finally {
    console.error = original;
  }
  assert.match(errors.join("\n"), /Could not apply the last-used settings to session s4: agent says no/);
  assert.deepEqual(state.prompts.at(-1), { id: "s4", text: "Still" });
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
  assert.equal(result.watchId, "i1");
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

  // skipScript leaves the script out and goes straight to git.
  const skipping = setup({
    projects: [project({ id: "p1", path: parentPath }), project({ id: "p5", path: worktreePath, worktree: { parentId: "p1", branch: "feat/s" } })],
    removeWorktree: async () => ({ branchDeleted: false }),
    scripts: { run: async () => { throw new Error("should not run"); } },
  });
  assert.deepEqual(await run(skipping.tools.remove_project, { id: "p5", deleteWorktree: true, skipScript: true }), { id: "p5", removed: true, kept: false, branchDeleted: false });
  assert.deepEqual(skipping.state.removed, [{ id: "p5", keep: false }]);
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

test("session tools report liveness: rows carry the state and its line, get_session the detail from a fresh probe", async () => {
  const now = Date.now();
  const detail = liveness("busy", "running tool: bazel test //... for 45m", {
    turnStartedAt: now - 46 * 60_000, lastOutputAt: now - 45 * 60_000, lastCpuAt: now - 20_000,
    openTools: [{ id: "c1", title: "bazel test //...", kind: "execute", startedAt: now - 45 * 60_000, lastOutputAt: null }],
    process: {
      agentPid: 10, alive: true, scope: "session", rootPid: 20, sampledAt: now - 3_000, windowMs: 300_000, cpuMs: 12_500, childCpuMs: 9_000,
      children: [{ pid: 30, command: "bazel test //...", elapsedMs: 45 * 60_000, cpuMs: 9_000 }],
    },
  });
  const sessions = [
    sessionMeta({ id: "s1", busy: true, liveness: liveness("busy", "stale line") }),
    sessionMeta({ id: "s2", busy: true, liveness: liveness("hung", "hung: no CPU or output for 20m") }),
    sessionMeta({ id: "s3", liveness: liveness("idle") }),
    sessionMeta({
      id: "s4",
      liveness: liveness("background", "1 background task running", { backgroundTasks: [{ id: "task-1", title: "npm run dev", startedAt: now - 120_000, canStop: true }] }),
    }),
  ];
  const { tools, deps } = setup({ sessions });
  const probed = [];
  deps.sessions.liveness = async (id) => { probed.push(id); return id === "s1" ? detail : null; };

  const one = await run(tools.get_session, { sessionId: "s1" });
  assert.deepEqual(probed, ["s1"]);
  assert.equal(one.status, "running tool: bazel test //... for 45m");
  assert.equal(one.liveness.state, "busy");
  assert.equal(one.liveness.stall, false);
  assert.deepEqual(one.liveness.openTools, [{ title: "bazel test //...", kind: "execute", runningForSeconds: 2700, secondsSinceOutput: null }]);
  assert.equal(one.liveness.secondsSinceCpu, 20);
  assert.deepEqual(one.liveness.process.children, [{ pid: 30, command: "bazel test //...", runningForSeconds: 2700 }]);
  assert.equal(one.liveness.process.cpuSeconds, 12.5);
  assert.equal(one.liveness.process.scope, "session");
  assert.equal(one.liveness.hungAfterMinutes, 15);

  // A prefix (as the world shows ids) is resolved before the probe, which only knows full ids.
  sessions.push(sessionMeta({ id: "abcdef12-full-id", busy: true, liveness: liveness("busy", "stale") }));
  deps.sessions.liveness = async (id) => { probed.push(id); return id === "abcdef12-full-id" ? detail : null; };
  assert.equal((await run(tools.get_session, { sessionId: "abcdef12" })).status, "running tool: bazel test //... for 45m");
  assert.equal(probed.at(-1), "abcdef12-full-id");
  sessions.pop();

  const hung = await run(tools.list_sessions, { liveness: "hung" });
  assert.deepEqual(hung.sessions.map((row) => [row.id, row.liveness, row.status]), [["s2", "hung", "hung: no CPU or output for 20m"]]);
  assert.equal((await run(tools.list_sessions, { liveness: "asleep" })).invalidInput, true);
  const active = await run(tools.list_active_sessions, {});
  assert.deepEqual(active.sessions.map((row) => row.id).sort(), ["s1", "s2", "s4"], "a turn that ended with background tasks running is still at work");
  const background = await run(tools.get_session, { sessionId: "s4" });
  assert.equal(background.activity, "working");
  assert.equal(background.liveness.state, "background");
  assert.equal(background.liveness.stall, false);
  assert.deepEqual(background.liveness.backgroundTasks, [{ id: "task-1", title: "npm run dev", runningForSeconds: 120 }]);
  assert.deepEqual((await run(tools.list_sessions, { liveness: "background" })).sessions.map((row) => row.id), ["s4"]);
});

// ---------------------------------------------------------------------------------------------
// Tracked sessions
// ---------------------------------------------------------------------------------------------

test("track_session takes an id prefix, tracks as Portal with the turn's run and thread, and is idempotent", async () => {
  const { tools, hub, activity, events, world } = prefixed();
  const tracked = await run(tools.track_session, { sessionId: "17329ac6" });
  assert.deepEqual(tracked, { sessionId: REVIEW, tracked: true, trackedAt: T0, trackedBy: "portal" });
  assert.deepEqual((await hub.tracked.list()).map((row) => row.sessionId), [REVIEW], "stored with the full id");
  assert.deepEqual(world.tracked, [REVIEW], "the world's set follows at once");
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "session.tracked");
  assert.equal(activity[0].actor, "agent");
  assert.deepEqual(activity[0].refs, { sessionId: REVIEW, projectId: PORTAL, runId: "run1", threadId: "main" });
  assert.equal(events.filter((event) => event.type === "tracked").length, 1);

  const again = await run(tools.track_session, { sessionId: REVIEW });
  assert.equal(again.tracked, true);
  assert.match(again.note, /already tracked/);
  assert.equal(activity.length, 1, "nothing logged the second time");

  assert.match((await run(tools.track_session, { sessionId: "deadbeef" })).error, /^No session has id "deadbeef"/);
  assert.match((await run(tools.track_session, { sessionId: "5e0f" })).error, /ambiguous/);
  assert.equal((await hub.tracked.list()).length, 1);
});

test("untrack_session puts its reason into the activity entry and says when the session was not tracked", async () => {
  const { tools, hub, activity } = prefixed();
  await hub.tracked.track(REVIEW, "user");
  const untracked = await run(tools.untrack_session, { sessionId: "17329ac6", reason: "  review summarized  " });
  assert.deepEqual(untracked, { sessionId: REVIEW, untracked: true });
  const entry = activity.at(-1);
  assert.equal(entry.kind, "session.untracked");
  assert.match(entry.summary, /^Untracked "Review auth": review summarized$/);
  assert.deepEqual(entry.detail, { trackedBy: "portal", reason: "review summarized" });
  assert.equal(entry.refs.runId, "run1");
  assert.deepEqual(await hub.tracked.list(), []);

  const again = await run(tools.untrack_session, { sessionId: REVIEW });
  assert.equal(again.untracked, false);
  assert.match(again.note, /not tracked/);
  assert.match((await run(tools.untrack_session, { sessionId: "deadbeef" })).error, /^No session has id "deadbeef"/);
  assert.equal((await run(tools.untrack_session, { sessionId: REVIEW, reason: "x".repeat(201) })).invalidInput, true);
});

test("list_tracked_sessions answers the world's tracked set with list_sessions' rows plus when and by whom", async () => {
  const { tools, hub, state, world } = prefixed();
  state.sessions[1].liveness = liveness("busy", "running tool: tests for 3m");
  await hub.tracked.track(FIRST, "user");
  await hub.tracked.track(REVIEW, "portal");
  const listed = await run(tools.list_tracked_sessions, {});
  const plain = await run(tools.list_sessions, {});
  assert.deepEqual(listed.sessions.map((row) => row.id), world.tracked);
  for (const row of listed.sessions) {
    const { trackedAt, trackedBy, ...rest } = row;
    assert.deepEqual(rest, plain.sessions.find((entry) => entry.id === row.id), "the same row as list_sessions");
    assert.equal(trackedAt, T0);
    assert.equal(trackedBy, row.id === FIRST ? "user" : "portal");
  }
  assert.equal(listed.sessions.find((row) => row.id === FIRST).liveness, "busy");

  // The world's set decides, so the section and the tool agree even before the next build.
  world.tracked = [REVIEW];
  assert.deepEqual((await run(tools.list_tracked_sessions, {})).sessions.map((row) => row.id), [REVIEW]);
  assert.deepEqual((await run(tools.untrack_session, { sessionId: REVIEW })).untracked, true);
  assert.deepEqual((await run(tools.list_tracked_sessions, {})).sessions, [FIRST].map((id) => ({ ...plain.sessions.find((entry) => entry.id === id), trackedAt: T0, trackedBy: "user" })));
});

test("sessions Portal starts are tracked: create_session and each of setup_pr_reviews' sessions", async () => {
  const { tools, hub, activity } = setup({
    projects: [project()],
    getPull: async (repoRoot, number) => ({ number, title: `PR ${number}`, branch: `feat/${number}`, state: "open", updatedAt: T0, fork: false, author: "moses-lee" }),
    ensureWorktree: async ({ branch }) => ({ path: `/wt/${branch}`, created: true }),
    originUrl: async (dir) => (dir === "/repo" ? "git@github.com:acme/app.git" : null),
  });
  const created = await run(tools.create_session, { projectId: "p1", prompt: "Say hi" });
  assert.deepEqual(await hub.tracked.list(), [{ sessionId: created.sessionId, trackedAt: T0, trackedBy: "portal" }]);
  assert.deepEqual(activity[0].refs, { sessionId: created.sessionId, projectId: "p1", runId: "run1", threadId: "main" });

  const reviews = await run(tools.setup_pr_reviews, { repo: "acme/app", numbers: [3, 4] });
  const ids = reviews.sessions.map((entry) => entry.sessionId);
  assert.equal(ids.length, 2);
  assert.deepEqual((await hub.tracked.list()).map((row) => row.sessionId), [created.sessionId, ...ids]);
  assert.ok((await hub.tracked.list()).every((row) => row.trackedBy === "portal"));
  assert.deepEqual(activity.filter((entry) => entry.kind === "session.tracked").map((entry) => entry.detail.reason ?? null), [null, "review of acme/app#3", "review of acme/app#4"]);
});

test("a session Portal starts is still started when tracking it fails", async () => {
  const { tools, hub, state } = setup({ projects: [project()] });
  hub.tracked.track = async () => { throw new Error("db down"); };
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.deepEqual(await run(tools.create_session, { projectId: "p1", prompt: "Go" }), { sessionId: "s1" });
  } finally {
    console.error = original;
  }
  assert.deepEqual(state.prompts, [{ id: "s1", text: "Go" }]);
  assert.match(errors[0], /Could not track session s1: db down/);
});

test("a session whose first prompt fails is still tracked, and the prompt error is returned", async () => {
  const { tools, hub, state } = setup({ projects: [project()] });
  state.promptFailure = "agent not ready";
  assert.deepEqual(await run(tools.create_session, { projectId: "p1", prompt: "Go" }), { sessionId: "s1", promptError: "agent not ready" });
  assert.deepEqual(await hub.tracked.list(), [{ sessionId: "s1", trackedAt: T0, trackedBy: "portal" }]);
});

test("delete_session untracks first, so the activity log shows the untrack before the delete", async () => {
  const { tools, hub, deps, activity } = prefixed();
  await hub.tracked.track(REVIEW, "user");
  const remove = deps.sessions.remove;
  let loggedBeforeRemove = null;
  deps.sessions.remove = async (id) => {
    loggedBeforeRemove = activity.map((entry) => entry.kind);
    return remove(id);
  };
  assert.deepEqual(await run(tools.delete_session, { sessionId: "17329ac6" }), { sessionId: REVIEW, deleted: true });
  assert.deepEqual(loggedBeforeRemove, ["session.tracked", "session.untracked"]);
  assert.deepEqual(activity.at(-1).detail, { trackedBy: "portal", reason: "deleted" });
  assert.deepEqual(await hub.tracked.list(), []);
  // An untracked session is deleted without an untrack entry.
  await run(tools.delete_session, { sessionId: FIRST });
  assert.equal(activity.filter((entry) => entry.kind === "session.untracked").length, 1);
});

test("rename_session takes an id prefix, renames as Portal, logs session.renamed, and answers the row", async () => {
  const { tools, state, activity } = prefixed();
  const renamed = await run(tools.rename_session, { sessionId: "17329ac6", title: "  Auth review: token refresh  " });
  assert.equal(renamed.id, REVIEW);
  assert.equal(renamed.title, "Auth review: token refresh");
  assert.equal(renamed.titleSource, "portal");
  assert.equal(renamed.projectId, PORTAL);
  const stored = state.sessions.find((meta) => meta.id === REVIEW);
  assert.deepEqual([stored.title, stored.titleSource], ["Auth review: token refresh", "portal"]);
  const entry = activity.at(-1);
  assert.equal(entry.kind, "session.renamed");
  assert.equal(entry.actor, "agent");
  assert.equal(entry.summary, 'Renamed "Review auth" to "Auth review: token refresh"');
  assert.deepEqual(entry.refs, { sessionId: REVIEW, projectId: PORTAL, runId: "run1", threadId: "main" });
  assert.deepEqual(entry.detail, { from: "Review auth", to: "Auth review: token refresh", titleSource: "portal" });

  // The same title again changes nothing and logs nothing.
  const same = await run(tools.rename_session, { sessionId: REVIEW, title: "Auth review: token refresh" });
  assert.match(same.note, /already had that title/);
  assert.equal(activity.filter((row) => row.kind === "session.renamed").length, 1);

  assert.equal((await run(tools.rename_session, { sessionId: REVIEW, title: "   " })).invalidInput, true);
  assert.equal((await run(tools.rename_session, { sessionId: REVIEW, title: "x".repeat(121) })).invalidInput, true);
  assert.match((await run(tools.rename_session, { sessionId: "deadbeef", title: "Nope" })).error, /^No session has id "deadbeef"/);
});

test("rename_session refuses a session the user named and says so", async () => {
  const { tools, state, activity } = prefixed();
  state.sessions[0] = { ...state.sessions[0], title: "My auth thing", titleSource: "user" };
  const refused = await run(tools.rename_session, { sessionId: REVIEW, title: "Auth review" });
  assert.match(refused.error, /The user named this session "My auth thing"/);
  assert.equal(state.sessions[0].title, "My auth thing");
  assert.deepEqual(activity.filter((row) => row.kind === "session.renamed"), []);
});

test("rename_session is a chat-turn tool in the sessions group, never in a background turn, and ungated", async () => {
  assert.ok(TOOL_GROUPS.sessions.tools.includes("rename_session"));
  assert.ok(!GATED_TOOLS.includes("rename_session"));
  assert.ok(!BACKGROUND_TOOLS.includes("rename_session"));
  assert.ok(setup().tools.rename_session, "a chat turn has it");
  // A job's run that names its own tools is offered everything else interactively, but not renaming.
  const { deps } = fakeDeps({});
  const jobCtx = { store: createMemoryOrchestratorStore(), deps, touched: new Set(), settings: fakeSettings(), interactive: true, now: () => T0,
    hub: { deps, activity: { log: async () => {} }, tracked: {} }, turn: { runId: "run1", threadId: null, kind: "job", origin: "job" } };
  assert.equal(createTools(jobCtx).rename_session, undefined);
  assert.ok(createTools(jobCtx).create_session, "the rest of the session tools are there");
});

test("create_session with a title names the session as Portal's", async () => {
  const { tools, state } = setup({ projects: [project()] });
  assert.deepEqual(await run(tools.create_session, { projectId: "p1", title: "  Fix flaky login test  ", prompt: "The login test fails one run in ten" }), { sessionId: "s1" });
  assert.deepEqual([state.created[0].title, state.created[0].titleSource], ["Fix flaky login test", "portal"]);
  await run(tools.create_session, { projectId: "p1" });
  assert.deepEqual([state.created[1].title, state.created[1].titleSource], [null, "prompt"]);
  assert.equal((await run(tools.create_session, { projectId: "p1", title: "x".repeat(121) })).invalidInput, true);
});

test("the system prompt asks to name sessions on create and never rename one the user named", () => {
  const prompt = systemPrompt({ login: "moses-lee", now: T0, memory: "" });
  assert.match(prompt, /Name sessions you start for what they are for \(title on create_session\); rename a session when its title no longer says what it does \(rename_session\)\. Never rename a session the user named\./);
});

test("create_item and update_item refuse the retired session kinds and point at track_session", async () => {
  const { tools, store } = setup();
  for (const kind of ["session_finished", "session_stopped", "session_waiting", "session_offline", "session_hung"]) {
    const refused = await run(tools.create_item, { kind, title: "Session done", body: "It finished.", fingerprint: `${kind}:s1` });
    assert.equal(refused.invalidInput, true, kind);
    assert.match(refused.error, new RegExp(`^kind: ${kind} items are retired: .*\\(use track_session in a chat turn\\); nothing to raise\\.$`), kind);
  }
  assert.deepEqual(await store.listItems(), []);
  const { id } = await run(tools.create_item, { kind: "custom", title: "Keep", body: "", fingerprint: "custom:keep" });
  assert.match((await run(tools.update_item, { id, kind: "session_hung" })).error, /session_hung items are retired/);
  assert.equal((await store.getItem(id)).kind, "custom");
  assert.match((await run(tools.create_item, { kind: "nonsense", title: "x", body: "", fingerprint: "custom:x" })).error, /Invalid option/, "any other bad kind keeps the usual error");
  const schema = JSON.stringify(z.toJSONSchema(tools.create_item.inputSchema));
  assert.match(schema, /"custom"/);
  assert.doesNotMatch(schema, /session_waiting/, "the model is not offered the retired kinds");
});
