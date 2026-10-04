import assert from "node:assert/strict";
import test from "node:test";
import { defaultOrchestratorSettings, orchestratorProviders } from "@portal/contracts/orchestrator";
import {
  applySettingsPatch,
  defaultSessionsSettings,
  defaultSettings,
  gitActionKinds,
  isClockTime,
  isLifecycleHours,
  isOrchestratorProvider,
  mergeSettings,
  orchestratorLimits,
  sessionsLimits,
  settingsOverrides,
} from "../src/settings.ts";
import { defaultScriptSettings, defaultScripts, mergeScripts, scriptKinds, scriptLimits, scriptsOverrides } from "../src/scripts.ts";

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
  assert.ok(!("intervalMinutes" in orchestratorDefaults) && !("idleIntervalMinutes" in orchestratorDefaults), "the old tick intervals are gone");
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
  assert.notEqual(mergeSettings({}).sessions.tracked, defaultSettings.sessions.tracked, "returns a fresh sessions section");

  const merged = mergeSettings({ gitActions: { prompts: { checks: "Look at CI", review: "   " } } });
  assert.deepEqual(merged, {
    version: 1,
    gitActions: { prompts: { ...defaultSettings.gitActions.prompts, checks: "Look at CI" } },
    orchestrator: orchestratorDefaults,
    scripts: defaultScripts,
    sessions: defaultSessionsSettings,
  });
  // Non-string values are treated as absent.
  assert.deepEqual(mergeSettings({ gitActions: { prompts: { checks: 42 } } }), defaultSettings);
});

test("mergeSettings applies orchestrator overrides and masks API keys to booleans", () => {
  const merged = mergeSettings({
    orchestrator: {
      provider: "openai",
      model: "gpt-x",
      intervalMinutes: 5,
      idleIntervalMinutes: 120,
      reviews: { answerReadOnly: false },
      apiKeys: { anthropic: "sk-ant-secret" },
    },
  });
  assert.deepEqual(merged.gitActions, defaultSettings.gitActions);
  // Stored files from before the tick became a silent refresh may still carry its intervals: they are dropped.
  assert.deepEqual(merged.orchestrator, {
    provider: "openai",
    model: "gpt-x",
    bookkeeping: { provider: "anthropic", model: "claude-sonnet-5" },
    consolidation: orchestratorDefaults.consolidation,
    reviews: { answerReadOnly: false },
    stalls: orchestratorDefaults.stalls,
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
    orchestrator: { provider: "google", model: "   ", reviews: { answerReadOnly: "no" }, apiKeys: { openai: 42 } },
  });
  assert.deepEqual(lenient.orchestrator, orchestratorDefaults);
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
    orchestrator: { provider: "openai", model: "gpt-x", bookkeeping: { provider: "openai", model: "gpt-mini" }, reviews: { answerReadOnly: false } },
  });
  assert.deepEqual(settingsOverrides(all), {
    orchestrator: { provider: "openai", model: "gpt-x", bookkeeping: { provider: "openai", model: "gpt-mini" }, reviews: { answerReadOnly: false } },
  });
  assert.deepEqual(mergeSettings(settingsOverrides(all)), all);

  // Explicit defaults are not overrides.
  assert.deepEqual(settingsOverrides(mergeSettings({ orchestrator: { ...orchestratorDefaults } })), {});

  // Keys are only known as stored/not stored here; the store persists the real ones separately.
  const keyed = mergeSettings({ orchestrator: { apiKeys: { openai: "sk-secret" } } });
  assert.equal(keyed.orchestrator.apiKeys.openai, true);
  assert.deepEqual(settingsOverrides(keyed), {});

  // Both sections at once.
  const both = mergeSettings({ gitActions: { prompts: { checks: "A" } }, orchestrator: { model: "gpt-y", intervalMinutes: 3 } });
  assert.deepEqual(settingsOverrides(both), { gitActions: { prompts: { checks: "A" } }, orchestrator: { model: "gpt-y" } });
});

