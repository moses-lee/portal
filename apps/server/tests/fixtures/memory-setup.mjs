/**
 * A runtime over in-memory stores (or a test database) with fake deps, settings, and clock, for the
 * memory tests: `memory` is its curated memory service; `events` and `activity` record what it emitted.
 */
import { createPgActivityStore } from "../../src/orchestrator/activity/pg-store.ts";
import { createPgOrchestratorStore } from "../../src/orchestrator/pg-store.ts";
import { createOrchestratorRuntime } from "../../src/orchestrator/runtime.ts";
import { createMemoryOrchestratorStore } from "../../src/orchestrator/store.ts";
import { fakeDeps, fakePresence, fakeSettings, fakeTimers } from "./orchestrator-fakes.mjs";

export async function memorySetup(t, { key = "sk-test", legacy = "", database = null, model, store: given } = {}) {
  const store = given ?? (database ? createPgOrchestratorStore({ db: database.db }) : createMemoryOrchestratorStore());
  await store.ready;
  if (legacy) await store.writeMemory(legacy);
  const settings = fakeSettings({ key });
  const timers = fakeTimers();
  const { deps } = fakeDeps();
  const runtime = createOrchestratorRuntime({
    store, settingsStore: settings, deps, timers, presence: fakePresence(0), ...(model ? { model: () => model } : {}),
    ...(database ? { db: database.db, sql: database.sql, activityStore: createPgActivityStore({ db: database.db }) } : {}),
  });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  t.after(() => runtime.dispose());
  await runtime.ready;
  const memory = runtime.hub.memory;
  const activity = async (prefix = "memory.") => (await runtime.hub.activity.list({ kind: prefix })).reverse();
  return { runtime, store, settings, timers, memory, events, activity, hub: runtime.hub };
}

export const user = { actor: "user" };
export const agent = { actor: "agent", runId: "run1", threadId: "main" };

export function claim(overrides = {}) {
  return { entity: { type: "repo", key: "acme/app" }, type: "convention", key: "review-style", body: "Review tests before code.", ...overrides };
}
