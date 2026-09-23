import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { credentials, settings as settingsTable } from "../src/db/schema.ts";
import { defaultOrchestratorSettings } from "../src/orchestrator/types.ts";
import { defaultScriptSettings, defaultScripts, scriptLimits } from "@portal/shared/scripts";
import { defaultSettings } from "@portal/shared/settings";
import { SettingsError, defaultSettingsFile, parseSettingsFile, parseSettingsPatch, parseStoredOverrides } from "../src/lib/settings-store.ts";
import { decryptSecret, generateServerKey, serverKeyFile } from "../src/settings/crypto.ts";
import { OVERRIDES_KEY, createPgSettingsStore } from "../src/settings/pg-settings-store.ts";
import { createSettingsService } from "../src/settings/service.ts";
import { createMemorySettingsBackend, createMemorySettingsStore, createSettingsStore } from "../src/settings/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const defaults = defaultSettings.gitActions.prompts;
const orchestratorDefaults = defaultOrchestratorSettings;

async function rejects400(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SettingsError, `expected a SettingsError, got ${err}`);
    assert.equal(err.status, 400, `expected 400, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

async function pgStored(db, key) {
  const [row] = await db.select().from(settingsTable);
  const rows = await db.select().from(credentials);
  const keys = {};
  for (const cred of rows) keys[cred.name] = decryptSecret(key, cred.ciphertext, cred.name);
  return { overrides: row?.body ?? {}, keys, written: !!row || rows.length > 0 };
}

/**
 * Each backend gives `open()` (a fresh store over the same data, like a restart) and `stored()`:
 * what is persisted, as `{ overrides, keys }` with keys in plain text, plus whether anything was written.
 */
const backends = [
  ["memory", async () => {
    const backend = createMemorySettingsBackend();
    let written = false;
    const write = backend.write;
    backend.write = async (...args) => { written = true; return write(...args); };
    return {
      open: () => createSettingsStore(backend),
      stored: async () => ({ overrides: backend.overrides, keys: Object.fromEntries(backend.keys), written }),
    };
  }],
  ["postgres", async (t) => {
    const { db } = await temporaryDatabase(t);
    const key = generateServerKey();
    return { db, key, open: () => createPgSettingsStore({ db, key: async () => key }), stored: () => pgStored(db, key) };
  }],
];

for (const [name, make] of backends) {
  test(`${name}: read() with nothing stored returns the defaults and writes nothing`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    await store.ready;
    assert.deepEqual(await store.read(), defaultSettings);
    assert.deepEqual(await store.orchestrator(), orchestratorDefaults);
    assert.equal(await store.apiKey("openai"), null);
    assert.equal(await store.apiKey("anthropic"), null);
    assert.equal((await stored()).written, false, "reading writes nothing");
  });

  test(`${name}: patch() stores only the overrides, and a fresh store reloads them`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    const result = await store.patch({ gitActions: { prompts: { checks: "Look at CI" } } });
    assert.deepEqual(result, {
      version: 1,
      gitActions: { prompts: { ...defaults, checks: "Look at CI" } },
      orchestrator: orchestratorDefaults,
      scripts: defaultScripts,
    });
    assert.deepEqual(await stored(), { overrides: { gitActions: { prompts: { checks: "Look at CI" } } }, keys: {}, written: true });
    assert.deepEqual(await store.read(), result);
    assert.deepEqual(await open().read(), result);

    // A second patch keeps the first override.
    const both = await store.patch({ gitActions: { prompts: { review: "Summarize reviews" } } });
    assert.deepEqual(both.gitActions.prompts, { ...defaults, checks: "Look at CI", review: "Summarize reviews" });
    assert.deepEqual((await stored()).overrides.gitActions.prompts, { checks: "Look at CI", review: "Summarize reviews" });
  });

  test(`${name}: a blank prompt removes the override and the overrides return to {}`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    await store.patch({ gitActions: { prompts: { checks: "Look at CI", conflicts: "Explain" } } });

    const one = await store.patch({ gitActions: { prompts: { checks: "" } } });
    assert.equal(one.gitActions.prompts.checks, defaults.checks);
    assert.deepEqual((await stored()).overrides, { gitActions: { prompts: { conflicts: "Explain" } } });

    const none = await store.patch({ gitActions: { prompts: { conflicts: "   \n\t" } } });
    assert.deepEqual(none, defaultSettings);
    assert.deepEqual((await stored()).overrides, {});
    assert.deepEqual(await open().read(), defaultSettings);

    // Setting a prompt to exactly its default text is not an override either.
    await store.patch({ gitActions: { prompts: { review: defaults.review } } });
    assert.deepEqual((await stored()).overrides, {});
  });

  test(`${name}: prompts are trimmed, and empty patches are accepted`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    const result = await store.patch({ gitActions: { prompts: { review: "  Summarize reviews \n" } } });
    assert.equal(result.gitActions.prompts.review, "Summarize reviews");
    assert.deepEqual((await stored()).overrides, { gitActions: { prompts: { review: "Summarize reviews" } } });

    assert.deepEqual(await store.patch({}), result);
    assert.deepEqual(await store.patch({ gitActions: {} }), result);
    assert.deepEqual(await store.patch({ gitActions: { prompts: {} } }), result);
    assert.deepEqual(await store.patch({ orchestrator: {} }), result);
    // Unknown keys outside prompts are ignored.
    assert.deepEqual(await store.patch({ theme: "dark", gitActions: { colour: "red" }, orchestrator: { colour: "blue" } }), result);
  });

  test(`${name}: rejects malformed patches with 400 before writing anything`, async (t) => {
    const { open, stored } = await make(t);
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
    assert.equal((await stored()).written, false, "nothing written for rejected patches");

    // The limit applies after trimming, and exactly 4000 characters is fine.
    const max = "b".repeat(4000);
    const result = await store.patch({ gitActions: { prompts: { review: `  ${max}  ` } } });
    assert.equal(result.gitActions.prompts.review, max);
    await rejects400(store.patch({ gitActions: { prompts: { review: `${max}c` } } }), /4001 characters/);
  });

  test(`${name}: orchestrator keys are stored apart from the overrides, masked on read, and readable through apiKey()`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    const result = await store.patch({
      orchestrator: { provider: "anthropic", model: "  claude-x ", intervalMinutes: 5, apiKeys: { anthropic: " sk-ant-secret " } },
    });
    assert.deepEqual(result.orchestrator, {
      provider: "anthropic",
      model: "claude-x",
      bookkeeping: orchestratorDefaults.bookkeeping,
      intervalMinutes: 5,
      idleIntervalMinutes: orchestratorDefaults.idleIntervalMinutes,
      apiKeys: { openai: false, anthropic: true },
    });
    assert.deepEqual(result.gitActions, defaultSettings.gitActions, "the other section is untouched");
    assert.ok(!JSON.stringify(result).includes("sk-ant"), "the returned settings never contain a key");
    assert.deepEqual(await stored(), {
      overrides: { orchestrator: { model: "claude-x", intervalMinutes: 5 } },
      keys: { anthropic: "sk-ant-secret" },
      written: true,
    });

    const read = await store.read();
    assert.deepEqual(read, result);
    assert.ok(!JSON.stringify(read).includes("sk-ant"), "read() never returns a key");
    assert.deepEqual(await store.orchestrator(), result.orchestrator);
    assert.equal(await store.apiKey("anthropic"), "sk-ant-secret");
    assert.equal(await store.apiKey("openai"), null);
    assert.equal(await store.apiKey("google"), null, "unknown providers read as no key");
    assert.equal(await open().apiKey("anthropic"), "sk-ant-secret", "a fresh store reloads the key");

    // A patch to the other section keeps the key and the orchestrator overrides.
    const prompts = await store.patch({ gitActions: { prompts: { checks: "Look at CI" } } });
    assert.deepEqual(prompts.orchestrator, result.orchestrator);
    assert.equal(await store.apiKey("anthropic"), "sk-ant-secret");

    // A patch to another orchestrator field keeps the key too; the second provider's key sits alongside.
    const more = await store.patch({ orchestrator: { idleIntervalMinutes: 240, apiKeys: { openai: "sk-openai" } } });
    assert.deepEqual(more.orchestrator.apiKeys, { openai: true, anthropic: true });
    assert.equal(more.orchestrator.idleIntervalMinutes, 240);
    assert.deepEqual((await stored()).keys, { anthropic: "sk-ant-secret", openai: "sk-openai" });
    assert.equal(await store.apiKey("openai"), "sk-openai");

    // Fields set back to their defaults leave the overrides; keys stay.
    const reset = await store.patch({
      orchestrator: { provider: orchestratorDefaults.provider, model: orchestratorDefaults.model, intervalMinutes: orchestratorDefaults.intervalMinutes, idleIntervalMinutes: orchestratorDefaults.idleIntervalMinutes },
    });
    assert.deepEqual(reset.orchestrator, { ...orchestratorDefaults, apiKeys: { openai: true, anthropic: true } });
    assert.deepEqual(await stored(), {
      overrides: { gitActions: { prompts: { checks: "Look at CI" } } },
      keys: { anthropic: "sk-ant-secret", openai: "sk-openai" },
      written: true,
    });

    // Replacing a key replaces it.
    await store.patch({ orchestrator: { apiKeys: { openai: "sk-openai-2" } } });
    assert.equal(await open().apiKey("openai"), "sk-openai-2");
  });

  test(`${name}: an empty string clears a key; a whitespace-only key is a clear too`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    await store.patch({ orchestrator: { apiKeys: { openai: "sk-openai", anthropic: "sk-ant" } } });
    assert.deepEqual((await store.read()).orchestrator.apiKeys, { openai: true, anthropic: true });

    const one = await store.patch({ orchestrator: { apiKeys: { openai: "" } } });
    assert.deepEqual(one.orchestrator.apiKeys, { openai: false, anthropic: true });
    assert.equal(await store.apiKey("openai"), null);
    assert.equal(await store.apiKey("anthropic"), "sk-ant");
    assert.deepEqual(await stored(), { overrides: {}, keys: { anthropic: "sk-ant" }, written: true });

    const none = await store.patch({ orchestrator: { apiKeys: { anthropic: "   " } } });
    assert.deepEqual(none, defaultSettings);
    assert.deepEqual(await stored(), { overrides: {}, keys: {}, written: true }, "no empty orchestrator section is left behind");
    assert.equal(await open().apiKey("anthropic"), null);

    // Clearing a key that is not stored is a no-op.
    assert.deepEqual(await store.patch({ orchestrator: { apiKeys: { openai: "" } } }), defaultSettings);
    assert.deepEqual((await stored()).keys, {});
  });

  test(`${name}: rejects malformed orchestrator patches with 400 before writing anything`, async (t) => {
    const { open, stored } = await make(t);
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
    await rejects400(store.patch({ orchestrator: { apiKeys: { openai: "sk-ok", anthropic: 7 } } }), /anthropic API key/);
    assert.equal((await stored()).written, false, "nothing written for rejected patches");

    // Boundaries are inclusive, and lengths apply after trimming.
    const result = await store.patch({
      orchestrator: { model: ` ${"m".repeat(100)} `, intervalMinutes: 1440, idleIntervalMinutes: 1, apiKeys: { openai: ` ${"k".repeat(512)} ` } },
    });
    assert.equal(result.orchestrator.model, "m".repeat(100));
    assert.equal(result.orchestrator.intervalMinutes, 1440);
    assert.equal(result.orchestrator.idleIntervalMinutes, 1);
    assert.equal(await store.apiKey("openai"), "k".repeat(512));
  });

  test(`${name}: subscribe() fires after every successful patch with the merged settings, and not for rejected ones`, async (t) => {
    const { open } = await make(t);
    const store = open();
    const seen = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings));
    const other = [];
    store.subscribe((settings) => other.push(settings.orchestrator.intervalMinutes));

    const first = await store.patch({ orchestrator: { intervalMinutes: 3 } });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], first);
    assert.equal(seen[0].orchestrator.intervalMinutes, 3);

    await rejects400(store.patch({ orchestrator: { intervalMinutes: 0 } }));
    assert.equal(seen.length, 1, "a rejected patch does not notify");

    // A patch that changes nothing still notifies: the caller wrote, and listeners are cheap.
    await store.patch({});
    assert.equal(seen.length, 2);

    await store.patch({ orchestrator: { apiKeys: { openai: "sk-x" } } });
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[2].orchestrator.apiKeys, { openai: true, anthropic: false });
    assert.ok(!JSON.stringify(seen).includes("sk-x"), "listeners get the wire form too");

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

  test(`${name}: serializes concurrent patches so none is lost`, async (t) => {
    const { open, stored } = await make(t);
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
    assert.deepEqual(await stored(), {
      overrides: { gitActions: { prompts: { checks: "A", conflicts: "B", review: "C" } }, orchestrator: { model: "gpt-x" } },
      keys: { openai: "sk-1", anthropic: "sk-2" },
      written: true,
    });
    assert.deepEqual((await open().read()).gitActions.prompts, { checks: "A", conflicts: "B", review: "C" });
  });

  test(`${name}: script patches are stored as overrides, trimmed, and a blank command turns the script off`, async (t) => {
    const { open, stored } = await make(t);
    const store = open();
    const one = await store.patch({ scripts: { preWorktreeDelete: { command: "  bazel clean  " } } });
    assert.deepEqual(one.scripts.preWorktreeDelete, { ...defaultScriptSettings, command: "bazel clean" });
    // Newlines and tabs are fine: a script may span lines.
    assert.equal((await store.patch({ scripts: { preWorktreeDelete: { command: "make clean\n\tmake distclean" } } })).scripts.preWorktreeDelete.command, "make clean\n\tmake distclean");
    await store.patch({ scripts: { preWorktreeDelete: { command: "bazel clean" } } });
    assert.deepEqual((await stored()).overrides, { scripts: { preWorktreeDelete: { command: "bazel clean" } } });

    const two = await store.patch({ scripts: { preWorktreeDelete: { abortOnFailure: false, timeoutSeconds: 45 } } });
    assert.deepEqual(two.scripts.preWorktreeDelete, { command: "bazel clean", abortOnFailure: false, timeoutSeconds: 45 });
    assert.deepEqual((await stored()).overrides.scripts, { preWorktreeDelete: { command: "bazel clean", abortOnFailure: false, timeoutSeconds: 45 } });
    assert.deepEqual(await open().read(), two, "a fresh store reloads them");

    const off = await store.patch({ scripts: { preWorktreeDelete: { command: "" } } });
    assert.equal(off.scripts.preWorktreeDelete.command, "");
    assert.deepEqual((await stored()).overrides.scripts, { preWorktreeDelete: { abortOnFailure: false, timeoutSeconds: 45 } });

    // Back to every default: the section disappears.
    await store.patch({ scripts: { preWorktreeDelete: { abortOnFailure: true, timeoutSeconds: defaultScriptSettings.timeoutSeconds } } });
    assert.deepEqual((await stored()).overrides, {});
    // An empty patch for a known script is accepted and changes nothing.
    assert.deepEqual(await store.patch({ scripts: { preWorktreeDelete: {} } }), defaultSettings);
    assert.deepEqual(await store.patch({ scripts: {} }), defaultSettings);
  });

  test(`${name}: rejects malformed script patches with 400 before writing anything`, async (t) => {
    const { open, stored } = await make(t);
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
    assert.equal((await stored()).written, false);
    // Unknown fields inside a known script are ignored, like elsewhere.
    assert.deepEqual(await store.patch({ scripts: { preWorktreeDelete: { colour: "blue" } } }), defaultSettings);
  });
}

// ---------------------------------------------------------------------------------------------
// Postgres specifics: the row shapes, the sealing, and what happens when a row cannot be used.
// ---------------------------------------------------------------------------------------------

test("postgres: overrides are one jsonb object row, and each key is one sealed credentials row", async (t) => {
  const { db, key, open } = await backends[1][1](t);
  const store = open();
  const before = Date.now();
  await store.patch({ gitActions: { prompts: { checks: "CI" } }, orchestrator: { apiKeys: { openai: "sk-openai-secret" } } });
  const [row] = await db.select().from(settingsTable);
  assert.equal(row.key, OVERRIDES_KEY);
  assert.deepEqual(row.body, { gitActions: { prompts: { checks: "CI" } } });
  assert.ok(row.updatedAt >= before);
  const [typed] = await db.execute(`select jsonb_typeof(body) as type from settings where key = '${OVERRIDES_KEY}'`);
  assert.equal(typed.type, "object", "the body is real jsonb, not a JSON string");

  const [cred] = await db.select().from(credentials);
  assert.equal(cred.name, "openai");
  assert.equal(cred.keyId, key.keyId);
  assert.ok(!cred.ciphertext.includes("sk-openai"), "the key is not stored in the clear");
  assert.ok(!JSON.stringify(row.body).includes("sk-openai"), "nor in the overrides");
  assert.equal(decryptSecret(key, cred.ciphertext, "openai"), "sk-openai-secret");
  assert.equal(cred.createdAt, cred.updatedAt);

  // Replacing the key keeps createdAt and re-seals with a fresh nonce.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.patch({ orchestrator: { apiKeys: { openai: "sk-openai-secret" } } });
  const [again] = await db.select().from(credentials);
  assert.equal(again.createdAt, cred.createdAt);
  assert.ok(again.updatedAt > cred.updatedAt);
  assert.notEqual(again.ciphertext, cred.ciphertext);
});

test("postgres: a NUL character in an override is stripped instead of failing the write", async (t) => {
  const { db, open } = await backends[1][1](t);
  await open().patch({ gitActions: { prompts: { checks: "CI\u0000 please" } } });
  const [row] = await db.select().from(settingsTable);
  assert.deepEqual(row.body, { gitActions: { prompts: { checks: "CI please" } } });
});

test("postgres: a key sealed under another server key, or tampered with, reads as not stored and warns once", async (t) => {
  const { db, open } = await backends[1][1](t);
  await open().patch({ orchestrator: { apiKeys: { openai: "sk-openai", anthropic: "sk-ant" } } });

  // The server key was replaced: nothing can be opened.
  const warnings = [];
  const rotated = createPgSettingsStore({ db, key: async () => generateServerKey(), warn: (message) => warnings.push(message) });
  assert.deepEqual((await rotated.read()).orchestrator.apiKeys, { openai: false, anthropic: false });
  assert.equal(await rotated.apiKey("openai"), null);
  await rotated.read();
  assert.equal(warnings.length, 2, `one warning per credential: ${warnings.join(" | ")}`);
  assert.match(warnings[0], /server key/);
  // Entering the key again seals it under the current key.
  await rotated.patch({ orchestrator: { apiKeys: { openai: "sk-new" } } });
  assert.equal(await rotated.apiKey("openai"), "sk-new");
  assert.deepEqual((await rotated.read()).orchestrator.apiKeys, { openai: true, anthropic: false });

  // A tampered row under the right key fails its integrity check.
  const { db: db2, key, open: open2 } = await backends[1][1](t);
  await open2().patch({ orchestrator: { apiKeys: { anthropic: "sk-ant" } } });
  const [cred] = await db2.select().from(credentials);
  const bytes = Buffer.from(cred.ciphertext, "base64");
  bytes[bytes.length - 1] ^= 1;
  await db2.update(credentials).set({ ciphertext: bytes.toString("base64") });
  const seen = [];
  const store = createPgSettingsStore({ db: db2, key: async () => key, warn: (message) => seen.push(message) });
  assert.equal(await store.apiKey("anthropic"), null);
  assert.equal(await store.apiKey("anthropic"), null);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /integrity/);
});

test("postgres: a hand-edited overrides row is read field by field, and keys in it are ignored", async (t) => {
  const { db, open, stored } = await backends[1][1](t);
  await db.insert(settingsTable).values({
    key: OVERRIDES_KEY,
    updatedAt: 1,
    body: {
      version: 2,
      gitActions: { prompts: { checks: "ok", deploy: "x", review: 5 } },
      orchestrator: { provider: "google", model: " claude-x ", intervalMinutes: 0, idleIntervalMinutes: 30, apiKeys: { openai: "sk-in-the-row" } },
      scripts: { preWorktreeDelete: { command: " make clean ", abortOnFailure: "yes" } },
      theme: "dark",
    },
  });
  const store = open();
  const settings = await store.read();
  assert.deepEqual(settings.gitActions.prompts, { ...defaults, checks: "ok" });
  assert.deepEqual(settings.orchestrator, { ...orchestratorDefaults, model: "claude-x", idleIntervalMinutes: 30 });
  assert.deepEqual(settings.scripts.preWorktreeDelete, { ...defaultScriptSettings, command: "make clean" });
  assert.equal(await store.apiKey("openai"), null, "a key in the overrides row is never used");

  // The next change rewrites the row without the bad values.
  await store.patch({ orchestrator: { intervalMinutes: 15 } });
  assert.deepEqual((await stored()).overrides, {
    gitActions: { prompts: { checks: "ok" } },
    orchestrator: { model: "claude-x", intervalMinutes: 15, idleIntervalMinutes: 30 },
    scripts: { preWorktreeDelete: { command: "make clean" } },
  });
});

test("postgres: an unusable server key fails every call with a clear error instead of reading as defaults", async (t) => {
  const { db } = await temporaryDatabase(t);
  const store = createPgSettingsStore({ db, key: async () => { throw new Error("Cannot load the server key /x/server.key: EACCES"); } });
  await assert.rejects(store.ready, /server key/);
  await assert.rejects(store.read(), /server key/);
  await assert.rejects(store.patch({ gitActions: { prompts: { checks: "x" } } }), /server key/);
  await rejects400(store.patch([]), /JSON object/);
});

test("the service loads its key from config.portalHome on first use only", async (t) => {
  const { db } = await temporaryDatabase(t);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-settings-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const portalHome = path.join(root, "home");
  const warnings = [];
  const service = createSettingsService({ db, config: { portalHome }, log: { warn: (message) => warnings.push(message) } });
  assert.ok(!existsSync(serverKeyFile(portalHome)), "building the service touches no files");
  await service.ready;
  assert.ok(existsSync(serverKeyFile(portalHome)), "ready creates the key");
  await service.patch({ orchestrator: { apiKeys: { anthropic: "sk-ant" } } });
  const reopened = createSettingsService({ db, config: { portalHome }, log: { warn: (message) => warnings.push(message) } });
  assert.equal(await reopened.apiKey("anthropic"), "sk-ant", "a restart reads the same key file");
  assert.deepEqual(warnings, []);
});

test("createMemorySettingsStore takes seed overrides and keys", async () => {
  const store = createMemorySettingsStore({ overrides: { orchestrator: { model: "gpt-x" } }, apiKeys: { openai: "sk-seed" } });
  await store.ready;
  assert.equal((await store.orchestrator()).model, "gpt-x");
  assert.deepEqual((await store.read()).orchestrator.apiKeys, { openai: true, anthropic: false });
  assert.equal(await store.apiKey("openai"), "sk-seed");
});

// ---------------------------------------------------------------------------------------------
// Pure parsers: the PATCH validator, and the lenient readers for the legacy file and stored rows.
// ---------------------------------------------------------------------------------------------

test("parseSettingsPatch trims and returns only the sections given", () => {
  assert.deepEqual(parseSettingsPatch({ gitActions: { prompts: { checks: " x " } } }), { gitActions: { prompts: { checks: "x" } } });
  assert.throws(() => parseSettingsPatch([]), SettingsError);
  assert.deepEqual(parseSettingsPatch({ orchestrator: { model: " gpt-x ", apiKeys: { openai: " k " } } }), {
    orchestrator: { model: "gpt-x", apiKeys: { openai: "k" } },
  });
  assert.deepEqual(parseSettingsPatch({ orchestrator: {} }), { orchestrator: {} });
  assert.deepEqual(Object.keys(parseSettingsPatch({ gitActions: {} })), ["gitActions"]);
  assert.deepEqual(Object.keys(parseSettingsPatch({ orchestrator: {} })), ["orchestrator"]);
});

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

test("parseSettingsFile (for the importer) gives up only on non-JSON and non-objects, and keeps the keys", () => {
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 2, gitActions: "x", orchestrator: { apiKeys: { openai: "k" } } })), { orchestrator: { apiKeys: { openai: "k" } } });
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 3 })), {});
  assert.deepEqual(parseSettingsFile("{}"), {});
  assert.equal(parseSettingsFile("[]"), null);
  assert.equal(parseSettingsFile("null"), null);
  assert.equal(parseSettingsFile("42"), null);
  assert.equal(parseSettingsFile("nope"), null);
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 1, orchestrator: { provider: "anthropic", model: 3 } })), {
    orchestrator: { provider: "anthropic" },
  });
  assert.deepEqual(
    parseSettingsFile(JSON.stringify({ version: 1, orchestrator: { model: "  ", intervalMinutes: 99999, apiKeys: { openai: "", anthropic: "k".repeat(513), google: "g" } } })),
    {},
  );
  assert.deepEqual(parseSettingsFile(JSON.stringify({ version: 1, scripts: { preWorktreeDelete: { command: 3, timeoutSeconds: 12 } } })), {
    scripts: { preWorktreeDelete: { timeoutSeconds: 12 } },
  });
});

test("parseStoredOverrides reads leniently and never yields API keys", () => {
  assert.deepEqual(parseStoredOverrides(undefined), {});
  assert.deepEqual(parseStoredOverrides(null), {});
  assert.deepEqual(parseStoredOverrides("x"), {});
  assert.deepEqual(parseStoredOverrides([]), {});
  assert.deepEqual(parseStoredOverrides({ orchestrator: { apiKeys: { openai: "sk" } } }), {});
  assert.deepEqual(parseStoredOverrides({ orchestrator: { model: "m", apiKeys: { openai: "sk" } } }), { orchestrator: { model: "m" } });
  assert.deepEqual(parseStoredOverrides({ gitActions: { prompts: { checks: "c" } } }), { gitActions: { prompts: { checks: "c" } } });
});
