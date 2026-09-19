import assert from "node:assert/strict";
import test from "node:test";
import { defaultOrchestratorSettings, orchestratorProviders } from "../src/lib/orchestrator/types.ts";
import {
  applySettingsPatch,
  defaultSettings,
  gitActionKinds,
  isOrchestratorProvider,
  mergeSettings,
  orchestratorLimits,
  settingsOverrides,
} from "../src/lib/settings.ts";

const orchestratorDefaults = defaultOrchestratorSettings;

test("gitActionKinds names every default prompt", () => {
  assert.deepEqual(gitActionKinds, ["checks", "conflicts", "review"]);
  assert.deepEqual(Object.keys(defaultSettings.gitActions.prompts).sort(), [...gitActionKinds].sort());
  for (const kind of gitActionKinds) assert.ok(defaultSettings.gitActions.prompts[kind].trim().length > 0);
});

test("defaults carry the orchestrator contract's defaults, with no key stored", () => {
  assert.deepEqual(defaultSettings.orchestrator, orchestratorDefaults);
  assert.deepEqual(Object.keys(defaultSettings.orchestrator.apiKeys).sort(), [...orchestratorProviders].sort());
  for (const provider of orchestratorProviders) assert.equal(defaultSettings.orchestrator.apiKeys[provider], false);
  assert.ok(orchestratorDefaults.intervalMinutes <= orchestratorLimits.intervalMinutes);
  assert.ok(orchestratorDefaults.idleIntervalMinutes <= orchestratorLimits.idleIntervalMinutes);
  assert.ok(orchestratorDefaults.model.length <= orchestratorLimits.modelLength);
});

test("isOrchestratorProvider accepts only the contract's providers", () => {
  for (const provider of orchestratorProviders) assert.ok(isOrchestratorProvider(provider));
  for (const bad of ["google", "", null, undefined, 1, ["openai"]]) assert.equal(isOrchestratorProvider(bad), false);
});

test("mergeSettings fills in defaults and ignores blank overrides", () => {
  assert.deepEqual(mergeSettings(null), defaultSettings);
  assert.deepEqual(mergeSettings(undefined), defaultSettings);
  assert.deepEqual(mergeSettings({}), defaultSettings);
  assert.deepEqual(mergeSettings({ gitActions: {} }), defaultSettings);
  assert.deepEqual(mergeSettings({ orchestrator: {} }), defaultSettings);
  assert.notEqual(mergeSettings({}), defaultSettings, "returns a fresh object");
  assert.notEqual(mergeSettings({}).orchestrator, defaultSettings.orchestrator, "returns a fresh orchestrator section");
  assert.notEqual(mergeSettings({}).orchestrator.apiKeys, defaultSettings.orchestrator.apiKeys, "returns fresh apiKeys");

  const merged = mergeSettings({ gitActions: { prompts: { checks: "Look at CI", review: "   " } } });
  assert.deepEqual(merged, {
    version: 1,
    gitActions: { prompts: { ...defaultSettings.gitActions.prompts, checks: "Look at CI" } },
    orchestrator: orchestratorDefaults,
  });
  // Non-string values are treated as absent.
  assert.deepEqual(mergeSettings({ gitActions: { prompts: { checks: 42 } } }), defaultSettings);
});

test("mergeSettings applies orchestrator overrides and masks API keys to booleans", () => {
  const merged = mergeSettings({
    orchestrator: {
      provider: "anthropic",
      model: "claude-x",
      intervalMinutes: 5,
      idleIntervalMinutes: 120,
      apiKeys: { anthropic: "sk-ant-secret" },
    },
  });
  assert.deepEqual(merged.gitActions, defaultSettings.gitActions);
  assert.deepEqual(merged.orchestrator, {
    provider: "anthropic",
    model: "claude-x",
    intervalMinutes: 5,
    idleIntervalMinutes: 120,
    apiKeys: { openai: false, anthropic: true },
  });
  assert.ok(!JSON.stringify(merged).includes("sk-ant-secret"), "the key text never reaches the wire form");

  // Blank or whitespace keys count as "no key stored".
  assert.deepEqual(mergeSettings({ orchestrator: { apiKeys: { openai: "", anthropic: "  " } } }).orchestrator.apiKeys, {
    openai: false,
    anthropic: false,
  });

  // Ill-typed values leave the default in place, field by field.
  const lenient = mergeSettings({
    orchestrator: { provider: "google", model: "   ", intervalMinutes: 2.5, idleIntervalMinutes: "60", apiKeys: { openai: 42 } },
  });
  assert.deepEqual(lenient.orchestrator, orchestratorDefaults);
  assert.deepEqual(mergeSettings({ orchestrator: { intervalMinutes: 0 } }).orchestrator.intervalMinutes, orchestratorDefaults.intervalMinutes);
  assert.deepEqual(mergeSettings({ orchestrator: { intervalMinutes: -3 } }).orchestrator.intervalMinutes, orchestratorDefaults.intervalMinutes);
});