test("consolidation settings merge field by field, null turns a trigger off, and only differences are written", () => {
  assert.deepEqual(orchestratorDefaults.consolidation, { nightlyAt: "03:00", inboxThreshold: 10, minIntervalMinutes: 60 });
  assert.ok(orchestratorDefaults.consolidation.inboxThreshold <= orchestratorLimits.inboxThreshold);
  assert.ok(orchestratorDefaults.consolidation.minIntervalMinutes <= orchestratorLimits.minIntervalMinutes);
  for (const good of ["00:00", "03:00", "23:59", "09:05"]) assert.ok(isClockTime(good), good);
  for (const bad of ["24:00", "3:00", "03:60", "0300", "", null, 300]) assert.equal(isClockTime(bad), false, String(bad));

  const off = mergeSettings({ orchestrator: { consolidation: { nightlyAt: null, inboxThreshold: null } } });
  assert.deepEqual(off.orchestrator.consolidation, { nightlyAt: null, inboxThreshold: null, minIntervalMinutes: 60 });
  assert.deepEqual(settingsOverrides(off), { orchestrator: { consolidation: { nightlyAt: null, inboxThreshold: null } } });
  assert.deepEqual(mergeSettings(settingsOverrides(off)), off);

  const lenient = mergeSettings({ orchestrator: { consolidation: { nightlyAt: "25:00", inboxThreshold: 0, minIntervalMinutes: 1.5 } } });
  assert.deepEqual(lenient.orchestrator.consolidation, orchestratorDefaults.consolidation);

  const moved = applySettingsPatch(off, { orchestrator: { consolidation: { nightlyAt: "04:30" } } });
  assert.deepEqual(moved.orchestrator.consolidation, { nightlyAt: "04:30", inboxThreshold: null, minIntervalMinutes: 60 }, "fields the patch leaves out stay");
  assert.notEqual(mergeSettings({}).orchestrator.consolidation, defaultSettings.orchestrator.consolidation, "a fresh consolidation section");
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
    orchestrator: { provider: "openai", model: "gpt-x", reviews: { answerReadOnly: false }, apiKeys: { anthropic: "k" } },
  });

  // An orchestrator-only patch keeps the prompts.
  const orchestratorOnly = applySettingsPatch(start, { orchestrator: { model: "gpt-y", consolidation: { minIntervalMinutes: 30 } } });
  assert.deepEqual(orchestratorOnly.gitActions, start.gitActions);
  assert.deepEqual(orchestratorOnly.orchestrator, {
    provider: "openai",
    model: "gpt-y",
    bookkeeping: { provider: "anthropic", model: "claude-sonnet-5" },
    consolidation: { ...orchestratorDefaults.consolidation, minIntervalMinutes: 30 },
    reviews: { answerReadOnly: false },
    stalls: orchestratorDefaults.stalls,
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
  assert.equal(applySettingsPatch(start, { orchestrator: { model: "" } }).orchestrator.model, "gpt-x");
  assert.deepEqual(applySettingsPatch(start, { orchestrator: {} }), start);
  assert.deepEqual(applySettingsPatch(start, {}), start);
  assert.notEqual(applySettingsPatch(start, {}).orchestrator.apiKeys, start.orchestrator.apiKeys, "does not alias the input");
});

test("scriptKinds names every default script, each off with a timeout within the limit", () => {
  assert.deepEqual(scriptKinds, ["preWorktreeDelete"]);
  assert.deepEqual(Object.keys(defaultSettings.scripts).sort(), [...scriptKinds].sort());
  for (const kind of scriptKinds) {
    assert.deepEqual(defaultSettings.scripts[kind], defaultScriptSettings);
    assert.equal(defaultSettings.scripts[kind].command, "", "off by default");
  }
  assert.ok(defaultScriptSettings.timeoutSeconds <= scriptLimits.timeoutSeconds);
  assert.equal(defaultScriptSettings.abortOnFailure, true);
});

test("mergeSettings applies script overrides field by field and trims the command", () => {
  const merged = mergeSettings({ scripts: { preWorktreeDelete: { command: "  make clean \n", abortOnFailure: false, timeoutSeconds: 30 } } });
  assert.deepEqual(merged.gitActions, defaultSettings.gitActions);
  assert.deepEqual(merged.orchestrator, orchestratorDefaults);
  assert.deepEqual(merged.scripts.preWorktreeDelete, { command: "make clean", abortOnFailure: false, timeoutSeconds: 30 });
  assert.notEqual(mergeSettings({}).scripts, defaultSettings.scripts, "returns a fresh scripts section");
  assert.notEqual(mergeSettings({}).scripts.preWorktreeDelete, defaultSettings.scripts.preWorktreeDelete);

  // Ill-typed or out-of-range values leave the default in place; a blank command is a real value (off).
  const lenient = mergeSettings({ scripts: { preWorktreeDelete: { command: 7, abortOnFailure: "yes", timeoutSeconds: 0 } } });
  assert.deepEqual(lenient.scripts, defaultScripts);
  assert.equal(mergeSettings({ scripts: { preWorktreeDelete: { timeoutSeconds: scriptLimits.timeoutSeconds + 1 } } }).scripts.preWorktreeDelete.timeoutSeconds, defaultScriptSettings.timeoutSeconds);
  assert.equal(mergeSettings({ scripts: { preWorktreeDelete: { timeoutSeconds: 2.5 } } }).scripts.preWorktreeDelete.timeoutSeconds, defaultScriptSettings.timeoutSeconds);
  assert.equal(mergeScripts(mergeSettings({ scripts: { preWorktreeDelete: { command: "x" } } }).scripts, { preWorktreeDelete: { command: "  " } }).preWorktreeDelete.command, "");
  // Unknown script kinds are ignored.
  assert.deepEqual(mergeSettings({ scripts: { postCreate: { command: "x" } } }).scripts, defaultScripts);
});

