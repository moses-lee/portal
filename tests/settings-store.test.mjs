import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultSettings } from "../src/lib/settings.ts";
import { SettingsError, createSettingsStore, defaultSettingsFile, parseSettingsPatch } from "../src/lib/settings-store.ts";

const defaults = defaultSettings.gitActions.prompts;

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
  assert.ok(!existsSync(path.dirname(file)), "reading does not create the directory");
});

test("patch() writes only the overrides, creates the parent directory, and a fresh store reloads them", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const result = await store.patch({ gitActions: { prompts: { checks: "Look at CI" } } });
  assert.deepEqual(result, { version: 1, gitActions: { prompts: { ...defaults, checks: "Look at CI" } } });
  assert.ok(existsSync(path.dirname(file)), "parent directory created");
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
  // Unknown keys outside prompts are ignored.
  assert.deepEqual(await store.patch({ theme: "dark", gitActions: { colour: "red" } }), result);
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

  // An unexpected version is treated the same way.
  writeFileSync(file, JSON.stringify({ version: 2, gitActions: { prompts: { checks: "new format" } } }));
  const other = open();
  assert.deepEqual(await other.read(), defaultSettings);
  assert.equal(warn.mock.callCount(), 2);

  // Unknown kinds and non-string prompts in a well-formed file are simply ignored.
  writeFileSync(file, JSON.stringify({ version: 1, gitActions: { prompts: { checks: "ok", deploy: "x", review: 5 } } }));
  const lenient = open();
  assert.deepEqual((await lenient.read()).gitActions.prompts, { ...defaults, checks: "ok" });
  assert.equal(warn.mock.callCount(), 2);
});

test("serializes concurrent patches so none is lost", async (t) => {
  const { file, open } = setup(t);
  const store = open();
  const results = await Promise.all([
    store.patch({ gitActions: { prompts: { checks: "A" } } }),
    store.patch({ gitActions: { prompts: { conflicts: "B" } } }),
    store.patch({ gitActions: { prompts: { review: "C" } } }),
  ]);
  assert.deepEqual(results[2].gitActions.prompts, { checks: "A", conflicts: "B", review: "C" });
  assert.deepEqual(readJson(file).gitActions.prompts, { checks: "A", conflicts: "B", review: "C" });
  assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"]);
  assert.deepEqual((await open().read()).gitActions.prompts, { checks: "A", conflicts: "B", review: "C" });
});
