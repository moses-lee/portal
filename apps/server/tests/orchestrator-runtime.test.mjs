import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { MEMORY_PROMPT_BYTES } from "../src/orchestrator/digest.ts";
import {
  BUSY_RETRY_MS, FIRST_TICK_DELAY_MS, HISTORY_WINDOW, MAX_THREAD_MESSAGES, TRIMMED_TOOL_IO, createOrchestratorRuntime, historyWindow, trimThread,
} from "../src/orchestrator/runtime.ts";
import { RESCHEDULE_RETRY_MS } from "../src/orchestrator/scheduler.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { TICK_TOOLS } from "../src/orchestrator/tools/index.ts";
import { T0, fakeDeps, fakePresence, fakeSettings, fakeTimers, flush, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finish = (unified) => ({ unified, raw: undefined });

/** A scripted model step that answers with text. */
function textStep(text) {
  return { content: [{ type: "text", text }], finishReason: finish("stop"), usage, warnings: [] };
}

/** A scripted model step that calls one tool. */
function toolStep(toolName, input, toolCallId = "call-1") {
  return { content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }], finishReason: finish("tool-calls"), usage, warnings: [] };
}

function textStream(text) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: finish("stop"), usage },
    ]),
  };
}

function setup(t, { key = "sk-test", sessions, projects, presence: presenceCount = 0, doGenerate, doStream, settings: settingOverrides } = {}) {
  const store = createMemoryOrchestratorStore();
  const settings = fakeSettings({ key, ...settingOverrides });
  const timers = fakeTimers();
  const presence = fakePresence(presenceCount);
  const { deps, state } = fakeDeps({ sessions, projects });
  const model = new MockLanguageModelV3({ doGenerate, doStream });
  const events = [];
  const runtime = createOrchestratorRuntime({ store, settingsStore: settings, deps, timers, presence, model: () => model });
  runtime.subscribe((event) => events.push(event));
  t.after(() => runtime.dispose());
  return { runtime, store, settings, timers, presence, deps, state, model, events };
}

const userMessage = (text, id = "u1") => ({ id, role: "user", parts: [{ type: "text", text }] });

const waitingSession = () => sessionMeta({ awaitingPermission: true });

const itemInput = {
  list: "needs_you", kind: "session_waiting", title: "Session needs your approval", body: "The agent asked to run a command.",
  links: { sessionId: "s1", projectId: "p1" }, actions: [{ type: "open_session", sessionId: "s1", label: "Open" }], fingerprint: "session_waiting:s1",
};

/** A stored message with a text part and one finished tool call. */
function storedMessage(i, role = i % 2 ? "assistant" : "user") {
  const parts = [{ type: "text", text: `message ${i}` }];
  if (role === "assistant") {
    parts.push({ type: "tool-list_sessions", toolCallId: `call-${i}`, state: "output-available", input: { limit: 5 }, output: { sessions: [{ id: "s1" }], truncated: false } });
  }
  return { id: `m${i}`, role, parts, metadata: { at: T0 - (1000 - i) * 1000 } };
}

test("without an API key the runtime is not ready: chat is refused with 409 and the scheduler plans nothing", async (t) => {
  const { runtime, settings, timers } = setup(t, { key: null });
  await runtime.ready;
  await flush();
  const status = await runtime.status();
  assert.equal(status.ready, false);
  assert.equal(status.busy, false);
  assert.equal(status.nextTickAt, null);
  assert.equal(timers.pending.length, 0, "no tick is planned");
  await assert.rejects(runtime.chat(userMessage("hi")), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /API key/);
    return true;
  });
  assert.deepEqual(await runtime.history(), [], "the refused message is not stored");

  // Adding a key through settings makes the scheduler plan the first tick a minute after start.
  await settings.change({ apiKey: "sk-new" });
  await flush();
  assert.equal((await runtime.status()).ready, true);
  assert.equal((await runtime.status()).nextTickAt, T0 + FIRST_TICK_DELAY_MS);
  assert.equal(timers.pending.length, 1);
});

