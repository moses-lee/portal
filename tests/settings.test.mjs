import assert from "node:assert/strict";
import test from "node:test";
import { applySettingsPatch, defaultSettings, gitActionKinds, mergeSettings, settingsOverrides } from "../src/lib/settings.ts";

test("gitActionKinds names every default prompt", () => {
  assert.deepEqual(gitActionKinds, ["checks", "conflicts", "review"]);
  assert.deepEqual(Object.keys(defaultSettings.gitActions.prompts).sort(), [...gitActionKinds].sort());
  for (const kind of gitActionKinds) assert.ok(defaultSettings.gitActions.prompts[kind].trim().length > 0);
});

test("mergeSettings fills in defaults and ignores blank overrides", () => {
  assert.deepEqual(mergeSettings(null), defaultSettings);
  assert.deepEqual(mergeSettings(undefined), defaultSettings);
  assert.deepEqual(mergeSettings({}), defaultSettings);
  assert.deepEqual(mergeSettings({ gitActions: {} }), defaultSettings);
  assert.notEqual(mergeSettings({}), defaultSettings, "returns a fresh object");

  const merged = mergeSettings({ gitActions: { prompts: { checks: "Look at CI", review: "   " } } });
  assert.deepEqual(merged, {
    version: 1,
    gitActions: { prompts: { ...defaultSettings.gitActions.prompts, checks: "Look at CI" } },
  });
  // Non-string values are treated as absent.
  assert.deepEqual(mergeSettings({ gitActions: { prompts: { checks: 42 } } }), defaultSettings);
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

test("applySettingsPatch layers a patch on top and resets blank prompts to defaults", () => {
  const start = mergeSettings({ gitActions: { prompts: { checks: "A", review: "B" } } });
  const next = applySettingsPatch(start, { gitActions: { prompts: { review: "", conflicts: "C" } } });
  assert.deepEqual(next.gitActions.prompts, { checks: "A", conflicts: "C", review: defaultSettings.gitActions.prompts.review });
  assert.deepEqual(applySettingsPatch(start, {}), start);
});
