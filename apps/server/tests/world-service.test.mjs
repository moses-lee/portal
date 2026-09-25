import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createOrchestratorRuntime } from "../src/orchestrator/runtime.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { emptyRefreshReport, performRefresh } from "../src/orchestrator/tick.ts";
import { WORLD_STALE_MS, createWorldService } from "../src/orchestrator/world/service.ts";
import { createMemoryWorldStore } from "../src/orchestrator/world/store.ts";
import { changesGuidance, guidance } from "../src/orchestrator/world/prompt.ts";
import { DEFAULT_CHANGES_SINCE_MS, changeMatches, parseSince } from "../src/orchestrator/world/tools.ts";
import { T0, attentionPull, fakeDeps, fakePresence, fakeSettings, fakeTimers, flush, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

function setup({ worldStore = createMemoryWorldStore(), ...options } = {}) {
  const { deps, state } = fakeDeps({
    projects: [project({ id: "p1", name: "mono", path: "/code/mono" })],
    sessions: [sessionMeta({ id: "s1", projectId: "p1" })],
    pulls: [attentionPull({ repo: "acme/monorepo", number: 2367, roles: ["reviewer"] })],
    originUrl: async () => "git@github.com:acme/monorepo.git",
  });
  const events = [];
  const timers = fakeTimers();
  const hub = {
    deps, store: createMemoryOrchestratorStore(), timers, db: null, sql: null, emit: (event) => events.push(event),
    jobs: { listIntents: async () => [] },
  };
  hub.world = createWorldService(hub, { store: worldStore, ...options });
  return { hub, world: hub.world, deps, state, events, timers, worldStore };
}

test("refresh builds with GitHub, stores the build, and emits world; current answers from memory while fresh", async () => {
  const { world, state, events, worldStore } = setup();
  const built = await world.refresh("manual");
  assert.equal(built.pulls[0].localProjectId, "p1");
  assert.equal(state.searches.length, 1);
  assert.deepEqual(events, [{ type: "world", at: T0 }]);
  const stored = await worldStore.latest();
  assert.equal(stored.reason, "manual");
  assert.deepEqual(stored.world, built);
  assert.equal(await world.current(), built, "the same build, not a rebuild");
});

test("once stale, current rebuilds only the local slices: new sessions appear, PRs are reused, nothing is stored", async () => {
  const { world, state, timers, worldStore, events } = setup();
  const built = await world.refresh("tick");
  state.sessions.push(sessionMeta({ id: "s2", projectId: "p1", lastActiveAt: T0 + 1 }));
  timers.tick(WORLD_STALE_MS - 1);
  assert.equal((await world.current()).sessions.length, 1, "still fresh");
  timers.tick(2);
  const current = await world.current();
  assert.deepEqual(current.sessions.map((s) => s.id), ["s2", "s1"]);
  assert.deepEqual(current.pulls, built.pulls);
  assert.equal(current.at, T0 + WORLD_STALE_MS + 1);
  assert.equal(state.searches.length, 1, "no GitHub call");
  assert.equal((await worldStore.list()).length, 1, "local builds stay in memory");
  assert.equal(events.length, 1);
});

test("before any build, current gives a local world without GitHub, and ensureBuilt runs the first full build", async () => {
  const { world, state, worldStore } = setup();
  const first = await world.current();
  assert.deepEqual(first.sessions.map((s) => s.id), ["s1"]);
  assert.deepEqual(first.pulls, []);
  assert.equal(state.searches.length, 0);
  assert.equal(await worldStore.latest(), null);
  const built = await world.ensureBuilt();
  assert.equal(built.pulls.length, 1);
  assert.equal((await worldStore.latest()).reason, "first request");
  await world.ensureBuilt();
  assert.equal((await worldStore.list()).length, 1, "only the first request builds");
});

test("overlapping refreshes share one build", async () => {
  const { world, state, deps, worldStore } = setup();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const search = deps.github.searchAttentionPulls;
  deps.github.searchAttentionPulls = async (opts) => { await gate; return search(opts); };
  const a = world.refresh("tick");
  const b = world.refresh("manual");
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(state.searches.length, 1);
  assert.equal((await worldStore.list()).length, 1);
  await world.refresh("again");
  assert.equal(state.searches.length, 2, "a refresh after the first finished builds again");
});

test("after a restart the newest stored build is the current world", async () => {
  const worldStore = createMemoryWorldStore();
  const before = setup({ worldStore });
  const built = await before.world.refresh("tick");
  const after = setup({ worldStore });
  assert.deepEqual(await after.world.current(), built);
  assert.equal(after.state.searches.length, 0);
});

test("prune keeps only the newest builds", async () => {
  const { world, timers, worldStore } = setup({ keep: 2 });
  for (let i = 0; i < 4; i++) {
    await world.refresh(`r${i}`);
    timers.tick(1000);
  }
  assert.deepEqual((await worldStore.list()).map((b) => b.reason), ["r3", "r2"]);
});

test("a store that fails does not fail the refresh", async (t) => {
  const worldStore = createMemoryWorldStore();
  worldStore.append = async () => { throw new Error("disk full"); };
  const logged = t.mock.method(console, "error", () => {});
  const { world } = setup({ worldStore });
  const built = await world.refresh("tick");
  assert.equal(built.pulls.length, 1);
  assert.ok(logged.mock.calls.some((call) => /disk full/.test(call.arguments[0])));
});

test("chat turns get all five world tools, background turns only resolve_pull and resolve_repo; the tools answer from the world", async () => {
  const { world, hub } = setup();
  await world.refresh("tick");
  const turn = { runId: "r1", kind: "chat", role: "chat", origin: "chat", threadId: "main", jobId: null, intentId: null, scope: { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] } };
  const chat = world.tools({ interactive: true, deps: hub.deps, hub, turn });
  assert.deepEqual(Object.keys(chat).sort(), ["get_changes", "get_world", "resolve_pull", "resolve_repo", "resolve_session"]);
  const background = world.tools({ interactive: false, deps: hub.deps, hub, turn: { ...turn, origin: "job" } });
  assert.deepEqual(Object.keys(background).sort(), ["resolve_pull", "resolve_repo"]);

  const pull = await chat.resolve_pull.execute({ number: 2367 }, {});
  assert.equal(pull.match.repo, "acme/monorepo");
  assert.equal(pull.match.projectId, "p1");
  assert.equal((await chat.resolve_repo.execute({ query: "the monorepo" }, {})).match.projectId, "p1");
  assert.equal((await chat.resolve_session.execute({ query: "login" }, {})).match.id, "s1");
  const text = await chat.get_world.execute({}, {});
  assert.match(text.text, /acme\/monorepo/);
  const slice = await chat.get_world.execute({ scope: "repos" }, {});
  assert.deepEqual(slice.repos, [{ repo: "acme/monorepo", defaultBranch: "main", projectIds: ["p1"] }]);
  assert.equal(slice.truncated, false);
});