test("settingsOverrides writes only the script fields that differ, and round-trips", () => {
  assert.equal(scriptsOverrides(defaultScripts), undefined);
  const merged = mergeSettings({ scripts: { preWorktreeDelete: { command: "make clean" } } });
  assert.deepEqual(settingsOverrides(merged), { scripts: { preWorktreeDelete: { command: "make clean" } } });
  assert.deepEqual(mergeSettings(settingsOverrides(merged)), merged);
  const toggled = mergeSettings({ scripts: { preWorktreeDelete: { abortOnFailure: false, timeoutSeconds: defaultScriptSettings.timeoutSeconds } } });
  assert.deepEqual(settingsOverrides(toggled), { scripts: { preWorktreeDelete: { abortOnFailure: false } } });
});

test("applySettingsPatch layers script fields and keeps the ones a patch leaves out", () => {
  const first = applySettingsPatch(defaultSettings, { scripts: { preWorktreeDelete: { command: "make clean", timeoutSeconds: 60 } } });
  const second = applySettingsPatch(first, { scripts: { preWorktreeDelete: { abortOnFailure: false } } });
  assert.deepEqual(second.scripts.preWorktreeDelete, { command: "make clean", abortOnFailure: false, timeoutSeconds: 60 });
  // A blank command turns the script off but keeps its other fields for next time.
  const off = applySettingsPatch(second, { scripts: { preWorktreeDelete: { command: "" } } });
  assert.deepEqual(off.scripts.preWorktreeDelete, { command: "", abortOnFailure: false, timeoutSeconds: 60 });
  // Other sections are untouched.
  assert.deepEqual(off.gitActions, defaultSettings.gitActions);
  assert.deepEqual(off.orchestrator, defaultSettings.orchestrator);
  assert.deepEqual(applySettingsPatch(second, { gitActions: { prompts: { checks: "x" } } }).scripts, second.scripts);
});

test("a provider change without a model takes that provider's default for the role, so the model follows the provider", () => {
  const start = mergeSettings(null);
  assert.equal(start.orchestrator.model, "claude-opus-5-5");
  const switched = applySettingsPatch(start, { orchestrator: { provider: "openai" } });
  assert.equal(switched.orchestrator.provider, "openai");
  assert.equal(switched.orchestrator.model, "gpt-5");
  // Naming a model with the provider keeps that model; re-sending the same provider keeps the current one.
  assert.equal(applySettingsPatch(start, { orchestrator: { provider: "openai", model: "gpt-x" } }).orchestrator.model, "gpt-x");
  const custom = applySettingsPatch(start, { orchestrator: { model: "claude-custom" } });
  assert.equal(applySettingsPatch(custom, { orchestrator: { provider: "anthropic" } }).orchestrator.model, "claude-custom");
  // The bookkeeping role follows the same rule on its own.
  const cheap = applySettingsPatch(start, { orchestrator: { bookkeeping: { provider: "openai" } } });
  assert.deepEqual(cheap.orchestrator.bookkeeping, { provider: "openai", model: "gpt-5-mini" });
  assert.equal(cheap.orchestrator.model, "claude-opus-5-5");
  assert.deepEqual(applySettingsPatch(cheap, { orchestrator: { bookkeeping: { model: "gpt-nano" } } }).orchestrator.bookkeeping, { provider: "openai", model: "gpt-nano" });
  // An old overrides file that switched to anthropic but kept the OpenAI model id now reads a Claude model.
  assert.equal(mergeSettings({ orchestrator: { provider: "openai" } }).orchestrator.model, "gpt-5");
});

test("the review toggle defaults to on, merges only a boolean, and is written only when it differs", () => {
  assert.deepEqual(orchestratorDefaults.reviews, { answerReadOnly: true });
  assert.equal(mergeSettings({ orchestrator: { reviews: { answerReadOnly: false } } }).orchestrator.reviews.answerReadOnly, false);
  assert.equal(mergeSettings({ orchestrator: { reviews: { answerReadOnly: "no" } } }).orchestrator.reviews.answerReadOnly, true, "a non-boolean leaves the default");
  const off = mergeSettings({ orchestrator: { reviews: { answerReadOnly: false } } });
  assert.deepEqual(settingsOverrides(off).orchestrator, { reviews: { answerReadOnly: false } });
  assert.equal(settingsOverrides(mergeSettings({})).orchestrator, undefined);
});

