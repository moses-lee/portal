import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultOrchestratorSettings } from "../src/lib/orchestrator/types.ts";
import { defaultScriptSettings, defaultScripts, scriptLimits } from "../src/lib/scripts.ts";
import { defaultSettings } from "../src/lib/settings.ts";
import { SettingsError, createSettingsStore, defaultSettingsFile, parseSettingsFile, parseSettingsPatch } from "../src/lib/settings-store.ts";

const defaults = defaultSettings.gitActions.prompts;
const orchestratorDefaults = defaultOrchestratorSettings;

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-settings-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The store's parent directory (like a fresh PORTAL_HOME) does not exist yet.
  const file = path.join(root, "portal-home", "settings.json");
  return { root, file, open: () => createSettingsStore({ file }) };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function rejects400(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SettingsError, `expected a SettingsError, got ${err}`);
    assert.equal(err.status, 400, `expected 400, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test("defaultSettingsFile honours PORTAL_HOME", () => {
  const previous = process.env.PORTAL_HOME;
  try {
    delete process.env.PORTAL_HOME;
    assert.equal(defaultSettingsFile(), path.join(os.homedir(), ".portal", "settings.json"));
    process.env.PORTAL_HOME = "/custom/portal";
    assert.equal(defaultSettingsFile(), path.join("/custom/portal", "settings.json"));
  } finally {
    if (previous === undefined) delete process.env.PORTAL_HOME; else process.env.PORTAL_HOME = previous;
  }
});

test("read() with no file returns the defaults and writes nothing", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  assert.deepEqual(await store.read(), defaultSettings);
  assert.deepEqual(await store.orchestrator(), orchestratorDefaults);
  assert.equal(await store.apiKey("openai"), null);
  assert.equal(await store.apiKey("anthropic"), null);
  assert.ok(!existsSync(path.dirname(file)), "reading does not create the directory");
});

test("patch() writes only the overrides, creates the parent directory, and a fresh store reloads them", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const result = await store.patch({ gitActions: { prompts: { checks: "Look at CI" } } });
  assert.deepEqual(result, {
    version: 1,
    gitActions: { prompts: { ...defaults, checks: "Look at CI" } },
    orchestrator: orchestratorDefaults,
    scripts: defaultScripts,
  });
  assert.ok(existsSync(path.dirname(file)), "parent directory created");
  // The file will hold API keys: private to the user, like the orchestrator's directory.
  assert.equal(statSync(path.dirname(file)).mode & 0o077, 0, "a fresh PORTAL_HOME is 0700");
  assert.equal(statSync(file).mode & 0o777, 0o600, "the file is 0600");
  assert.deepEqual(readJson(file), { version: 1, gitActions: { prompts: { checks: "Look at CI" } } });
  assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"], "no temp files left behind");

  assert.deepEqual(await store.read(), result);
  assert.deepEqual(await open().read(), result);

  // A second patch keeps the first override.
  const both = await store.patch({ gitActions: { prompts: { review: "Summarize reviews" } } });
  assert.deepEqual(both.gitActions.prompts, { ...defaults, checks: "Look at CI", review: "Summarize reviews" });
  assert.deepEqual(readJson(file).gitActions.prompts, { checks: "Look at CI", review: "Summarize reviews" });
});

test("a blank prompt removes the override and the file returns to {version:1}", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  await store.patch({ gitActions: { prompts: { checks: "Look at CI", conflicts: "Explain" } } });

  const one = await store.patch({ gitActions: { prompts: { checks: "" } } });
  assert.equal(one.gitActions.prompts.checks, defaults.checks);
  assert.deepEqual(readJson(file), { version: 1, gitActions: { prompts: { conflicts: "Explain" } } });

  const none = await store.patch({ gitActions: { prompts: { conflicts: "   \n\t" } } });
  assert.deepEqual(none, defaultSettings);
  assert.deepEqual(readJson(file), { version: 1 });
  assert.deepEqual(await open().read(), defaultSettings);

  // Setting a prompt to exactly its default text is not an override either.
  await store.patch({ gitActions: { prompts: { review: defaults.review } } });
  assert.deepEqual(readJson(file), { version: 1 });
});

test("prompts are trimmed, and empty patches are accepted", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const result = await store.patch({ gitActions: { prompts: { review: "  Summarize reviews \n" } } });
  assert.equal(result.gitActions.prompts.review, "Summarize reviews");
  assert.deepEqual(readJson(file), { version: 1, gitActions: { prompts: { review: "Summarize reviews" } } });

  assert.deepEqual(await store.patch({}), result);
  assert.deepEqual(await store.patch({ gitActions: {} }), result);
  assert.deepEqual(await store.patch({ gitActions: { prompts: {} } }), result);
  assert.deepEqual(await store.patch({ orchestrator: {} }), result);
  // Unknown keys outside prompts are ignored.
  assert.deepEqual(await store.patch({ theme: "dark", gitActions: { colour: "red" }, orchestrator: { colour: "blue" } }), result);
});

test("rejects malformed patches with 400 before touching the disk", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  for (const bad of [null, undefined, "x", 3, true, [], [{}]]) {
    await rejects400(store.patch(bad), /JSON object/);
  }
  await rejects400(store.patch({ gitActions: null }), /gitActions/);
  await rejects400(store.patch({ gitActions: "x" }), /gitActions/);
  await rejects400(store.patch({ gitActions: { prompts: [] } }), /prompts/);
  await rejects400(store.patch({ gitActions: { prompts: { deploy: "x" } } }), /Unknown git action "deploy"/);
  await rejects400(store.patch({ gitActions: { prompts: { checks: 1 } } }), /checks prompt must be a string/);
  await rejects400(store.patch({ gitActions: { prompts: { checks: null } } }), /string/);
  await rejects400(store.patch({ gitActions: { prompts: { checks: ["a"] } } }), /string/);
  await rejects400(store.patch({ gitActions: { prompts: { review: "a".repeat(4001) } } }), /too long/);
  assert.ok(!existsSync(path.dirname(file)), "nothing written for rejected patches");

  // The limit applies after trimming, and exactly 4000 characters is fine.
  const max = "b".repeat(4000);
  const result = await store.patch({ gitActions: { prompts: { review: `  ${max}  ` } } });
  assert.equal(result.gitActions.prompts.review, max);
  await rejects400(store.patch({ gitActions: { prompts: { review: `${max}c` } } }), /4001 characters/);

  // parseSettingsPatch is the same validator, usable without a store.
  assert.deepEqual(parseSettingsPatch({ gitActions: { prompts: { checks: " x " } } }), { gitActions: { prompts: { checks: "x" } } });
  assert.throws(() => parseSettingsPatch([]), SettingsError);
});

test("orchestrator patches: keys are stored on disk, masked on read, and readable through apiKey()", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const result = await store.patch({
    orchestrator: { provider: "anthropic", model: "  claude-x ", intervalMinutes: 5, apiKeys: { anthropic: " sk-ant-secret " } },
  });
  assert.deepEqual(result.orchestrator, {
    provider: "anthropic",
    model: "claude-x",
    intervalMinutes: 5,
    idleIntervalMinutes: orchestratorDefaults.idleIntervalMinutes,
    apiKeys: { openai: false, anthropic: true },
  });
  assert.deepEqual(result.gitActions, defaultSettings.gitActions, "the other section is untouched");
  assert.ok(!JSON.stringify(result).includes("sk-ant"), "the returned settings never contain a key");
  assert.deepEqual(readJson(file), {
    version: 1,
    orchestrator: { provider: "anthropic", model: "claude-x", intervalMinutes: 5, apiKeys: { anthropic: "sk-ant-secret" } },
  });

  assert.deepEqual(await store.read(), result);
  assert.deepEqual(await store.orchestrator(), result.orchestrator);
  assert.equal(await store.apiKey("anthropic"), "sk-ant-secret");
  assert.equal(await store.apiKey("openai"), null);
  assert.equal(await store.apiKey("google"), null, "unknown providers read as no key");
  assert.equal(await open().apiKey("anthropic"), "sk-ant-secret", "a fresh store reloads the key");

  // A patch to the other section keeps the key and the orchestrator overrides.
  const prompts = await store.patch({ gitActions: { prompts: { checks: "Look at CI" } } });
  assert.deepEqual(prompts.orchestrator, result.orchestrator);
  assert.equal(await store.apiKey("anthropic"), "sk-ant-secret");
  assert.deepEqual(readJson(file).orchestrator, { provider: "anthropic", model: "claude-x", intervalMinutes: 5, apiKeys: { anthropic: "sk-ant-secret" } });

  // A patch to another orchestrator field keeps the key too; the second provider's key sits alongside.
  const more = await store.patch({ orchestrator: { idleIntervalMinutes: 240, apiKeys: { openai: "sk-openai" } } });
  assert.deepEqual(more.orchestrator.apiKeys, { openai: true, anthropic: true });
  assert.equal(more.orchestrator.idleIntervalMinutes, 240);
  assert.deepEqual(readJson(file).orchestrator.apiKeys, { anthropic: "sk-ant-secret", openai: "sk-openai" });
  assert.equal(await store.apiKey("openai"), "sk-openai");

  // Fields set back to their defaults leave the file; keys stay.
  const reset = await store.patch({
    orchestrator: { provider: orchestratorDefaults.provider, model: orchestratorDefaults.model, intervalMinutes: orchestratorDefaults.intervalMinutes, idleIntervalMinutes: orchestratorDefaults.idleIntervalMinutes },
  });
  assert.deepEqual(reset.orchestrator, { ...orchestratorDefaults, apiKeys: { openai: true, anthropic: true } });
  assert.deepEqual(readJson(file), {
    version: 1,
    gitActions: { prompts: { checks: "Look at CI" } },
    orchestrator: { apiKeys: { anthropic: "sk-ant-secret", openai: "sk-openai" } },
  });
});

test("an empty string clears a key; a whitespace-only key is a clear too", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  await store.patch({ orchestrator: { apiKeys: { openai: "sk-openai", anthropic: "sk-ant" } } });
  assert.deepEqual((await store.read()).orchestrator.apiKeys, { openai: true, anthropic: true });

  const one = await store.patch({ orchestrator: { apiKeys: { openai: "" } } });
  assert.deepEqual(one.orchestrator.apiKeys, { openai: false, anthropic: true });
  assert.equal(await store.apiKey("openai"), null);
  assert.equal(await store.apiKey("anthropic"), "sk-ant");
  assert.deepEqual(readJson(file), { version: 1, orchestrator: { apiKeys: { anthropic: "sk-ant" } } });

  const none = await store.patch({ orchestrator: { apiKeys: { anthropic: "   " } } });
  assert.deepEqual(none, defaultSettings);
  assert.deepEqual(readJson(file), { version: 1 }, "no empty orchestrator section is left behind");
  assert.equal(await open().apiKey("anthropic"), null);

  // Clearing a key that is not stored is a no-op.
  assert.deepEqual(await store.patch({ orchestrator: { apiKeys: { openai: "" } } }), defaultSettings);
  assert.deepEqual(readJson(file), { version: 1 });
});

test("rejects malformed orchestrator patches with 400 before touching the disk", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  await rejects400(store.patch({ orchestrator: null }), /orchestrator must be an object/);
  await rejects400(store.patch({ orchestrator: [] }), /orchestrator must be an object/);
  await rejects400(store.patch({ orchestrator: "openai" }), /orchestrator/);

  await rejects400(store.patch({ orchestrator: { provider: "google" } }), /Unknown provider "google"; expected one of openai, anthropic/);
  await rejects400(store.patch({ orchestrator: { provider: 1 } }), /Unknown provider/);
  await rejects400(store.patch({ orchestrator: { provider: null } }), /Unknown provider/);

  await rejects400(store.patch({ orchestrator: { model: "" } }), /model must not be empty/);
  await rejects400(store.patch({ orchestrator: { model: "   " } }), /model must not be empty/);
  await rejects400(store.patch({ orchestrator: { model: 5 } }), /model must be a string/);
  await rejects400(store.patch({ orchestrator: { model: "m".repeat(101) } }), /model is too long \(101 characters; the limit is 100\)/);

  for (const bad of [0, -1, 1.5, "10", null, 1441, Number.NaN, Number.POSITIVE_INFINITY]) {
    await rejects400(store.patch({ orchestrator: { intervalMinutes: bad } }), /intervalMinutes must be a whole number of minutes between 1 and 1440/);
  }
  for (const bad of [0, 2.5, "60", 10081]) {
    await rejects400(store.patch({ orchestrator: { idleIntervalMinutes: bad } }), /idleIntervalMinutes must be a whole number of minutes between 1 and 10080/);
  }

  await rejects400(store.patch({ orchestrator: { apiKeys: [] } }), /apiKeys must be an object/);
  await rejects400(store.patch({ orchestrator: { apiKeys: "sk" } }), /apiKeys must be an object/);
  await rejects400(store.patch({ orchestrator: { apiKeys: { google: "sk" } } }), /Unknown provider "google"/);
  await rejects400(store.patch({ orchestrator: { apiKeys: { openai: 1 } } }), /openai API key must be a string/);
  await rejects400(store.patch({ orchestrator: { apiKeys: { openai: null } } }), /openai API key must be a string/);
  await rejects400(store.patch({ orchestrator: { apiKeys: { anthropic: "k".repeat(513) } } }), /anthropic API key is too long \(513 characters; the limit is 512\)/);

  // One bad field rejects the whole patch, even when the others are fine.
  await rejects400(store.patch({ orchestrator: { model: "ok", provider: "nope" } }), /Unknown provider/);
  await rejects400(store.patch({ gitActions: { prompts: { checks: "ok" } }, orchestrator: { intervalMinutes: 0 } }), /intervalMinutes/);
  assert.ok(!existsSync(path.dirname(file)), "nothing written for rejected patches");

  // Boundaries are inclusive, and lengths apply after trimming.
  const result = await store.patch({
    orchestrator: { model: ` ${"m".repeat(100)} `, intervalMinutes: 1440, idleIntervalMinutes: 1, apiKeys: { openai: ` ${"k".repeat(512)} ` } },
  });
  assert.equal(result.orchestrator.model, "m".repeat(100));
  assert.equal(result.orchestrator.intervalMinutes, 1440);
  assert.equal(result.orchestrator.idleIntervalMinutes, 1);
  assert.equal(await store.apiKey("openai"), "k".repeat(512));

  // parseSettingsPatch trims and returns only the sections given.
  assert.deepEqual(parseSettingsPatch({ orchestrator: { model: " gpt-x ", apiKeys: { openai: " k " } } }), {
    orchestrator: { model: "gpt-x", apiKeys: { openai: "k" } },
  });
  assert.deepEqual(parseSettingsPatch({ orchestrator: {} }), { orchestrator: {} });
  assert.deepEqual(Object.keys(parseSettingsPatch({ gitActions: {} })), ["gitActions"]);
  assert.deepEqual(Object.keys(parseSettingsPatch({ orchestrator: {} })), ["orchestrator"]);
});

test("a corrupt or unexpected file reads as defaults, warns once, and is backed up on the first change", async (t) => {
  const { file, open } = setup(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "{ not json");
  const warn = t.mock.method(console, "warn", () => {});
  const store = open();
  assert.deepEqual(await store.read(), defaultSettings);
  assert.deepEqual(await store.read(), defaultSettings);
  assert.equal(warn.mock.callCount(), 1, "warns once, not on every read");
  assert.equal(readFileSync(file, "utf8"), "{ not json", "nothing is written until a change");

  await store.patch({ gitActions: { prompts: { checks: "Look at CI" } } });
  const names = readdirSync(path.dirname(file)).sort();
  assert.equal(names.length, 2, `expected the file and one backup in ${names}`);
  const backup = names.find((name) => name.startsWith("settings.json.bad-"));
  assert.ok(backup, `expected a .bad- backup in ${names}`);
  assert.equal(readFileSync(path.join(path.dirname(file), backup), "utf8"), "{ not json");
  assert.deepEqual(readJson(file), { version: 1, gitActions: { prompts: { checks: "Look at CI" } } });

  // A JSON value that is not an object is corrupt too.
  writeFileSync(file, JSON.stringify(["version", 1]));
  assert.deepEqual(await open().read(), defaultSettings);
  assert.equal(warn.mock.callCount(), 2);

  // Unknown kinds and non-string prompts in a well-formed file are simply ignored.
  writeFileSync(file, JSON.stringify({ version: 1, gitActions: { prompts: { checks: "ok", deploy: "x", review: 5 } } }));
  const lenient = open();
  assert.deepEqual((await lenient.read()).gitActions.prompts, { ...defaults, checks: "ok" });
  assert.equal(warn.mock.callCount(), 2);
});

test("an unexpected version or a malformed section never costs the API keys", async (t) => {
  const { file, open } = setup(t);
  mkdirSync(path.dirname(file), { recursive: true });
  const warn = t.mock.method(console, "warn", () => {});

  // A file from a newer Portal: what is recognisable is read, and nothing is moved aside.
  writeFileSync(file, JSON.stringify({
    version: 2, gitActions: { prompts: { checks: "new format" } }, orchestrator: { model: "gpt-9", apiKeys: { openai: "sk-keep" } }, theme: "dark",
  }));
  const newer = open();
  const settings = await newer.read();
  assert.equal(settings.gitActions.prompts.checks, "new format");
  assert.equal(settings.orchestrator.model, "gpt-9");
  assert.deepEqual(settings.orchestrator.apiKeys, { openai: true, anthropic: false });
  assert.equal(await newer.apiKey("openai"), "sk-keep");
  assert.equal(warn.mock.callCount(), 0, "not corrupt");

  // The change that used to lose the key: a prompt patch rewrites the file, and the key is still in it.
  await newer.patch({ gitActions: { prompts: { review: "Summarize" } } });
  assert.equal(await newer.apiKey("openai"), "sk-keep");
  assert.deepEqual(readJson(file), {
    version: 1,
    gitActions: { prompts: { checks: "new format", review: "Summarize" } },
    orchestrator: { model: "gpt-9", apiKeys: { openai: "sk-keep" } },
  });
  assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"], "no backup was made");
  assert.equal(await open().apiKey("openai"), "sk-keep");

  // gitActions that is not an object, or prompts that are not, is dropped on its own; the keys survive.
  for (const gitActions of ["x", null, [], 3, { prompts: [] }, { prompts: "checks" }]) {
    writeFileSync(file, JSON.stringify({ version: 1, gitActions, orchestrator: { apiKeys: { anthropic: "sk-ant" } } }));
    const store = open();
    assert.deepEqual((await store.read()).gitActions, defaultSettings.gitActions, `gitActions ${JSON.stringify(gitActions)} reads as defaults`);
    assert.equal(await store.apiKey("anthropic"), "sk-ant");
    await store.patch({ gitActions: { prompts: { checks: "CI" } } });
    assert.deepEqual(readJson(file), { version: 1, gitActions: { prompts: { checks: "CI" } }, orchestrator: { apiKeys: { anthropic: "sk-ant" } } });
    assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"]);
  }
  assert.equal(warn.mock.callCount(), 0);

  // parseSettingsFile gives up only on non-JSON and non-objects.
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 2, gitActions: "x", orchestrator: { apiKeys: { openai: "k" } } })), { orchestrator: { apiKeys: { openai: "k" } } });
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 3 })), {});
  assert.deepEqual(parseSettingsFile("{}"), {});
  assert.equal(parseSettingsFile("[]"), null);
  assert.equal(parseSettingsFile("null"), null);
  assert.equal(parseSettingsFile("42"), null);
});

test("bad orchestrator values in the file fall back to defaults field by field", async (t) => {
  const { file, open } = setup(t);
  mkdirSync(path.dirname(file), { recursive: true });
  const warn = t.mock.method(console, "warn", () => {});
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      gitActions: { prompts: { checks: "ok" } },
      orchestrator: {
        provider: "google",
        model: " claude-x ",
        intervalMinutes: 0,
        idleIntervalMinutes: 30,
        apiKeys: { openai: "sk-openai", anthropic: 7, google: "sk-google" },
        colour: "blue",
      },
    }),
  );
  const store = open();
  const settings = await store.read();
  assert.deepEqual(settings.gitActions.prompts, { ...defaults, checks: "ok" }, "the other section is still read");
  assert.deepEqual(settings.orchestrator, {
    provider: orchestratorDefaults.provider,
    model: "claude-x",
    intervalMinutes: orchestratorDefaults.intervalMinutes,
    idleIntervalMinutes: 30,
    apiKeys: { openai: true, anthropic: false },
  });
  assert.equal(await store.apiKey("openai"), "sk-openai");
  assert.equal(await store.apiKey("anthropic"), null);
  assert.equal(warn.mock.callCount(), 0, "a well-formed file with bad values is not corrupt");

  // A change rewrites the file without the bad values, and keeps the good key.
  await store.patch({ orchestrator: { provider: "anthropic" } });
  assert.deepEqual(readJson(file), {
    version: 1,
    gitActions: { prompts: { checks: "ok" } },
    orchestrator: { provider: "anthropic", model: "claude-x", idleIntervalMinutes: 30, apiKeys: { openai: "sk-openai" } },
  });
  assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"], "no backup for a readable file");

  // An orchestrator section that is not an object is ignored, and so are blank or oversized values.
  writeFileSync(file, JSON.stringify({ version: 1, orchestrator: "openai" }));
  assert.deepEqual(await open().read(), defaultSettings);
  writeFileSync(
    file,
    JSON.stringify({ version: 1, orchestrator: { model: "  ", intervalMinutes: 99999, idleIntervalMinutes: 1.5, apiKeys: { openai: "", anthropic: "k".repeat(513) } } }),
  );
  const oversized = open();
  assert.deepEqual(await oversized.read(), defaultSettings);
  assert.equal(await oversized.apiKey("anthropic"), null);
  assert.equal(warn.mock.callCount(), 0);

  // parseSettingsFile exposes the same leniency without a store.
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 1, orchestrator: { provider: "anthropic", model: 3 } })), {
    orchestrator: { provider: "anthropic" },
  });
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 1, orchestrator: { model: 3 } })), {});
  assert.equal(parseSettingsFile("nope"), null);
});

test("subscribe() fires after every successful patch with the merged settings, and not for rejected ones", async (t) => {
  const { open } = setup(t);
  const store = open();
  const seen = [];
  const unsubscribe = store.subscribe((settings) => seen.push(settings));
  const other = [];
  store.subscribe((settings) => other.push(settings.orchestrator.intervalMinutes));

  const first = await store.patch({ orchestrator: { intervalMinutes: 3 } });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], first);
  assert.equal(seen[0].orchestrator.intervalMinutes, 3);
  assert.ok(!JSON.stringify(seen[0]).includes("sk-"), "listeners get the wire form too");

  await rejects400(store.patch({ orchestrator: { intervalMinutes: 0 } }));
  assert.equal(seen.length, 1, "a rejected patch does not notify");

  // A patch that changes nothing still notifies: the caller wrote, and listeners are cheap.
  await store.patch({});
  assert.equal(seen.length, 2);

  await store.patch({ orchestrator: { apiKeys: { openai: "sk-x" } } });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2].orchestrator.apiKeys, { openai: true, anthropic: false });

  unsubscribe();
  await store.patch({ gitActions: { prompts: { checks: "A" } } });
  assert.equal(seen.length, 3, "unsubscribed listeners are not called");
  assert.deepEqual(other, [3, 3, 3, 3], "the other listener kept receiving");

  // A throwing listener does not fail the patch or starve later listeners.
  const error = t.mock.method(console, "error", () => {});
  store.subscribe(() => {
    throw new Error("boom");
  });
  const after = [];
  store.subscribe((settings) => after.push(settings));
  const result = await store.patch({ orchestrator: { model: "gpt-x" } });
  assert.equal(result.orchestrator.model, "gpt-x");
  assert.equal(error.mock.callCount(), 1);
  assert.equal(after.length, 1);
});

test("serializes concurrent patches so none is lost", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const results = await Promise.all([
    store.patch({ gitActions: { prompts: { checks: "A" } } }),
    store.patch({ gitActions: { prompts: { conflicts: "B" } } }),
    store.patch({ orchestrator: { apiKeys: { openai: "sk-1" } } }),
    store.patch({ gitActions: { prompts: { review: "C" } } }),
    store.patch({ orchestrator: { model: "gpt-x", apiKeys: { anthropic: "sk-2" } } }),
  ]);
  assert.deepEqual(results[4].gitActions.prompts, { checks: "A", conflicts: "B", review: "C" });
  assert.deepEqual(results[4].orchestrator, { ...orchestratorDefaults, model: "gpt-x", apiKeys: { openai: true, anthropic: true } });
  assert.deepEqual(readJson(file), {
    version: 1,
    gitActions: { prompts: { checks: "A", conflicts: "B", review: "C" } },
    orchestrator: { model: "gpt-x", apiKeys: { openai: "sk-1", anthropic: "sk-2" } },
  });
  assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"]);
  assert.deepEqual((await open().read()).gitActions.prompts, { checks: "A", conflicts: "B", review: "C" });
});

test("script patches: fields are stored as overrides, trimmed, and a blank command turns the script off", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const one = await store.patch({ scripts: { preWorktreeDelete: { command: "  bazel clean  " } } });
  assert.deepEqual(one.scripts.preWorktreeDelete, { ...defaultScriptSettings, command: "bazel clean" });
  // Newlines and tabs are fine: a script may span lines.
  assert.equal((await store.patch({ scripts: { preWorktreeDelete: { command: "make clean\n\tmake distclean" } } })).scripts.preWorktreeDelete.command, "make clean\n\tmake distclean");
  await store.patch({ scripts: { preWorktreeDelete: { command: "bazel clean" } } });
  assert.deepEqual(readJson(file), { version: 1, scripts: { preWorktreeDelete: { command: "bazel clean" } } });

  const two = await store.patch({ scripts: { preWorktreeDelete: { abortOnFailure: false, timeoutSeconds: 45 } } });
  assert.deepEqual(two.scripts.preWorktreeDelete, { command: "bazel clean", abortOnFailure: false, timeoutSeconds: 45 });
  assert.deepEqual(readJson(file).scripts, { preWorktreeDelete: { command: "bazel clean", abortOnFailure: false, timeoutSeconds: 45 } });
  assert.deepEqual(await open().read(), two, "a fresh store reloads them");

  const off = await store.patch({ scripts: { preWorktreeDelete: { command: "" } } });
  assert.equal(off.scripts.preWorktreeDelete.command, "");
  assert.deepEqual(readJson(file).scripts, { preWorktreeDelete: { abortOnFailure: false, timeoutSeconds: 45 } });

  // Back to every default: the section disappears from the file.
  await store.patch({ scripts: { preWorktreeDelete: { abortOnFailure: true, timeoutSeconds: defaultScriptSettings.timeoutSeconds } } });
  assert.deepEqual(readJson(file), { version: 1 });
  // An empty patch for a known script is accepted and changes nothing.
  assert.deepEqual(await store.patch({ scripts: { preWorktreeDelete: {} } }), defaultSettings);
  assert.deepEqual(await store.patch({ scripts: {} }), defaultSettings);
});

test("rejects malformed script patches with 400 before touching the disk", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  await rejects400(store.patch({ scripts: "make clean" }), /scripts must be an object/);
  await rejects400(store.patch({ scripts: { postCreate: { command: "x" } } }), /Unknown script "postCreate"/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: "x" } }), /scripts.preWorktreeDelete must be an object/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { command: 5 } } }), /command must be a string/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { command: "x".repeat(scriptLimits.commandLength + 1) } } }), /too long/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { command: "echo hi\u0000" } } }), /control characters/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { command: "echo \u001b[31mred" } } }), /control characters/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { abortOnFailure: "no" } } }), /abortOnFailure must be a boolean/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { timeoutSeconds: 0 } } }), /timeoutSeconds must be a whole number/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { timeoutSeconds: scriptLimits.timeoutSeconds + 1 } } }), /timeoutSeconds/);
  await rejects400(store.patch({ scripts: { preWorktreeDelete: { timeoutSeconds: "30" } } }), /timeoutSeconds/);
  assert.ok(!existsSync(file));
  // Unknown fields inside a known script are ignored, like elsewhere.
  assert.deepEqual(await store.patch({ scripts: { preWorktreeDelete: { colour: "blue" } } }), defaultSettings);
});

test("bad script values in the file fall back to defaults field by field", async (t) => {
  const { file, open } = setup(t);
  mkdirSync(path.dirname(file), { recursive: true });
  const warn = t.mock.method(console, "warn", () => {});
  writeFileSync(file, JSON.stringify({
    version: 1,
    scripts: {
      preWorktreeDelete: { command: " make clean ", abortOnFailure: "yes", timeoutSeconds: 99999 },
      postCreate: { command: "ignored" },
    },
  }));
  const settings = await open().read();
  assert.deepEqual(settings.scripts.preWorktreeDelete, { ...defaultScriptSettings, command: "make clean" });
  assert.equal(warn.mock.callCount(), 0, "a well-formed file with bad values is not corrupt");
  writeFileSync(file, JSON.stringify({ version: 1, scripts: "make clean" }));
  assert.deepEqual(await open().read(), defaultSettings);
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 1, scripts: { preWorktreeDelete: { command: 3, timeoutSeconds: 12 } } })), {
    scripts: { preWorktreeDelete: { timeoutSeconds: 12 } },
  });
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 1, scripts: { preWorktreeDelete: { command: 3 } } })), {});
});