test("the guidance tells the model to resolve before asking", () => {
  assert.match(guidance, /resolve_pull/);
  assert.match(guidance, /before ever asking the user/);
  assert.match(guidance, /several candidates/);
});

test("the changes guidance: when to mention, what never to, how, and get_changes when asked", () => {
  assert.match(changesGuidance, /discussed in this thread/);
  assert.match(changesGuidance, /fresh and the user's own/);
  assert.match(changesGuidance, /Do not mention old state that merely persists/);
  assert.match(changesGuidance, /at most one or two short lines at the end/);
  assert.match(changesGuidance, /say nothing about changes/);
  assert.match(changesGuidance, /call get_changes/);
});

test("get_changes: since as relative or ISO time (default a day), about as words or refs, newest first, capped", async () => {
  const MIN = 60_000;
  assert.equal(parseSince(undefined, T0), T0 - DEFAULT_CHANGES_SINCE_MS);
  assert.equal(parseSince("  ", T0), T0 - DEFAULT_CHANGES_SINCE_MS);
  assert.equal(parseSince("30m", T0), T0 - 30 * MIN);
  assert.equal(parseSince("2h", T0), T0 - 120 * MIN);
  assert.equal(parseSince("1.5 hours", T0), T0 - 90 * MIN);
  assert.equal(parseSince("3d", T0), T0 - 3 * 24 * 60 * MIN);
  assert.equal(parseSince("1w", T0), T0 - 7 * 24 * 60 * MIN);
  assert.equal(parseSince("2026-09-24T10:00:00Z", T0), Date.parse("2026-09-24T10:00:00Z"));
  assert.throws(() => parseSince("yesterday-ish", T0), /neither a relative time/);

  const { world, hub, timers } = setup();
  await world.refresh("manual");
  const change = (subject, at, overrides = {}) => ({
    subject, kind: "pr_checks_failing", fingerprint: subject, summary: `about ${subject}`, detail: null, refs: {}, mine: true, activeAt: null, ...overrides,
  });
  await world.changes.record([change("pr:acme/monorepo#2367", 0, { summary: 'PR acme/monorepo#2367 "Speed up CI" needs attention: checks failing', refs: { pull: { repo: "acme/monorepo", number: 2367, url: "u" }, projectId: "p1" } })], T0 - 3 * 60 * MIN);
  await world.changes.record([change("session:s1", 0, { kind: "session_finished", summary: 'Session "Fix the login bug" finished its turn', refs: { sessionId: "s1", projectId: "p1" } })], T0 - 30 * MIN);
  await world.changes.record([change("folder:p9", 0, { kind: "folder_missing", summary: "The folder of project old is missing", refs: { projectId: "p9" } })], T0 - 3 * 24 * 60 * MIN);
  const turn = { runId: "r1", kind: "chat", role: "chat", origin: "chat", threadId: "main", jobId: null, intentId: null, scope: { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] } };
  const tools = world.tools({ interactive: true, deps: hub.deps, hub, turn, now: () => timers.now() });
  const run = async (input) => {
    const parsed = tools.get_changes.inputSchema.safeParse(input);
    return parsed.success ? tools.get_changes.execute(parsed.data, {}) : { invalidInput: true };
  };

  const day = await run({});
  assert.equal(day.since, new Date(T0 - DEFAULT_CHANGES_SINCE_MS).toISOString());
  assert.deepEqual(day.changes.map((entry) => entry.summary), ['Session "Fix the login bug" finished its turn', 'PR acme/monorepo#2367 "Speed up CI" needs attention: checks failing']);
  assert.deepEqual(day.changes[1], {
    at: new Date(T0 - 3 * 60 * MIN).toISOString(), kind: "pr_checks_failing", summary: 'PR acme/monorepo#2367 "Speed up CI" needs attention: checks failing',
    pull: "acme/monorepo#2367", projectId: "p1", mine: true, fingerprint: "pr:acme/monorepo#2367",
  });
  assert.equal(day.truncated, false);
  assert.equal((await run({ since: "1w" })).changes.length, 3);
  assert.equal((await run({ since: "1h" })).changes.length, 1);
  assert.deepEqual((await run({ about: "#2367" })).changes.map((entry) => entry.pull), ["acme/monorepo#2367"]);
  assert.deepEqual((await run({ about: "login bug" })).changes.map((entry) => entry.sessionId), ["s1"]);
  assert.equal((await run({ about: "mono", since: "1w" })).changes.length, 2, "a project name matches what happened in it");
  assert.deepEqual((await run({ about: "nothing like it" })).changes, []);
  const one = await run({ limit: 1 });
  assert.equal(one.changes.length, 1);
  assert.equal(one.truncated, true);
  assert.equal((await run({ limit: 0 })).invalidInput, true);
  assert.match((await run({ since: "whenever" })).error, /neither a relative time/);
  assert.equal(changeMatches(change("x", 0), undefined), true);
});