test("a tick with an empty digest skips the model and still writes the snapshot and a report", async (t) => {
  const { runtime, store, model, events } = setup(t, { sessions: [sessionMeta()] });
  const report = await runtime.runTick("manual");
  assert.equal(report.reason, "manual");
  assert.equal(report.modelInvoked, false);
  assert.equal(report.changes, 0);
  assert.equal(report.error, null);
  assert.equal(report.usage, null);
  assert.ok(report.log.some((line) => /not invoked/.test(line)), report.log.join("\n"));
  assert.equal(model.doGenerateCalls.length, 0);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.sessions.s1.activity, "idle");
  assert.equal(snapshot.sessions.s1.link, "live");
  assert.deepEqual((await store.listTicks()).map((entry) => entry.id), [report.id]);
  assert.deepEqual(await runtime.history(), []);
  assert.equal((await runtime.status()).lastTick.id, report.id);
  assert.ok(events.some((event) => event.type === "tick" && event.report.id === report.id));
  assert.ok(events.some((event) => event.type === "status"));
});

test("a tick with a change runs the model with the tick tool subset; its create_item call and note land in the store with tick metadata", async (t) => {
  const { runtime, store, model, events } = setup(t, {
    sessions: [waitingSession()],
    doGenerate: [toolStep("create_item", itemInput), textStep("Session s1 is waiting for your approval.")],
  });
  const report = await runtime.runTick("schedule");
  assert.equal(report.error, null, report.log.join("\n"));
  assert.equal(report.modelInvoked, true);
  assert.equal(report.changes, 1);
  assert.equal(model.doGenerateCalls.length, 2);
  // The digest (with the fingerprint the model must copy) is the tick's only user message; no history is sent.
  const first = model.doGenerateCalls[0];
  const userMessages = first.prompt.filter((message) => message.role === "user");
  assert.equal(userMessages.length, 1);
  assert.match(JSON.stringify(userMessages[0]), /session_waiting:s1/);
  assert.equal(first.prompt.filter((message) => message.role === "system").length, 1);
  // Ticks only get the item, watch, memory, and read-only tools: schemas are re-sent on every step.
  assert.deepEqual(first.tools.map((tool) => tool.name).sort(), [...TICK_TOOLS].sort());
  assert.ok(!first.tools.some((tool) => /run_command|delete_session|remove_project|send_prompt|create_session/.test(tool.name)));

  const items = await store.listItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].fingerprint, "session_waiting:s1");
  assert.equal(items[0].status, "open");
  assert.deepEqual(report.itemsCreated, [items[0].id]);
  assert.deepEqual(report.usage, { inputTokens: 20, outputTokens: 10 });

  const messages = await runtime.history();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "Session s1 is waiting for your approval." }]);
  assert.deepEqual(messages[0].metadata.tick, { id: report.id, reason: "schedule" });
  assert.deepEqual(messages[0].metadata.itemIds, [items[0].id]);
  assert.equal(typeof messages[0].metadata.at, "number");
  assert.ok(events.some((event) => event.type === "messages"));
  assert.ok(events.some((event) => event.type === "items" && event.items.length === 1));
  assert.equal((await runtime.status()).openItems.needs_you, 1);

  // The next tick sees the same condition with an open item and nothing new: no model call.
  const quiet = await runtime.runTick("schedule");
  assert.equal(quiet.modelInvoked, false);
  assert.equal(model.doGenerateCalls.length, 2);
});

test("a NO_UPDATE reply appends no message", async (t) => {
  const { runtime, model } = setup(t, { sessions: [waitingSession()], doGenerate: [textStep("NO_UPDATE")] });
  const report = await runtime.runTick("manual");
  assert.equal(report.modelInvoked, true);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.deepEqual(await runtime.history(), []);
  assert.ok(report.log.some((line) => /NO_UPDATE/.test(line)));
});

test("a model failure is reported, not thrown, and the snapshot is kept for the next tick to retry", async (t) => {
  const { runtime, store } = setup(t, {
    sessions: [waitingSession()],
    doGenerate: async () => { throw new Error("provider down"); },
  });
  const report = await runtime.runTick("manual");
  assert.match(report.error, /provider down/);
  assert.equal(report.modelInvoked, true);
  assert.equal(await store.readSnapshot(), null);
  assert.equal((await store.listTicks()).length, 1);
  assert.equal((await runtime.status()).busy, false);
});

