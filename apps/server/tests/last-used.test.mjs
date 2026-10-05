import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryLastUsedStore, parseLastUsedPatch } from "../src/settings/last-used.ts";

const select = (id, category, currentValue, values) => ({ id, category, name: id, type: "select", currentValue, options: values.map((value) => ({ value, name: value })) });
const record = (model, effort = "low") => ({ modes: null, configOptions: [select("model", "model", model, ["sonnet", "fable"]), select("effort", "thought_level", effort, ["low", "max"])] });

test("parseLastUsedPatch takes known agents and settings records only", () => {
  const agents = ["claude", "codex"];
  assert.deepEqual(parseLastUsedPatch({ agentId: "codex" }, agents), { agentId: "codex" });
  assert.deepEqual(parseLastUsedPatch({ settings: { claude: { ...record("fable"), commands: [] } } }, agents), { settings: { claude: record("fable") } });
  assert.deepEqual(parseLastUsedPatch({}, agents), {});
  for (const [body, message] of [
    [null, /JSON object/], [{ agentId: "x" }, /Unknown agent "x"/], [{ agentId: 3 }, /Unknown agent/], [{ extra: 1 }, /Unknown field "extra"/],
    [{ settings: [] }, /settings must be an object/], [{ settings: { x: record("fable") } }, /Unknown agent "x"/], [{ settings: { claude: {} } }, /settings\.claude must be/],
  ]) {
    assert.throws(() => parseLastUsedPatch(body, agents), (err) => err.status === 400 && message.test(err.message), JSON.stringify(body));
  }
});

test("the store merges patches per agent and serializes concurrent writes", async () => {
  const store = createMemoryLastUsedStore({ agentId: "claude", settings: { codex: record("sonnet") } });
  await Promise.all([
    store.patch({ settings: { claude: record("sonnet", "max") } }),
    store.recordChange("claude", { ...record("fable", "low"), commands: [] }, { configId: "model", value: "fable" }),
    store.patch({ agentId: "codex" }),
  ]);
  const stored = await store.read();
  assert.equal(stored.agentId, "codex");
  // The model change is the session's; the effort stays the user's max, which the session had dropped.
  assert.deepEqual(stored.settings.claude, record("fable", "max"));
  assert.deepEqual(stored.settings.codex, record("sonnet"), "another agent's record is left alone");
  assert.deepEqual(await store.agentSettings("nope"), null);
  assert.equal("commands" in store.stored().settings.claude, false);
});

test("a malformed stored record reads as empty", async () => {
  assert.deepEqual(await createMemoryLastUsedStore("garbage").read(), { agentId: null, settings: {} });
  assert.equal(await createMemoryLastUsedStore().agentSettings("claude"), null);
});