// ---------------------------------------------------------------------------------------------
// The refresh and the prompt, through the runtime
// ---------------------------------------------------------------------------------------------

function runtimeSetup(t, deps) {
  const store = createMemoryOrchestratorStore();
  const timers = fakeTimers();
  const model = new MockLanguageModelV3({});
  const runtime = createOrchestratorRuntime({ store, settingsStore: fakeSettings(), deps, timers, presence: fakePresence(), model: () => model });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  t.after(() => runtime.dispose());
  return { runtime, store, events, timers };
}

test("the hourly refresh rebuilds the world, diffs its snapshot, and carries the build's error lines into its log", async (t) => {
  const { deps } = fakeDeps({ sessions: [sessionMeta()], projects: [project()] });
  deps.github.searchAttentionPulls = async () => ({ pulls: [], error: "gh is not logged in" });
  deps.terminals.list = async () => { throw new Error("pty gone"); };
  const { runtime, store, events } = runtimeSetup(t, deps);
  await runtime.ready;
  const report = emptyRefreshReport();
  await performRefresh(runtime.hub, report, { signal: new AbortController().signal });
  assert.equal(report.error, null, report.log.join("\n"));
  assert.ok(report.log.some((line) => /GitHub search failed \(gh is not logged in\)/.test(line)), report.log.join("\n"));
  assert.ok(report.log.some((line) => /Terminals could not be read/.test(line)));
  const builds = await runtime.hub.world.store.list();
  assert.deepEqual(builds.map((b) => b.reason), ["tick"]);
  assert.deepEqual(await store.readSnapshot(), builds[0].world.snapshot, "the refresh stores the world's snapshot");
  assert.ok(events.some((event) => event.type === "world"));
});

test("a chat turn's system prompt carries the world guidance and the rendered world", async (t) => {
  const { deps } = fakeDeps({ projects: [project({ name: "mono" })], originUrl: async () => "git@github.com:acme/monorepo.git" });
  const store = createMemoryOrchestratorStore();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
          controller.close();
        },
      }),
    }),
  });
  const runtime = createOrchestratorRuntime({ store, settingsStore: fakeSettings(), deps, timers: fakeTimers(), presence: fakePresence(), model: () => model });
  t.after(() => runtime.dispose());
  const response = await runtime.chat({ id: "u1", role: "user", parts: [{ type: "text", text: "review PR 2367" }] });
  await response.text();
  await flush();
  const system = model.doStreamCalls[0].prompt.find((message) => message.role === "system").content;
  assert.match(system, /Resolve loose references/);
  assert.match(system, /Generated by Portal from live state/);
  assert.match(system, /acme\/monorepo/);
  const tools = model.doStreamCalls[0].tools.map((tool) => tool.name);
  for (const name of ["resolve_pull", "resolve_repo", "resolve_session", "get_world"]) assert.ok(tools.includes(name), name);
});