test("the scheduler uses the idle interval with no browser and the active one with one, and moves earlier when settings shrink", async (t) => {
  const { runtime, timers, presence, settings, store } = setup(t, { settings: { intervalMinutes: 10, idleIntervalMinutes: 60 } });
  await runtime.ready;
  await flush();
  assert.equal((await runtime.status()).nextTickAt, T0 + FIRST_TICK_DELAY_MS);

  await timers.advance(FIRST_TICK_DELAY_MS);
  const ticks = await store.listTicks();
  assert.equal(ticks.length, 1, "the first tick ran");
  assert.equal(ticks[0].reason, "schedule");
  const end = ticks[0].finishedAt;
  assert.equal((await runtime.status()).nextTickAt, end + 60 * 60_000, "idle interval while nobody is connected");

  presence.set(1);
  await flush();
  assert.equal((await runtime.status()).presence, 1);
  assert.equal((await runtime.status()).nextTickAt, end + 10 * 60_000, "active interval once a browser is present");

  await settings.change({ intervalMinutes: 5 });
  await flush();
  assert.equal((await runtime.status()).nextTickAt, end + 5 * 60_000, "a shorter interval moves the tick earlier");
  assert.equal(timers.pending.length, 1, "one timer at a time");

  presence.set(0);
  await flush();
  assert.equal((await runtime.status()).nextTickAt, end + 60 * 60_000);

  await timers.advance(60 * 60_000);
  assert.equal((await store.listTicks()).length, 2);
});

test("a settings read that fails while planning the next tick is logged and retried, not left unhandled", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { runtime, timers, presence, settings, store } = setup(t);
  await runtime.ready;
  await flush();
  assert.equal((await runtime.status()).nextTickAt, T0 + FIRST_TICK_DELAY_MS);

  // Postgres goes away for one read: the reschedule a new browser triggers fails.
  const orchestrator = settings.orchestrator;
  settings.orchestrator = async () => {
    settings.orchestrator = orchestrator;
    throw new Error("connect ECONNREFUSED 127.0.0.1:5433");
  };
  presence.set(1);
  await flush();
  assert.ok(logged.mock.calls.some((call) => /next Portal tick/.test(call.arguments[0]) && /ECONNREFUSED/.test(call.arguments[1]?.message)));
  assert.equal((await runtime.status()).nextTickAt, null, "no plan while settings cannot be read");
  assert.deepEqual(timers.pending.map((handle) => handle.at), [T0 + RESCHEDULE_RETRY_MS], "only the retry is pending");

  await timers.advance(RESCHEDULE_RETRY_MS);
  assert.equal((await runtime.status()).nextTickAt, T0 + FIRST_TICK_DELAY_MS, "the retry restored the plan");
  await timers.advance(FIRST_TICK_DELAY_MS - RESCHEDULE_RETRY_MS);
  assert.equal((await store.listTicks()).length, 1, "and the scheduled tick ran");
});

test("a manual tick reschedules: the status pushed at its end already carries the next tick time", async (t) => {
  const { runtime, timers, events } = setup(t, { settings: { idleIntervalMinutes: 60 } });
  await runtime.ready;
  await flush();
  timers.tick(5_000);
  const report = await runtime.runTick("manual");
  assert.equal(report.finishedAt, T0 + 5_000);
  assert.equal((await runtime.status()).nextTickAt, report.finishedAt + 60 * 60_000);
  assert.equal(timers.pending.length, 1);
  await flush();
  const pushed = events.findLast((event) => event.type === "status");
  assert.equal(pushed.status.nextTickAt, report.finishedAt + 60 * 60_000);
  assert.equal(pushed.status.lastTick.id, report.id);
});

