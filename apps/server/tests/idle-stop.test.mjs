import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "@portal/shared/settings";
import { idleLabel, idleStopActivity, wireIdleStop } from "../src/sessions/idle-stop.ts";

const MINUTE = 60_000;

/** Sessions, settings, and an activity log, as `wireIdleStop` reads them from the app context. */
function fakeContext({ activity = true } = {}) {
  const applied = [];
  const logged = [];
  const stopListeners = new Set();
  const settingsListeners = new Set();
  let settings = defaultSettings;
  const session = { id: "s1", projectId: "p1", agentId: "claude", agentName: "Claude Code", title: "Fix the build" };
  const ctx = {
    sessions: {
      setIdleStopOptions: (options) => applied.push(options),
      onCliStopped(listener) {
        stopListeners.add(listener);
        return () => stopListeners.delete(listener);
      },
      getSession: (id) => (id === session.id ? session : undefined),
    },
    settings: {
      read: async () => settings,
      subscribe(listener) {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
    },
    log: { error: () => {} },
    orchestrator: activity ? { hub: { activity: { log: async (entry) => logged.push(entry) } } } : undefined,
  };
  return {
    ctx, applied, logged, session,
    stop: (stop) => { for (const listener of stopListeners) listener(stop); },
    change(next) {
      settings = next;
      for (const listener of settingsListeners) listener(next);
    },
    listeners: () => stopListeners.size + settingsListeners.size,
  };
}

test("idleLabel reads as hours and minutes", () => {
  assert.equal(idleLabel(45 * MINUTE), "45m");
  assert.equal(idleLabel(120 * MINUTE), "2h");
  assert.equal(idleLabel(125 * MINUTE + 20_000), "2h 5m");
  assert.equal(idleLabel(-1), "0m");
});

test("an automatic idle stop is logged to Activity with the session and how long it had been idle", () => {
  const entry = idleStopActivity(
    { id: "s1", projectId: "p1", agentId: "codex", agentName: "Codex", title: "Review" },
    { sessionId: "s1", automatic: true, idleMs: 130 * MINUTE, afterMs: 120 * MINUTE },
  );
  assert.deepEqual(entry, {
    actor: "system",
    kind: "session.cli_stopped_idle",
    summary: "Stopped Codex for “Review” after 2h 10m idle; the next message starts it again",
    refs: { sessionId: "s1", projectId: "p1" },
    detail: { agentId: "codex", idleMinutes: 130, afterMinutes: 120 },
  });
  assert.match(idleStopActivity({ id: "s2", projectId: "", agentId: "claude", agentName: "Claude Code", title: null }, { sessionId: "s2", automatic: true, idleMs: 0, afterMs: 0 }).summary, /an untitled session/);
});

test("wireIdleStop applies the settings now and on change, logs only automatic stops, and unwires", async () => {
  const fake = fakeContext();
  const unwire = await wireIdleStop(fake.ctx);
  assert.deepEqual(fake.applied, [{ enabled: true, afterMs: 120 * MINUTE }]);
  fake.change({ ...defaultSettings, sessions: { ...defaultSettings.sessions, idleStop: { enabled: false, afterMinutes: 30 } } });
  assert.deepEqual(fake.applied.at(-1), { enabled: false, afterMs: 30 * MINUTE });

  fake.stop({ sessionId: "s1", automatic: true, idleMs: 121 * MINUTE, afterMs: 120 * MINUTE });
  fake.stop({ sessionId: "s1", automatic: false, idleMs: 5 * MINUTE, afterMs: 120 * MINUTE });
  fake.stop({ sessionId: "gone", automatic: true, idleMs: 121 * MINUTE, afterMs: 120 * MINUTE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.logged.map(({ kind, refs }) => [kind, refs.sessionId]), [["session.cli_stopped_idle", "s1"]]);

  unwire();
  assert.equal(fake.listeners(), 0);
});

test("without the orchestrator an idle stop is not logged anywhere, and nothing throws", async () => {
  const fake = fakeContext({ activity: false });
  await wireIdleStop(fake.ctx);
  fake.stop({ sessionId: "s1", automatic: true, idleMs: 121 * MINUTE, afterMs: 120 * MINUTE });
  assert.deepEqual(fake.logged, []);
});