test("settingsOverrides keeps only what differs, and round-trips through mergeSettings", () => {
  assert.deepEqual(settingsOverrides(defaultSettings), {});
  const overrides = { gitActions: { prompts: { conflicts: "Explain the conflicts" } } };
  const merged = mergeSettings(overrides);
  assert.deepEqual(settingsOverrides(merged), overrides);
  assert.deepEqual(mergeSettings(settingsOverrides(merged)), merged);
  // A prompt set to its default text is not an override.
  assert.deepEqual(settingsOverrides(mergeSettings({ gitActions: { prompts: { checks: defaultSettings.gitActions.prompts.checks } } })), {});
});

test("settingsOverrides writes only the orchestrator fields that differ, and never API keys", () => {
  const one = mergeSettings({ orchestrator: { model: "gpt-x" } });
  assert.deepEqual(settingsOverrides(one), { orchestrator: { model: "gpt-x" } });
  assert.deepEqual(mergeSettings(settingsOverrides(one)), one);

  const all = mergeSettings({
    orchestrator: { provider: "anthropic", model: "claude-x", intervalMinutes: 1, idleIntervalMinutes: 10080 },
  });
  assert.deepEqual(settingsOverrides(all), {
    orchestrator: { provider: "anthropic", model: "claude-x", intervalMinutes: 1, idleIntervalMinutes: 10080 },
  });

  // Explicit defaults are not overrides.
  assert.deepEqual(settingsOverrides(mergeSettings({ orchestrator: { ...orchestratorDefaults } })), {});

  // Keys are only known as stored/not stored here; the store persists the real ones separately.
  const keyed = mergeSettings({ orchestrator: { apiKeys: { openai: "sk-secret" } } });
  assert.equal(keyed.orchestrator.apiKeys.openai, true);
  assert.deepEqual(settingsOverrides(keyed), {});

  // Both sections at once.
  const both = mergeSettings({ gitActions: { prompts: { checks: "A" } }, orchestrator: { intervalMinutes: 3 } });
  assert.deepEqual(settingsOverrides(both), { gitActions: { prompts: { checks: "A" } }, orchestrator: { intervalMinutes: 3 } });
});

test("applySettingsPatch layers a patch on top and resets blank prompts to defaults", () => {
  const start = mergeSettings({ gitActions: { prompts: { checks: "A", review: "B" } } });
  const next = applySettingsPatch(start, { gitActions: { prompts: { review: "", conflicts: "C" } } });
  assert.deepEqual(next.gitActions.prompts, { checks: "A", conflicts: "C", review: defaultSettings.gitActions.prompts.review });
  assert.deepEqual(applySettingsPatch(start, {}), start);
});

test("applySettingsPatch touches only the section a patch names", () => {
  const start = mergeSettings({
    gitActions: { prompts: { checks: "A" } },
    orchestrator: { provider: "anthropic", model: "claude-x", intervalMinutes: 5, apiKeys: { anthropic: "k" } },
  });

  // An orchestrator-only patch keeps the prompts.
  const orchestratorOnly = applySettingsPatch(start, { orchestrator: { model: "claude-y", idleIntervalMinutes: 30 } });
  assert.deepEqual(orchestratorOnly.gitActions, start.gitActions);
  assert.deepEqual(orchestratorOnly.orchestrator, {
    provider: "anthropic",
    model: "claude-y",
    intervalMinutes: 5,
    idleIntervalMinutes: 30,
    apiKeys: { openai: false, anthropic: true },
  });

  // A prompts-only patch keeps the orchestrator section, stored keys included.
  const promptsOnly = applySettingsPatch(start, { gitActions: { prompts: { review: "R" } } });
  assert.deepEqual(promptsOnly.orchestrator, start.orchestrator);
  assert.equal(promptsOnly.gitActions.prompts.review, "R");
  assert.equal(promptsOnly.gitActions.prompts.checks, "A");

  // Keys: a non-blank string stores one, "" clears it, untouched providers keep their state.
  const keys = applySettingsPatch(start, { orchestrator: { apiKeys: { openai: "sk-new", anthropic: "" } } });
  assert.deepEqual(keys.orchestrator.apiKeys, { openai: true, anthropic: false });
  assert.deepEqual(applySettingsPatch(keys, { orchestrator: { apiKeys: { openai: "  " } } }).orchestrator.apiKeys, { openai: false, anthropic: false });
  assert.deepEqual(applySettingsPatch(keys, { orchestrator: { provider: "openai" } }).orchestrator.apiKeys, keys.orchestrator.apiKeys);

  // Orchestrator fields have no "blank means default": a blank model is ignored rather than reset.
  assert.equal(applySettingsPatch(start, { orchestrator: { model: "" } }).orchestrator.model, "claude-x");
  assert.deepEqual(applySettingsPatch(start, { orchestrator: {} }), start);
  assert.deepEqual(applySettingsPatch(start, {}), start);
  assert.notEqual(applySettingsPatch(start, {}).orchestrator.apiKeys, start.orchestrator.apiKeys, "does not alias the input");
});