test("the hung threshold defaults to 15 minutes, merges only whole minutes in range, and is written only when it differs", () => {
  assert.deepEqual(orchestratorDefaults.stalls, { hungAfterMinutes: 15 });
  assert.equal(mergeSettings({ orchestrator: { stalls: { hungAfterMinutes: 45 } } }).orchestrator.stalls.hungAfterMinutes, 45);
  for (const bad of [0, -5, 1.5, "30", 100_000, null]) {
    assert.equal(mergeSettings({ orchestrator: { stalls: { hungAfterMinutes: bad } } }).orchestrator.stalls.hungAfterMinutes, 15, String(bad));
  }
  const longer = applySettingsPatch(defaultSettings, { orchestrator: { stalls: { hungAfterMinutes: 60 } } });
  assert.deepEqual(settingsOverrides(longer).orchestrator, { stalls: { hungAfterMinutes: 60 } });
  assert.deepEqual(mergeSettings(settingsOverrides(longer)), longer);
  // A patch about something else keeps it.
  assert.equal(applySettingsPatch(longer, { orchestrator: { model: "claude-x" } }).orchestrator.stalls.hungAfterMinutes, 60);
});

test("isLifecycleHours accepts whole hours from 1 to 720 only", () => {
  assert.deepEqual(sessionsLimits, { minHours: 1, maxHours: 720 });
  for (const good of [1, 48, 72, 720]) assert.equal(isLifecycleHours(good), true, String(good));
  for (const bad of [0, -1, 721, 1.5, NaN, Infinity, "48", null, undefined, true]) assert.equal(isLifecycleHours(bad), false, String(bad));
});

test("the sessions clocks default to 48h and 72h, merge only whole hours in range, and are written only when they differ", () => {
  assert.deepEqual(defaultSettings.sessions, { tracked: { untrackAfterHours: 48 }, worktrees: { removeAfterHours: 72 } });
  // Stored overrides from before the section existed get the defaults.
  assert.deepEqual(mergeSettings({ gitActions: { prompts: { checks: "x" } } }).sessions, defaultSessionsSettings);
  assert.deepEqual(mergeSettings({ sessions: {} }).sessions, defaultSessionsSettings);
  assert.deepEqual(mergeSettings({ sessions: "x" }).sessions, defaultSessionsSettings);

  assert.deepEqual(mergeSettings({ sessions: { tracked: { untrackAfterHours: 1 } } }).sessions, { tracked: { untrackAfterHours: 1 }, worktrees: { removeAfterHours: 72 } });
  assert.deepEqual(mergeSettings({ sessions: { worktrees: { removeAfterHours: 720 } } }).sessions, { tracked: { untrackAfterHours: 48 }, worktrees: { removeAfterHours: 720 } });
  for (const bad of [0, 721, 2.5, "24", null]) {
    assert.deepEqual(mergeSettings({ sessions: { tracked: { untrackAfterHours: bad }, worktrees: { removeAfterHours: bad } } }).sessions, defaultSessionsSettings, String(bad));
  }
  assert.deepEqual(mergeSettings({ sessions: { tracked: 5, worktrees: null } }).sessions, defaultSessionsSettings);

  const changed = applySettingsPatch(defaultSettings, { sessions: { tracked: { untrackAfterHours: 24 } } });
  assert.deepEqual(changed.sessions, { tracked: { untrackAfterHours: 24 }, worktrees: { removeAfterHours: 72 } });
  assert.deepEqual(settingsOverrides(changed), { sessions: { tracked: { untrackAfterHours: 24 } } });
  assert.deepEqual(mergeSettings(settingsOverrides(changed)), changed);
  // A patch about another field or section keeps it; a bad value in a patch leaves the current one.
  const both = applySettingsPatch(changed, { sessions: { worktrees: { removeAfterHours: 168 } } });
  assert.deepEqual(both.sessions, { tracked: { untrackAfterHours: 24 }, worktrees: { removeAfterHours: 168 } });
  assert.deepEqual(applySettingsPatch(both, { orchestrator: { model: "claude-x" } }).sessions, both.sessions);
  assert.deepEqual(applySettingsPatch(both, { sessions: { tracked: { untrackAfterHours: 0 } } }).sessions, both.sessions);
  // Back to the default value means no override.
  const reset = applySettingsPatch(both, { sessions: { tracked: { untrackAfterHours: 48 }, worktrees: { removeAfterHours: 72 } } });
  assert.deepEqual(settingsOverrides(reset), {});
});