test("chat persists the user message at once and the assistant message, with its own time, when the stream finishes", async (t) => {
  let timers;
  const { runtime, store, model, events, ...rest } = setup(t, {
    doStream: async () => {
      timers.tick(1_500);
      return textStream("Hello from Portal.");
    },
  });
  timers = rest.timers;
  const response = await runtime.chat(userMessage("Hi there"));
  assert.equal(response.status, 200);
  assert.equal((await store.readMessages()).length, 1, "the user message is stored before the stream is consumed");
  assert.equal((await runtime.status()).busy, true);

  const body = await response.text();
  assert.match(body, /Hello from Portal\./);
  await flush();

  const messages = await runtime.history();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].id, "u1");
  assert.equal(messages[0].metadata.at, T0);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].parts.filter((part) => part.type === "text").map((part) => part.text).join(""), "Hello from Portal.");
  assert.equal(messages[1].metadata.at, T0 + 1_500, "stamped when the answer finished, not when the question was asked");
  assert.deepEqual(messages[1].metadata.itemIds, []);
  assert.equal(messages[1].metadata.tick, undefined);
  assert.equal((await runtime.status()).busy, false);
  assert.ok(events.some((event) => event.type === "messages"));

  // The model saw the system prompt, every tool, and the user's text, not a tick digest.
  const call = model.doStreamCalls[0];
  assert.match(JSON.stringify(call.prompt), /Hi there/);
  assert.match(JSON.stringify(call.prompt.find((message) => message.role === "system")), /Portal's assistant/);
  assert.ok(call.tools.length > TICK_TOOLS.length, "chat gets every tool");
  assert.ok(call.tools.some((tool) => tool.name === "run_command"));
});

test("chat caps the memory it puts in the system prompt", async (t) => {
  const { runtime, store, model } = setup(t, { doStream: textStream("ok") });
  await store.writeMemory(`${"m".repeat(MEMORY_PROMPT_BYTES + 500)} TAIL-MARKER`);
  const response = await runtime.chat(userMessage("hi"));
  await response.text();
  await flush();
  const system = model.doStreamCalls[0].prompt.find((message) => message.role === "system").content;
  assert.ok(!system.includes("TAIL-MARKER"));
  assert.match(system, /\[truncated\]/);
  assert.ok(Buffer.byteLength(system, "utf8") < MEMORY_PROMPT_BYTES + 2500);
});

test("the history window sent to the model starts at a user message", async (t) => {
  const { runtime, store, model } = setup(t, { doStream: textStream("ok") });
  // A thread of nothing but tick notes: the window would begin with an assistant message.
  await store.writeMessages(Array.from({ length: HISTORY_WINDOW - 1 }, (_, i) => storedMessage(i, "assistant")));
  const response = await runtime.chat(userMessage("hi", "new"));
  await response.text();
  await flush();
  const prompt = model.doStreamCalls[0].prompt.filter((message) => message.role !== "system");
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0].role, "user");

  const messages = [storedMessage(0, "assistant"), storedMessage(1, "assistant"), storedMessage(2, "user"), storedMessage(3, "assistant")];
  assert.deepEqual(historyWindow(messages).map((message) => message.id), ["m2", "m3"]);
  assert.deepEqual(historyWindow(messages.slice(2)).map((message) => message.id), ["m2", "m3"]);
  assert.equal(historyWindow(messages.slice(0, 2)).length, 2, "without any user message the window is kept as it is");
});

