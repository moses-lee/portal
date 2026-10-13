import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConfigChange,
  hasSettings,
  latestStateForAgent,
  startSettingsForAgent,
  nextConfigChange,
} from "../src/lib/session-config.ts";

const select = (id, category, currentValue, values) => ({
  id,
  category,
  name: id,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const grouped = (id, category, currentValue, values) => ({
  ...select(id, category, currentValue, []),
  options: [{ group: "g", name: "G", options: values.map((value) => ({ value, name: value })) }],
});
const bool = (id, currentValue) => ({ id, name: id, type: "boolean", currentValue });
const state = (configOptions, modes = null) => ({ modes, configOptions, commands: [] });
const modes = (currentModeId, ids) => ({
  currentModeId,
  availableModes: ids.map((id) => ({ id, name: id })),
});

test("nextConfigChange returns null when states agree", () => {
  const s = state([select("model", "model", "opus", ["opus", "sonnet"]), bool("fast", false)], modes("default", ["default", "plan"]));
  assert.equal(nextConfigChange(s, s), null);
});

test("nextConfigChange applies model before effort, then effort against the agent's new options", () => {
  const desired = state([
    grouped("effort", "thought_level", "max", ["low", "max"]),
    select("model", "model", "opus", ["opus", "sonnet"]),
  ]);
  const actual = state([
    select("model", "model", "sonnet", ["opus", "sonnet"]),
    grouped("effort", "thought_level", "low", ["low", "high"]),
  ]);
  assert.deepEqual(nextConfigChange(desired, actual), { configId: "model", value: "opus" });
  // The agent switched model and now offers "max": the second diff picks it up.
  const afterModel = state([
    select("model", "model", "opus", ["opus", "sonnet"]),
    grouped("effort", "thought_level", "low", ["low", "max"]),
  ]);
  assert.deepEqual(nextConfigChange(desired, afterModel), { configId: "effort", value: "max" });
  assert.equal(nextConfigChange(desired, applyConfigChange(afterModel, { configId: "effort", value: "max" })), null);
});

test("nextConfigChange skips values the agent no longer offers and options it lacks", () => {
  const desired = state([select("model", "model", "gone", ["gone"]), bool("fast", true), bool("other", true)]);
  const actual = state([select("model", "model", "opus", ["opus"]), bool("fast", false)]);
  assert.deepEqual(nextConfigChange(desired, actual), { configId: "fast", value: true });
  assert.equal(nextConfigChange(desired, applyConfigChange(actual, { configId: "fast", value: true })), null);
});

test("nextConfigChange changes the mode only when it is not a config option", () => {
  const desired = state([], modes("plan", ["default", "plan"]));
  assert.deepEqual(nextConfigChange(desired, state([], modes("default", ["default", "plan"]))), { modeId: "plan" });
  assert.equal(nextConfigChange(desired, state([], modes("default", ["default"]))), null);
  const withOption = state([select("mode", "mode", "default", ["default", "plan"])], modes("default", ["default", "plan"]));
  assert.equal(nextConfigChange(desired, withOption), null);
});

test("latestStateForAgent picks the most recently active session with settings", () => {
  const session = (id, agentId, lastActiveAt, configOptions) => ({
    id, agentId, lastActiveAt, createdAt: lastActiveAt, state: state(configOptions),
  });
  const sessions = [
    session("old", "claude", 1, [select("model", "model", "sonnet", ["sonnet"])]),
    session("new", "claude", 3, [select("model", "model", "opus", ["opus"])]),
    session("empty", "claude", 5, []),
    session("codex", "codex", 9, [select("model", "model", "gpt", ["gpt"])]),
  ];
  assert.equal(latestStateForAgent(sessions, "claude").configOptions[0].currentValue, "opus");
  assert.equal(latestStateForAgent(sessions, "codex").configOptions[0].currentValue, "gpt");
  assert.equal(latestStateForAgent(sessions, "other"), null);
  assert.equal(hasSettings(state([])), false);
  assert.equal(hasSettings(state([], modes("a", ["a"]))), true);
});

test("new-session settings refresh stale model and mode choices while preserving the user's picks", () => {
  const stored = state([
    select("model", "model", "gpt-6-astra", ["gpt-6-astra"]),
    select("effort", "thought_level", "xhigh", ["low", "xhigh"]),
    bool("fast", true),
    select("mode", "mode", "agent", ["agent", "read-only"]),
  ], modes("agent", ["agent", "read-only"]));
  const current = state([
    grouped("model", "model", "gpt-6.1-sol", ["gpt-6.1-sol", "gpt-6-astra"]),
    select("effort", "thought_level", "low", ["low", "xhigh"]),
    bool("fast", false),
    select("mode", "mode", "workspace-write", ["read-only", "workspace-write", "agent"]),
  ], modes("workspace-write", ["read-only", "workspace-write", "agent"]));
  const session = (agentId, status, lastActiveAt, state) => ({ agentId, link: { status }, lastActiveAt, createdAt: lastActiveAt, state });
  const sessions = [
    session("codex", "offline", 100, stored),
    session("codex", "live", 2, current),
    session("claude", "live", 200, state([select("model", "model", "opus", ["opus"])])),
  ];
  const before = structuredClone({ stored, current });
  const refreshed = startSettingsForAgent(sessions, "codex", stored);
  assert.deepEqual(refreshed.configOptions[0].options, current.configOptions[0].options);
  assert.deepEqual(refreshed.configOptions.map((option) => option.currentValue), ["gpt-6-astra", "xhigh", true, "agent"]);
  assert.equal(refreshed.modes.currentModeId, "agent");
  assert.deepEqual(refreshed.modes.availableModes, current.modes.availableModes);
  assert.deepEqual({ stored, current }, before, "refreshing never mutates saved preferences or a live session");
  assert.deepEqual(nextConfigChange(applyConfigChange(refreshed, { configId: "model", value: "gpt-6.1-sol" }), refreshed), { configId: "model", value: "gpt-6.1-sol" });
});

test("new-session settings keep offline choices until a live catalog exists and drop unavailable picks", () => {
  const saved = state([select("model", "model", "old", ["old"])]);
  const current = state([select("model", "model", "new", ["new"])]);
  const offline = { agentId: "codex", link: { status: "offline" }, lastActiveAt: 1, createdAt: 1, state: current };
  assert.equal(startSettingsForAgent([offline], "codex", saved), saved);
  assert.equal(startSettingsForAgent([offline], "codex"), current);
  assert.equal(startSettingsForAgent([], "codex"), null);
  const live = { ...offline, link: { status: "live" } };
  assert.equal(startSettingsForAgent([live], "codex", saved).configOptions[0].currentValue, "new");
  assert.equal(startSettingsForAgent([live], "codex"), current);
  assert.equal(startSettingsForAgent([{ ...live, state: state([]) }], "codex", saved), saved);
});
