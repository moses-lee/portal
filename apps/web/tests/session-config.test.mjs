import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConfigChange,
  hasSettings,
  latestStateForAgent,
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