test("after a turn the stored thread is capped and older tool traffic is replaced by a placeholder", async (t) => {
  const { runtime, store } = setup(t, { doStream: textStream("ok") });
  const seeded = MAX_THREAD_MESSAGES + 30;
  await store.writeMessages(Array.from({ length: seeded }, (_, i) => storedMessage(i)));
  const response = await runtime.chat(userMessage("hi", "new"));
  await response.text();
  await flush();

  const messages = await runtime.history();
  assert.equal(messages.length, MAX_THREAD_MESSAGES);
  assert.equal(messages.at(-1).role, "assistant");
  assert.equal(messages.at(-2).id, "new");
  assert.equal(messages[0].id, `m${seeded + 2 - MAX_THREAD_MESSAGES}`, "the oldest messages were dropped");

  const outside = messages.slice(0, MAX_THREAD_MESSAGES - HISTORY_WINDOW);
  const inside = messages.slice(MAX_THREAD_MESSAGES - HISTORY_WINDOW);
  for (const message of outside) {
    for (const part of message.parts) {
      if (part.type !== "tool-list_sessions") continue;
      assert.equal(part.input, TRIMMED_TOOL_IO);
      assert.equal(part.output, TRIMMED_TOOL_IO);
      assert.equal(part.state, "output-available", "state stays so the UI shows the tool ran");
      assert.ok(part.toolCallId);
    }
    assert.equal(message.parts[0].text, `message ${message.id.slice(1)}`, "text parts are untouched");
  }
  const intact = inside.filter((message) => message.parts.some((part) => part.type === "tool-list_sessions"));
  assert.ok(intact.length > 0);
  for (const message of intact) assert.deepEqual(message.parts[1].input, { limit: 5 });

  // Trimming is idempotent and reports when nothing changed.
  const again = trimThread(messages);
  assert.equal(again.changed, false);
  assert.deepEqual(again.messages, messages);
  assert.equal(trimThread([]).changed, false);
});

test("a tick runs while a chat turn is answering; a tick that finds another tick running is skipped and retried a minute later", async (t) => {
  let releaseChat;
  let releaseTick;
  const { runtime, timers } = setup(t, {
    sessions: [waitingSession()],
    doStream: () => new Promise((resolve) => { releaseChat = () => resolve(textStream("done")); }),
    doGenerate: () => new Promise((resolve) => { releaseTick = () => resolve(textStep("NO_UPDATE")); }),
  });
  await runtime.ready;
  const pending = runtime.chat(userMessage("work"));
  await flush();
  assert.deepEqual((await runtime.status()).busyThreads, ["main"]);
  // The chat turn holds the main thread only: the tick goes ahead and reaches the model.
  const first = runtime.runTick("manual");
  await flush();
  const second = await runtime.runTick("schedule");
  assert.equal(second.error, "busy");
  assert.equal(second.modelInvoked, false);
  await flush();
  assert.equal((await runtime.status()).nextTickAt, timers.now() + BUSY_RETRY_MS);
  releaseTick();
  const report = await first;
  assert.equal(report.error, null);
  assert.equal(report.modelInvoked, true);
  releaseChat();
  await (await pending).text();
  await flush();
  const status = await runtime.status();
  assert.equal(status.busy, false);
  assert.deepEqual(status.busyThreads, []);
});

test("each thread has its own lock: a side thread answers while main is busy, a second turn in a busy thread is refused, and cancel stops only its thread", async (t) => {
  const { runtime, store } = setup(t, {
    doStream: ({ abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason ?? new Error("aborted")));
    }),
  });
  await runtime.ready;
  const side = await store.createThread({ title: "Review acme/app#7", scope: { pulls: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }] } });
  const main = await runtime.chat(userMessage("main work", "m1"));
  const other = await runtime.chat(userMessage("side work", "s1"), side.id);
  await flush();
  assert.deepEqual((await runtime.status()).busyThreads.sort(), ["main", side.id].sort());
  await assert.rejects(runtime.chat(userMessage("again", "m2")), (err) => err.status === 409);
  runtime.cancel(side.id);
  await other.text().catch(() => {});
  await flush();
  assert.deepEqual((await runtime.status()).busyThreads, ["main"]);
  assert.deepEqual((await runtime.history(side.id)).map((message) => message.parts[0].text), ["side work"]);
  assert.deepEqual((await runtime.history()).map((message) => message.parts[0].text), ["main work"]);
  runtime.cancel();
  await main.text().catch(() => {});
  await flush();
  assert.deepEqual((await runtime.status()).busyThreads, []);
  await assert.rejects(runtime.chat(userMessage("nowhere", "x1"), "no-such-thread"), (err) => err.status === 404);
});

