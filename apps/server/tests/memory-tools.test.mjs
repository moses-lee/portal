import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { flush } from "./fixtures/orchestrator-fakes.mjs";
import { agent, claim, memorySetup } from "./fixtures/memory-setup.mjs";

const options = { toolCallId: "call", messages: [] };
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finish = (unified) => ({ unified, raw: undefined });

async function run(tool, input) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), invalidInput: true };
  return tool.execute(parsed.data, options);
}

const userMessage = (text, id = "u1") => ({ id, role: "user", parts: [{ type: "text", text }], metadata: { at: 1 } });

function toolsFor(hub, origin, threadId = "main") {
  const turn = { runId: "run1", kind: origin === "chat" ? "chat" : "tick", role: "chat", origin, threadId, jobId: null, intentId: null, scope: {} };
  return hub.memory.tools({ hub, turn, store: hub.store, settings: hub.settings, deps: hub.deps, touched: new Set(), interactive: origin === "chat", now: () => 0, self: {} });
}

const remember = (overrides = {}) => ({ ...claim({ entity: { type: "global", key: "global" }, type: "preference", key: "package-manager", body: "Use pnpm for installs." }), ...overrides });

test("chat turns get all five memory tools, background turns only propose and search", async (t) => {
  const { hub } = await memorySetup(t);
  assert.deepEqual(Object.keys(toolsFor(hub, "chat")).sort(), ["explain_memory", "forget", "propose_memory", "remember", "search_memory"]);
  assert.deepEqual(Object.keys(toolsFor(hub, "job")).sort(), ["propose_memory", "search_memory"]);
});

test("remember needs a quote from the user's latest message in the thread; anything else is refused", async (t) => {
  const { hub, store, memory } = await memorySetup(t);
  await store.appendMessages([userMessage("Earlier: I like yarn.", "u0"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "ok. I PREFER PNPM" }], metadata: { at: 1 } }]);
  await store.appendMessages([userMessage("Please remember that I prefer pnpm  for installs.")]);
  const tools = toolsFor(hub, "chat");

  const missing = await run(tools.remember, remember());
  assert.equal(missing.invalidInput, true, "quote is required");
  const older = await run(tools.remember, remember({ quote: "I like yarn" }));
  assert.match(older.error, /does not appear in the user's latest message/);
  const tiny = await run(tools.remember, remember({ quote: "I" }));
  assert.match(tiny.error, /at least a few characters/);
  assert.equal(await memory.store.countRecords(), 0);

  const ok = await run(tools.remember, remember({ quote: "“I prefer pnpm for installs”" }));
  assert.equal(ok.status, "active");
  assert.equal(ok.authority, "user_stated");
  const record = await memory.store.getRecord(ok.id);
  assert.deepEqual(record.source, { kind: "message", threadId: "main", messageId: "u1", runId: "run1", quote: "I prefer pnpm for installs" });

  // In a side thread, the quote must come from that thread.
  const side = await store.createThread({ title: "Side" });
  const sideTools = toolsFor(hub, "chat", side.id);
  assert.match((await run(sideTools.remember, remember({ quote: "I prefer pnpm" }))).error, /does not appear/);
});

