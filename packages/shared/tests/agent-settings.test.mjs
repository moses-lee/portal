import assert from "node:assert/strict";
import test from "node:test";
import {
  overlaySettings,
  parseLastUsed,
  parseSettingsRecord,
  recordUserChange,
  settingsOf,
} from "../src/agent-settings.ts";

const select = (id, category, currentValue, values) => ({
  id, category, name: id, type: "select", currentValue, options: values.map((value) => ({ value, name: value })),
});
const bool = (id, currentValue) => ({ id, name: id, type: "boolean", currentValue });
const state = (configOptions, modes = null) => ({ modes, configOptions });
const modes = (currentModeId, ids) => ({ currentModeId, availableModes: ids.map((id) => ({ id, name: id })) });
const values = (s) => ({
  ...Object.fromEntries(s.configOptions.map((option) => [option.id, option.currentValue])),
  mode: s.modes?.currentModeId ?? null,
});

test("overlaySettings keeps base's option lists and takes desired's values where base offers them", () => {
  const desired = state([select("model", "model", "opus", ["opus", "sonnet"]), select("effort", "thought_level", "max", ["max"]), bool("fast", true)], modes("plan", ["default", "plan"]));
  const base = state([select("model", "model", "sonnet", ["opus", "sonnet", "fable"]), select("effort", "thought_level", "low", ["low", "high"]), bool("fast", false), bool("new", false)], modes("default", ["default", "plan"]));
  const result = overlaySettings(desired, base);
  assert.deepEqual(values(result), { model: "opus", effort: "low", fast: true, new: false, mode: "plan" });
  assert.deepEqual(result.configOptions[0].options.map((choice) => choice.value), ["opus", "sonnet", "fable"], "base's choices");
  assert.equal("commands" in overlaySettings(desired, { ...base, commands: [{ name: "x" }] }), false);
});

test("recordUserChange takes the changed setting from the session and the rest from the record", () => {
  // The agent left plan mode on its own; the user then switched model.
  const stored = state([select("model", "model", "sonnet", ["opus", "sonnet"]), bool("fast", true)], modes("plan", ["default", "plan"]));
  const result = state([select("model", "model", "opus", ["opus", "sonnet"]), bool("fast", false)], modes("default", ["default", "plan"]));
  assert.deepEqual(values(recordUserChange(stored, result, { configId: "model", value: "opus" })), { model: "opus", fast: true, mode: "plan" });
  // Changing the legacy mode records the mode and keeps the rest.
  assert.deepEqual(values(recordUserChange(stored, result, { modeId: "default" })), { model: "sonnet", fast: true, mode: "default" });
  // Nothing recorded yet: the session's state as it is.
  assert.deepEqual(recordUserChange(null, { ...result, commands: [] }, { configId: "model", value: "opus" }), settingsOf(result));
});

test("recordUserChange treats a mode config option and the legacy mode as one setting", () => {
  const stored = state([select("mode", "mode", "plan", ["default", "plan"]), select("model", "model", "sonnet", ["opus", "sonnet"])], modes("plan", ["default", "plan"]));
  const result = state([select("mode", "mode", "default", ["default", "plan"]), select("model", "model", "opus", ["opus", "sonnet"])], modes("default", ["default", "plan"]));
  const viaOption = recordUserChange(stored, result, { configId: "mode", value: "default" });
  assert.deepEqual(values(viaOption), { mode: "default", model: "sonnet" });
  const viaMode = recordUserChange(stored, result, { modeId: "default" });
  assert.deepEqual(values(viaMode), { mode: "default", model: "sonnet" });
});

test("parseSettingsRecord accepts a session's settings and refuses anything else", () => {
  const good = state([select("model", "model", "opus", ["opus"]), { ...select("effort", "thought_level", "low", []), options: [{ group: "g", name: "G", options: [{ value: "low", name: "Low" }] }] }, bool("fast", true)], modes("plan", ["plan"]));
  assert.deepEqual(parseSettingsRecord(good), good);
  assert.deepEqual(parseSettingsRecord({ configOptions: [] }), state([]));
  // An option kind Portal cannot apply is dropped, not fatal.
  assert.deepEqual(parseSettingsRecord(state([{ id: "x", name: "x", type: "slider", currentValue: 3 }, bool("fast", true)])), state([bool("fast", true)]));
  assert.deepEqual(parseSettingsRecord(state([{ ...bool("fast", "yes") }])), state([]));
  for (const bad of [null, [], "x", { configOptions: "no" }, state([], { currentModeId: 1, availableModes: [] }), state([], { currentModeId: "a", availableModes: [{ id: "" }] })]) {
    assert.equal(parseSettingsRecord(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseSettingsRecord(state([{ ...select("m", "model", "a", []), options: [{ value: 1 }] }])).configOptions.length, 0);
});

test("parseLastUsed reads a stored record leniently", () => {
  assert.deepEqual(parseLastUsed(null), { agentId: null, settings: {} });
  assert.deepEqual(parseLastUsed({ agentId: "", settings: [] }), { agentId: null, settings: {} });
  const record = state([bool("fast", true)]);
  assert.deepEqual(parseLastUsed({ agentId: "codex", settings: { claude: record, codex: "broken" } }), { agentId: "codex", settings: { claude: record } });
});