test("chat turns and ticks are recorded as runs and the turn's tool calls land in the activity log", async (t) => {
  const { runtime, store, events } = setup(t, {
    doStream: textStream("Two items are open."),
  });
  await runtime.ready;
  await store.createItem(itemInput);
  await (await runtime.chat(userMessage("what is open?"))).text();
  await flush();
  const runs = events.filter((event) => event.type === "run").map((event) => event.run);
  assert.deepEqual(runs.map((run) => [run.kind, run.status]), [["chat", "running"], ["chat", "succeeded"]]);
  assert.equal(runs[1].usage.inputTokens, 10);
  const entries = await runtime.hub.activity.list();
  assert.equal(entries[0].kind, "chat.turn");
  assert.equal(entries[0].refs.runId, runs[0].id);
  const [assistant] = (await runtime.history()).filter((message) => message.role === "assistant");
  assert.equal(assistant.metadata.run.id, runs[0].id);
});

test("cancel() aborts the running chat turn and releases busy", async (t) => {
  const { runtime } = setup(t, {
    doStream: ({ abortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason ?? new Error("aborted")));
    }),
  });
  await runtime.ready;
  const response = await runtime.chat(userMessage("work"));
  await flush();
  assert.equal((await runtime.status()).busy, true);
  runtime.cancel();
  await response.text().catch(() => {});
  await flush();
  assert.equal((await runtime.status()).busy, false);
  // A new turn is accepted right away.
  const { runtime: fresh } = setup(t, { doStream: textStream("again") });
  await (await fresh.chat(userMessage("again"))).text();
});

test("performAction runs start_session and send_prompt server-side and refuses browser actions", async (t) => {
  const { runtime, store, state } = setup(t, { projects: [project()], sessions: [sessionMeta()] });
  const item = await store.createItem({
    list: "ideas", kind: "custom", title: "t", body: "", links: {}, fingerprint: "custom:x",
    actions: [
      { type: "start_session", projectId: "p1", prompt: "Look into it", agentId: "codex" },
      { type: "send_prompt", sessionId: "s1", prompt: "Continue" },
      { type: "open_url", url: "https://example.com" },
      { type: "start_session", projectId: "nope", prompt: "x" },
    ],
  });
  const started = await runtime.performAction(item.id, 0);
  assert.deepEqual(started, { sessionId: "s2" });
  assert.deepEqual(state.created.map((session) => [session.projectId, session.agentId]), [["p1", "codex"]]);
  assert.deepEqual(state.prompts, [{ id: "s2", text: "Look into it" }]);

  assert.deepEqual(await runtime.performAction(item.id, 1), {});
  assert.deepEqual(state.prompts.at(-1), { id: "s1", text: "Continue" });

  await assert.rejects(runtime.performAction(item.id, 2), (err) => err.status === 400);
  await assert.rejects(runtime.performAction(item.id, 3), (err) => err.status === 404);
  await assert.rejects(runtime.performAction(item.id, 9), (err) => err.status === 404);
  await assert.rejects(runtime.performAction("missing", 0), (err) => err.status === 404);
  assert.equal((await store.getItem(item.id)).status, "open", "actions leave the item's status alone");

  // A prompt that fails still leaves a session behind; the action reports both.
  state.promptFailure = "agent is busy";
  assert.deepEqual(await runtime.performAction(item.id, 0), { sessionId: "s3", promptError: "agent is busy" });
});

test("updateItem and updateWatch emit the full lists; dispose stops the scheduler", async (t) => {
  const { runtime, store, events, timers } = setup(t);
  await runtime.ready;
  await flush();
  const item = await store.createItem({ list: "ideas", kind: "custom", title: "t", body: "", links: {}, actions: [], fingerprint: "custom:x" });
  const updated = await runtime.updateItem(item.id, { status: "dismissed" });
  assert.equal(updated.status, "dismissed");
  await flush();
  const itemsEvent = events.findLast((event) => event.type === "items");
  assert.equal(itemsEvent.items[0].status, "dismissed");
  const watch = await store.createWatch({ intent: "x", notes: "" });
  await runtime.updateWatch(watch.id, { status: "cancelled" });
  await flush();
  assert.equal(events.findLast((event) => event.type === "watches").watches[0].status, "cancelled");

  assert.equal(timers.pending.length, 1);
  await runtime.dispose();
  assert.equal(timers.pending.length, 0);
  assert.equal((await runtime.status()).nextTickAt, null);
});
