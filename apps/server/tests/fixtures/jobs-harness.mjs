/**
 * A runtime for the jobs tests: in-memory stores, fake deps, settings, presence, and clock, a
 * scripted model, and a jobs service built with the options a test needs (a fake tick, worker
 * tuning, a store the test can reach). Also the scripted model steps and a tool context for calling
 * the job tools directly, as a chat turn or an intent check would.
 */
import { MockLanguageModelV3 } from "ai/test";
import { createJobsService } from "../../src/orchestrator/jobs/service.ts";
import { createMemoryJobsStore } from "../../src/orchestrator/jobs/store.ts";
import { createOrchestratorRuntime } from "../../src/orchestrator/runtime.ts";
import { createMemoryOrchestratorStore } from "../../src/orchestrator/store.ts";
import { emptyScope } from "../../src/orchestrator/types.ts";
import { fakeDeps, fakePresence, fakeSettings, fakeTimers, flush } from "./orchestrator-fakes.mjs";

export { T0, flush } from "./orchestrator-fakes.mjs";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finish = (unified) => ({ unified, raw: undefined });

export function textStep(text) {
  return { content: [{ type: "text", text }], finishReason: finish("stop"), usage, warnings: [] };
}

export function toolStep(toolName, input, toolCallId = "call-1") {
  return { content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }], finishReason: finish("tool-calls"), usage, warnings: [] };
}

/** A promise with its resolve and reject handed out, for model steps a test releases by hand. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * `jobs` options go to `createJobsService` (tick, worker, store); `approvals` replaces the approvals
 * service. The default tick is a fake that reports nothing changed without touching the world.
 */
export function jobsHarness(t, {
  key = "sk-test", doGenerate, presence = 0, settings = {}, sessions, projects, events: sessionEvents, github, jobs = {}, approvals, store: jobsStore,
} = {}) {
  const store = createMemoryOrchestratorStore();
  const settingsStore = fakeSettings({ key, ...settings });
  const timers = fakeTimers();
  const presenceSource = fakePresence(presence);
  const { deps, state } = fakeDeps({ sessions, projects, events: sessionEvents, github });
  const model = new MockLanguageModelV3({ doGenerate });
  const events = [];
  const ticks = [];
  const tick = jobs.tick ?? (async (report) => {
    ticks.push(report.id);
    report.log.push("Nothing changed; the model was not invoked.");
  });
  const memoryJobs = jobsStore ?? createMemoryJobsStore({ now: () => timers.now() });
  const runtime = createOrchestratorRuntime({
    store, settingsStore, deps, timers, presence: presenceSource, model: () => model,
    domains: {
      jobs: (hub) => createJobsService(hub, { store: memoryJobs, ...jobs, tick }),
      ...(approvals ? { approvals: (hub) => approvals(hub) } : {}),
    },
  });
  runtime.subscribe((event) => events.push(event));
  t.after(() => runtime.dispose());
  const hub = runtime.hub;
  return { runtime, hub, jobs: hub.jobs, jobsStore: memoryJobs, store, settings: settingsStore, timers, presence: presenceSource, deps, state, model, events, ticks };
}

/** Wait for the runtime (the tick is seeded) and let the worker take its first look. */
export async function started(harness) {
  await harness.runtime.ready;
  await flush();
  return harness;
}

/**
 * The context the job tools get in a turn: a chat turn by default; `kind: "intent_check"` with an
 * `intentId` for a check. `runId` should be a real run (start one with `hub.jobs.startRun`) when a
 * test depends on the run chain.
 */
export function toolContext(harness, { runId = "run-chat", kind = "chat", origin = kind === "chat" ? "chat" : "job", threadId = "main", jobId = null, intentId = null, interactive = origin === "chat" } = {}) {
  const { hub } = harness;
  return {
    store: hub.store, settings: hub.settings, deps: hub.deps, touched: new Set(), interactive, now: () => hub.timers.now(),
    self: { digest: async () => ({ at: 0, since: null, changes: [], openItems: [], memory: "" }), schedule: async () => ({}), lastTick: async () => null },
    hub, turn: { runId, kind, role: "chat", origin, threadId, jobId, intentId, scope: emptyScope() },
  };
}

const options = { toolCallId: "call", messages: [] };

/** Call a tool as the SDK would: through its input schema first. */
export async function call(tools, name, input = {}) {
  const tool = tools[name];
  if (!tool) throw new Error(`No tool "${name}" in: ${Object.keys(tools).join(", ")}`);
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), invalidInput: true };
  return tool.execute(parsed.data, options);
}
