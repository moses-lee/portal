import assert from "node:assert/strict";
import test from "node:test";
import { splitLegacyMemory } from "../src/orchestrator/memory/import.ts";
import { isRecordKey } from "../src/orchestrator/memory/validate.ts";
import { memorySetup } from "./fixtures/memory-setup.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const legacy = `# Preferences

- Prefers pnpm over npm.
- Wants answers short
  and without headers.
* Works mostly in acme/app.

## Reviews
1. Read the tests first.
2) Then the migrations.

Moses reviews PRs from octocat carefully. He asks for small diffs.

\`\`\`
not code, just a note
\`\`\`
- Prefers pnpm over npm.
`;

test("splitting is deterministic: bullets, numbered items, and paragraphs are claims; headings are context", () => {
  const claims = splitLegacyMemory(legacy);
  assert.deepEqual(claims.map((claim) => claim.body), [
    "Preferences: Prefers pnpm over npm.",
    "Preferences: Wants answers short and without headers.",
    "Preferences: Works mostly in acme/app.",
    "Reviews: Read the tests first.",
    "Reviews: Then the migrations.",
    "Reviews: Moses reviews PRs from octocat carefully. He asks for small diffs.",
    "Reviews: not code, just a note",
    "Reviews: Prefers pnpm over npm.",
  ]);
  assert.deepEqual(claims[1].quote, "Wants answers short\nand without headers.");
  assert.equal(claims[0].type, "preference");
  assert.equal(claims[2].type, "fact");
  assert.equal(claims[0].key, "preferences.prefers-pnpm-over-npm");
  assert.ok(claims.every((claim) => isRecordKey(claim.key)), claims.map((claim) => claim.key).join(" "));
  assert.equal(new Set(claims.map((claim) => claim.key)).size, claims.length, "keys are unique");
  assert.deepEqual(splitLegacyMemory(legacy), claims, "same text, same claims");
  assert.equal(splitLegacyMemory("- A note", ["a-note"])[0].key, "a-note-2", "keys already taken are avoided");
  assert.deepEqual(splitLegacyMemory("\n\n[Portal truncated this file: memory is capped at 32 KiB.]\n"), []);
});

test("a long paragraph is cut at sentence ends into records that fit", () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
  const claims = splitLegacyMemory(long);
  assert.ok(claims.length > 1);
  assert.ok(claims.every((claim) => claim.body.length <= 600));
  assert.ok(claims[0].body.endsWith("here."));
});

test("the import proposes each claim under global, once; secrets are skipped; the legacy text stays", async (t) => {
  const text = `${legacy}\n- The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123\n`;
  const { memory, store, activity, events } = await memorySetup(t, { legacy: text });
  const proposed = await memory.store.listRecords({ status: ["proposed"] });
  assert.equal(proposed.length, 8);
  assert.ok(proposed.every((record) => record.authority === "observed" && record.source.kind === "import" && record.source.quote));
  const [global] = await memory.store.listEntities({ type: "global" });
  assert.ok(proposed.every((record) => record.entityId === global.id));
  assert.ok(!JSON.stringify(proposed).includes("ghp_"));
  assert.equal(await memory.inboxCount(), 8);
  assert.equal(await store.readMemory(), text, "the legacy text is kept for audit");
  const [entry] = await activity("memory.imported");
  assert.equal(entry.detail.imported, 8);
  assert.equal(entry.detail.skipped, 1);
  assert.equal(events.some((event) => event.type === "memory"), true);
  assert.deepEqual(await memory.importLegacy(), { imported: 0, skipped: 0, alreadyDone: true });
  assert.equal(await memory.inboxCount(), 8);
  // Approving one puts it into CORE.md's index.
  await memory.approve(proposed[0].id, { actor: "user" });
  assert.match((await memory.core()).text, /global — 1 record/);
});

test("with no legacy text nothing is imported or marked", async (t) => {
  const { memory } = await memorySetup(t);
  assert.equal(await memory.store.countRecords(), 0);
  assert.deepEqual(await memory.store.listRevisions(), []);
  assert.deepEqual(await memory.importLegacy(), { imported: 0, skipped: 0, alreadyDone: false });
});

test("postgres: a restart never imports again, even after every inbox item was handled", async (t) => {
  const database = await temporaryDatabase(t);
  const first = await memorySetup(t, { database, legacy: "- Prefers pnpm.\n- Uses node 24.\n" });
  const records = await first.memory.store.listRecords();
  assert.equal(records.length, 2);
  for (const record of records) await first.memory.reject(record.id, null, { actor: "user" });
  await first.runtime.dispose();
  const second = await memorySetup(t, { database });
  assert.equal(await second.memory.store.countRecords(), 2);
  assert.equal(await second.memory.inboxCount(), 0);
  assert.equal((await second.memory.store.listRevisions({ action: "imported" })).filter((revision) => revision.recordId === null).length, 1);
});