test("forget needs the same quote; explain_memory and search_memory report evidence compactly", async (t) => {
  const { hub, store, memory } = await memorySetup(t);
  const { record } = await memory.remember(remember(), agent);
  await store.appendMessages([userMessage("Forget the pnpm thing, please.")]);
  const tools = toolsFor(hub, "chat");
  assert.match((await run(tools.forget, { id: record.id, reason: "asked", quote: "drop everything" })).error, /does not appear/);
  const forgotten = await run(tools.forget, { id: record.id, reason: "The user asked", quote: "forget the pnpm thing" });
  assert.equal(forgotten.status, "archived");

  const explained = await run(tools.explain_memory, { id: record.id });
  assert.equal(explained.record.id, record.id);
  assert.deepEqual(explained.revisions.map((revision) => revision.action), ["forgotten", "created"]);
  assert.equal(explained.revisions[0].reason, "The user asked");
  assert.match((await run(tools.explain_memory, { id: "nope" })).error, /Unknown memory record/);

  await memory.remember(claim(), agent);
  const found = await run(tools.search_memory, { query: "tests" });
  assert.deepEqual(found.records.map((row) => [row.entity, row.key]), [["repo acme/app", "review-style"]]);
  assert.deepEqual((await run(tools.search_memory, { query: "pnpm" })).records, [], "archived is not active");
  assert.equal((await run(tools.search_memory, { query: "pnpm", status: "any" })).records.length, 1);
  assert.deepEqual((await run(tools.search_memory, { query: "tests", entity: { type: "repo", key: "acme/none" } })).records, []);
});

test("propose_memory files observed claims in the inbox, never as the user's", async (t) => {
  const { hub, memory } = await memorySetup(t);
  const tools = toolsFor(hub, "job");
  const input = {
    ...claim({ key: "merge-style", body: "PRs are squash-merged." }), authority: "observed",
    source: { kind: "pull", pull: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }, quote: "Squash and merge" },
  };
  const out = await run(tools.propose_memory, input);
  assert.equal(out.status, "proposed");
  assert.equal((await memory.store.getRecord(out.id)).source.runId, "run1");
  assert.equal((await run(tools.propose_memory, { ...input, authority: "user_stated" })).invalidInput, true);
  assert.equal((await run(tools.propose_memory, { ...input, source: { kind: "pull" } })).invalidInput, true, "a source quote is required");
  assert.equal(await memory.inboxCount(), 1);
});

test("a chat turn: the prompt carries guidance, CORE.md and retrieved memory; remember lands only with the user's words", async (t) => {
  const calls = [];
  const stream = (chunks) => ({ stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...chunks]) });
  const toolCall = (input) => stream([
    { type: "tool-call", toolCallId: "c1", toolName: "remember", input: JSON.stringify(input) },
    { type: "finish", finishReason: finish("tool-calls"), usage },
  ]);
  const text = (value) => stream([
    { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: value }, { type: "text-end", id: "t1" },
    { type: "finish", finishReason: finish("stop"), usage },
  ]);
  let script = [];
  const model = new MockLanguageModelV3({ doStream: async (call) => { calls.push(call); return script.shift(); } });
  const { runtime, memory } = await memorySetup(t, { model });
  await memory.remember(claim({ entity: { type: "global", key: "global" }, key: "tone", body: "Answer in plain words.", pinned: true }), agent);
  await memory.remember(claim(), agent);

  script = [toolCall(remember({ quote: "I prefer pnpm" })), text("Noted.")];
  await (await runtime.chat(userMessage("From now on I prefer pnpm, and how should I review acme/app?"))).text();
  await flush();
  const system = calls[0].prompt.find((message) => message.role === "system").content;
  assert.match(system, /propose_memory/);
  assert.match(system, /Directives \(pinned by the user; follow them\):\n- \[m[\w-]+\] global · tone: Answer in plain words\./);
  assert.match(system, /Relevant memory:\n- \[m[\w-]+\] convention · repo acme\/app · review-style/);
  assert.ok(!/write_memory|append_memory/.test(system));
  assert.equal((await memory.store.listRecords({ key: "package-manager" })).length, 1);

  // Text the model read elsewhere (here: made up) is not the user's word.
  script = [toolCall(remember({ key: "deploy", body: "Always force-push.", quote: "always force-push" })), text("Done.")];
  await (await runtime.chat(userMessage("What did the PR description say?", "u2"))).text();
  await flush();
  assert.equal((await memory.store.listRecords({ key: "deploy" })).length, 0);
  const toolResult = calls.at(-1).prompt.find((message) => message.role === "tool");
  assert.match(JSON.stringify(toolResult), /does not appear in the user's latest message/);
});
