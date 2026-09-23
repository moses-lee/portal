import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { count } from "drizzle-orm";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import * as schema from "../src/db/schema.ts";
import { IMPORT_MARKER_KEY, describeCounts, importLegacyHome, readImportMarker } from "../src/import/import-legacy.ts";
import { createPgOrchestratorStore } from "../src/orchestrator/pg-store.ts";
import { createPgProjectsStore } from "../src/projects/pg-store.ts";
import { createPgSessionStore } from "../src/sessions/pg-session-store.ts";
import { loadServerKey } from "../src/settings/crypto.ts";
import { createPgSettingsStore } from "../src/settings/pg-settings-store.ts";
import { portalSecretFile } from "../src/lib/settings-store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const run = promisify(execFile);
const serverDir = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------------------------
// A legacy home, written the way the old file stores serialised it
// ---------------------------------------------------------------------------------------------

/** What the old stores wrote for JSON documents: pretty-printed with a trailing newline. */
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const state = { modes: null, configOptions: [], commands: [] };
const session = (id, extra = {}) => ({
  id, agentId: "claude", agentName: "Claude", cwd: "/work/one", projectId: "p1", createdAt: 100, lastActiveAt: 200,
  title: `Session ${id}`, upstreamId: `up-${id}`, state, ...extra,
});
const item = (id, createdAt, extra = {}) => ({
  id, list: "needs_you", kind: "pr_checks_failing", title: `Item ${id}`, body: "Checks failed.", links: {}, actions: [],
  fingerprint: `fp-${id}`, status: "open", createdAt, updatedAt: createdAt, snoozedUntil: null, ...extra,
});
const watch = (id, createdAt) => ({
  id, intent: `watch ${id}`, notes: "", status: "active", links: { sessionIds: [], projectIds: [], pulls: [] },
  createdAt, updatedAt: createdAt, lastCheckedAt: null,
});
const tick = (n) => ({
  id: `t${n}`, reason: "schedule", startedAt: n * 1000, finishedAt: n * 1000 + 5, modelInvoked: false, changes: 0,
  itemsCreated: [], itemsUpdated: [], itemsResolved: [], log: [`tick ${n}`], error: null, usage: null,
});
const LONG_EVENTS = 300;
const PADDING = "x".repeat(400);

function writeFixtureHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "portal-import-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    writeFileSync(path.join(home, rel), text, { mode: 0o600 });
  };

  write("projects.json", json({
    version: 1,
    projects: [
      { id: "p1", name: "one", path: "/work/one", createdAt: 5 },
      // Same createdAt as p1: file order must survive as the tie-break.
      { id: "p0", name: "zero", path: "/work/zero", createdAt: 5 },
      { id: "w1", name: "one · feat/x", path: "/work/one-x", createdAt: 7, worktree: { parentId: "p1", branch: "feat/x" } },
    ],
    removed: [{ id: "gone", name: "gone", path: "/work/gone", createdAt: 1, removedAt: 50 }, { id: "bad" }],
  }));

  write("settings.json", json({
    version: 1,
    gitActions: { prompts: { review: "Review this PR carefully." } },
    orchestrator: { model: "gpt-test", apiKeys: { openai: "sk-openai-123", anthropic: "sk-ant-456" } },
  }));

  write("sessions/index.json", json({ version: 1, sessions: [session("s2", { title: "nul\u0000title" }), session("s1"), session("s3")] }));
  // s1: a log well past the old store's 64 KiB read chunk, one unreadable line, and a torn last line.
  const lines = [];
  for (let seq = 0; seq < LONG_EVENTS; seq++) {
    if (seq === 10) lines.push("{ not json");
    lines.push(JSON.stringify({ type: "user", text: `${seq} ${PADDING}`, seq, ts: 1000 + seq }));
  }
  write("sessions/logs/s1.jsonl", lines.join("\n") + "\n" + JSON.stringify({ type: "user", text: "torn", seq: LONG_EVENTS, ts: 1 }).slice(0, 20));
  write("sessions/logs/s2.jsonl", [
    { type: "turn_start", seq: 0, ts: 10 },
    { type: "user", text: "bad\u0000byte", seq: 1, ts: 11 },
    { type: "turn_end", stopReason: "end_turn", seq: 3, ts: 12 },
  ].map((event) => JSON.stringify(event) + "\n").join(""));
  // s3 has no log at all; a log with no index entry is ignored, as the old store never listed it.
  write("sessions/logs/orphan.jsonl", JSON.stringify({ type: "turn_start", seq: 0, ts: 1 }) + "\n");

  write("orchestrator/conversation.json", json([
    { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }], metadata: { at: 1 } },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi\u0000there" }], metadata: { at: 2 } },
    { id: "broken", role: "assistant" },
  ]));
  // Newest first, as the old store kept them; one duplicate id and one invalid record.
  write("orchestrator/items.json", json([item("i2", 20), item("i1", 10), item("i1", 30, { title: "duplicate" }), { id: "nope" }]));
  write("orchestrator/watches.json", json([watch("w2", 20), watch("w1", 10)]));
  write("orchestrator/ticks.json", json(Array.from({ length: 55 }, (_, i) => tick(i))));
  write("orchestrator/snapshot.json", json({ at: 99, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [] }));
  write("orchestrator/memory.md", "# Notes\n\nRemember this.\n");
  // Leftovers the old store could leave behind; never read.
  write("orchestrator/items.json.corrupt-123", "[not json");
  write("orchestrator/conversation.json.tmp-abcd1234", json([{ id: "tmp", role: "user", parts: [] }]));
  return home;
}

async function tableCounts(db) {
  const tables = ["sessions", "sessionEvents", "projects", "removedProjects", "settings", "credentials", "orchestratorMessages", "orchestratorItems", "orchestratorWatches", "orchestratorTicks", "orchestratorDocuments"];
  const out = {};
  for (const name of tables) out[name] = (await db.select({ n: count() }).from(schema[name]))[0].n;
  return out;
}

const expectedCounts = {
  projects: 3, removedProjects: 1, sessions: 3, events: LONG_EVENTS + 3, settings: 2, apiKeys: 2,
  messages: 2, items: 2, watches: 2, ticks: 50, snapshot: 1, memory: 1,
};

// ---------------------------------------------------------------------------------------------

test("imports every domain and reads back through the real stores", async (t) => {
  const { db } = await temporaryDatabase(t);
  const home = writeFixtureHome(t);
  const result = await importLegacyHome({ home, db, now: () => Date.UTC(2026, 8, 22, 12, 0, 0) });

  assert.equal(result.status, "imported");
  assert.deepEqual(result.counts, expectedCounts);
  const warnings = result.warnings.join("\n");
  for (const pattern of [/torn last line/, /1 unreadable line in .*s1\.jsonl/, /unreadable removed project/, /1 unreadable record from .*conversation\.json/, /1 duplicate id from .*items\.json/, /1 unreadable record from .*items\.json/]) {
    assert.match(warnings, pattern);
  }

  // Projects: file order on the createdAt tie, the legacy worktree name dropped, the removed record kept.
  const projects = createPgProjectsStore({ db });
  await projects.ready;
  assert.deepEqual(projects.list().map((p) => [p.id, p.name]), [["p1", "one"], ["p0", "zero"], ["w1", "feat/x"]]);
  assert.deepEqual(projects.get("w1").worktree, { parentId: "p1", branch: "feat/x" });
  assert.deepEqual(projects.listRemoved(), [{ id: "gone", name: "gone", path: "/work/gone", createdAt: 1, removedAt: 50 }]);

  // Sessions: index order, NULs stripped, seqs kept (gaps included), the torn and unreadable lines gone.
  const sessions = createPgSessionStore({ db });
  assert.deepEqual((await sessions.listSessions()).map((s) => s.id), ["s2", "s1", "s3"]);
  assert.equal((await sessions.getSession("s2")).title, "nultitle");
  assert.deepEqual(await sessions.getSession("s1"), session("s1"));
  const s2 = await sessions.readTail("s2", { limit: 10 });
  assert.deepEqual(s2.events.map((e) => e.seq), [0, 1, 3]);
  assert.equal(s2.events[1].text, "badbyte");
  assert.equal(await sessions.eventCount("s1"), LONG_EVENTS);
  const page = await sessions.readTail("s1", { limit: 5 });
  assert.deepEqual(page.events.map((e) => e.seq), [295, 296, 297, 298, 299]);
  assert.equal(page.events[0].text, `295 ${PADDING}`);
  assert.equal(page.hasMore, true);
  assert.equal((await sessions.readTail("s1", { beforeSeq: 1, limit: 5 })).events[0].seq, 0);
  assert.equal(await sessions.eventCount("s3"), 0);
  assert.equal(await sessions.getSession("orphan"), undefined);

  // Settings: overrides stored, both keys sealed under <home>/server.key and readable again.
  assert.ok(existsSync(path.join(home, "server.key")));
  const settings = createPgSettingsStore({ db, key: () => loadServerKey(home), warn: () => assert.fail("no warnings expected") });
  const read = await settings.read();
  assert.equal(read.gitActions.prompts.review, "Review this PR carefully.");
  assert.equal(read.orchestrator.model, "gpt-test");
  assert.deepEqual(read.orchestrator.apiKeys, { openai: true, anthropic: true });
  assert.equal(await settings.apiKey("openai"), "sk-openai-123");
  assert.equal(await settings.apiKey("anthropic"), "sk-ant-456");
  const [creds] = await db.select({ ciphertext: schema.credentials.ciphertext }).from(schema.credentials).limit(1);
  assert.ok(!creds.ciphertext.includes("sk-"), "keys are stored sealed");

  // Orchestrator: thread order, invalid records dropped, first of a duplicate id kept, newest 50 ticks.
  const orchestrator = createPgOrchestratorStore({ db });
  const messages = await orchestrator.readMessages();
  assert.deepEqual(messages.map((m) => m.id), ["m1", "m2"]);
  assert.equal(messages[1].parts[0].text, "hithere");
  const items = await orchestrator.listItems();
  assert.deepEqual(items.map((i) => [i.id, i.title]), [["i2", "Item i2"], ["i1", "Item i1"]]);
  assert.deepEqual(await orchestrator.getItem("i1"), item("i1", 10));
  assert.deepEqual((await orchestrator.listWatches()).map((w) => w.id), ["w2", "w1"]);
  const ticks = await orchestrator.listTicks();
  assert.equal(ticks.length, 50);
  assert.deepEqual([ticks[0].id, ticks.at(-1).id], ["t5", "t54"]);
  assert.equal((await orchestrator.readSnapshot()).at, 99);
  assert.equal(await orchestrator.readMemory(), "# Notes\n\nRemember this.\n");

  // Files: settings.json renamed and 0600, the marker file beside it, everything else left as a backup.
  const stamp = "2026-09-22T12-00-00-000Z";
  const backup = path.join(home, `settings.json.imported-${stamp}`);
  assert.equal(result.settingsBackup, backup);
  assert.equal(existsSync(path.join(home, "settings.json")), false);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.match(readFileSync(backup, "utf8"), /sk-openai-123/);
  const markerFile = path.join(home, `IMPORTED-${stamp}.json`);
  assert.equal(result.markerFile, markerFile);
  const summary = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.deepEqual(summary.counts, expectedCounts);
  assert.equal(summary.home, home);
  assert.equal(statSync(markerFile).mode & 0o777, 0o600);
  for (const kept of ["projects.json", "sessions/index.json", "sessions/logs/s1.jsonl", "orchestrator/items.json", "orchestrator/memory.md"]) {
    assert.ok(existsSync(path.join(home, kept)), `${kept} stays as a backup`);
  }

  // The marker row, and a second run is a no-op.
  const marker = await readImportMarker(db);
  assert.deepEqual(marker, { importedAt: Date.UTC(2026, 8, 22, 12, 0, 0), home, counts: expectedCounts });
  const before = await tableCounts(db);
  const again = await importLegacyHome({ home, db });
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "already-imported");
  assert.deepEqual(await tableCounts(db), before);
  assert.equal(readdirSync(home).filter((name) => name.startsWith("IMPORTED-")).length, 1);

  // Forced, it merges: existing rows stay, nothing is duplicated.
  const forced = await importLegacyHome({ home, db, force: true });
  assert.equal(forced.status, "imported");
  // settings.json was moved aside by the first run, so only the untouched files are read again.
  assert.deepEqual(forced.counts, Object.fromEntries(Object.keys(expectedCounts).map((key) => [key, 0])));
  assert.deepEqual(await tableCounts(db), before);
});

test("a log that repeats or reorders seqs is renumbered in file order instead of losing events", async (t) => {
  const { db } = await temporaryDatabase(t);
  const home = mkdtempSync(path.join(os.tmpdir(), "portal-import-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, "sessions", "logs"), { recursive: true });
  writeFileSync(path.join(home, "sessions", "index.json"), json({ version: 1, sessions: [session("twice"), session("clean")] }));
  // Two processes appended to one log: seq 1 and 2 repeat, and 3 comes after 5.
  const written = [0, 1, 2, 1, 2, 5, 3].map((seq, i) => ({ type: "user", text: `line ${i} (seq ${seq})`, seq, ts: 100 + i }));
  const lines = written.map((event) => JSON.stringify(event));
  lines.splice(4, 0, "{ not json");
  writeFileSync(path.join(home, "sessions", "logs", "twice.jsonl"), lines.join("\n") + "\n" + JSON.stringify(written[0]).slice(0, 15));
  // A log that only has gaps keeps its seqs.
  writeFileSync(path.join(home, "sessions", "logs", "clean.jsonl"), [0, 2, 3].map((seq) => JSON.stringify({ type: "user", text: `s${seq}`, seq, ts: seq })).join("\n") + "\n");

  const result = await importLegacyHome({ home, db });
  assert.equal(result.status, "imported");
  assert.equal(result.counts.events, 10);
  const warnings = result.warnings.join("\n");
  assert.match(warnings, /Renumbered 3 events in .*twice\.jsonl/);
  assert.match(warnings, /1 unreadable line in .*twice\.jsonl/);
  assert.match(warnings, /torn last line from .*twice\.jsonl/);
  assert.doesNotMatch(warnings, /clean\.jsonl/);

  const sessions = createPgSessionStore({ db });
  const { events } = await sessions.readTail("twice", { limit: 20 });
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6], "dense, in file order");
  assert.deepEqual(events.map((e) => e.text), written.map((e) => e.text), "every event kept, text intact");
  assert.deepEqual(events.map((e) => e.ts), written.map((e) => e.ts));
  assert.equal(await sessions.eventCount("twice"), 7);
  assert.deepEqual((await sessions.readTail("clean", { limit: 20 })).events.map((e) => e.seq), [0, 2, 3]);
});

test("fractional or out-of-range times in the orchestrator files are rounded or cleared, not a failed import", async (t) => {
  const { db } = await temporaryDatabase(t);
  const home = mkdtempSync(path.join(os.tmpdir(), "portal-import-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, "orchestrator"));
  const write = (name, value) => writeFileSync(path.join(home, "orchestrator", name), json(value));
  write("items.json", [item("i1", 10.4, { status: "snoozed", snoozedUntil: 1234.5 }), item("i2", 20, { snoozedUntil: 1e300 }), item("i3", 1e300)]);
  write("watches.json", [{ ...watch("w1", 10), lastCheckedAt: 99.9 }]);
  write("ticks.json", [{ ...tick(1), startedAt: 1000.2, finishedAt: 1005.7 }]);

  const result = await importLegacyHome({ home, db });
  assert.equal(result.status, "imported");
  assert.match(result.warnings.join("\n"), /Dropped 1 unreadable record from .*items\.json/);
  const store = createPgOrchestratorStore({ db });
  const items = Object.fromEntries((await store.listItems()).map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(items).sort(), ["i1", "i2"]);
  assert.deepEqual([items.i1.createdAt, items.i1.snoozedUntil], [10, 1235]);
  assert.equal(items.i2.snoozedUntil, null);
  assert.equal((await store.listWatches())[0].lastCheckedAt, 100);
  assert.deepEqual((await store.listTicks()).map((r) => [r.startedAt, r.finishedAt]), [[1000, 1006]]);
});

test("describeCounts pluralises each count", () => {
  const one = { projects: 1, removedProjects: 0, sessions: 1, events: 1, settings: 1, apiKeys: 1, messages: 1, items: 1, watches: 1, ticks: 1, snapshot: 0, memory: 0 };
  assert.equal(describeCounts(one), "1 project (0 removed); 1 session (1 event); 1 settings section (1 API key); 1 message, 1 item, 1 watch, 1 tick; snapshot no, memory no");
  assert.match(describeCounts({ ...one, apiKeys: 2, watches: 0 }), /\(2 API keys\).*0 watches/);
});

test("a dry run counts everything and writes nothing", async (t) => {
  const { db } = await temporaryDatabase(t);
  const home = writeFixtureHome(t);
  const listing = () => readdirSync(home, { recursive: true }).sort();
  const files = listing();
  const empty = await tableCounts(db);

  const result = await importLegacyHome({ home, db, dryRun: true });
  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.counts, expectedCounts);
  assert.match(result.warnings.join("\n"), /torn last line/);
  assert.deepEqual(await tableCounts(db), empty);
  assert.deepEqual(listing(), files, "no rename, no marker file, no server key");
  assert.equal(await readImportMarker(db), null);
});

test("an empty or missing home is nothing to import", async (t) => {
  const { db } = await temporaryDatabase(t);
  const home = mkdtempSync(path.join(os.tmpdir(), "portal-import-empty-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await importLegacyHome({ home, db }), { status: "skipped", reason: "nothing-to-import", warnings: [] });
  assert.equal((await importLegacyHome({ home: path.join(home, "missing"), db })).reason, "nothing-to-import");
  assert.deepEqual(readdirSync(home), []);
  assert.equal(await readImportMarker(db), null);
});

test("boot imports a legacy home once, before the services load", async (t) => {
  const database = await temporaryDatabase(t);
  const home = writeFixtureHome(t);
  const config = { ...loadConfig(), portalHome: home };

  const app = await buildApp({ database, config, orchestrator: false });
  const response = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(response.statusCode, 200);
  // The projects service loaded its cache after the import, so the imported projects are listed.
  assert.deepEqual(response.json().projects.map((p) => p.id), ["p1", "p0", "w1"]);
  await app.close();
  const marker = await readImportMarker(database.db);
  assert.deepEqual(marker.counts, expectedCounts);

  // A second boot finds the marker and leaves everything alone.
  const before = await tableCounts(database.db);
  const second = await buildApp({ database, config, orchestrator: false });
  await second.close();
  assert.deepEqual(await tableCounts(database.db), before);
  assert.deepEqual(await readImportMarker(database.db), marker);
  assert.equal(readdirSync(home).filter((name) => name.startsWith("IMPORTED-")).length, 1);
});

test("boot leaves a legacy home alone when the database is already in use", async (t) => {
  const database = await temporaryDatabase(t);
  const home = writeFixtureHome(t);
  await database.db.insert(schema.projects).values({ id: "existing", name: "existing", path: "/work/existing", createdAt: 1 });
  const app = await buildApp({ database, config: { ...loadConfig(), portalHome: home }, orchestrator: false });
  await app.close();
  assert.equal(await readImportMarker(database.db), null);
  assert.ok(existsSync(path.join(home, "settings.json")));
  assert.equal((await tableCounts(database.db)).sessions, 0);
});

test("the CLI imports, honours --dry-run, and fails readably", async (t) => {
  const database = await temporaryDatabase(t);
  const home = writeFixtureHome(t);
  const cli = (...args) => run(process.execPath, ["src/import/cli.ts", ...args], { cwd: serverDir, env: { ...process.env, PORTAL_HOME: home } });

  const dry = await cli("--database-url", database.url, "--dry-run");
  assert.match(dry.stdout, /Dry run for .*would import 3 projects \(1 removed\); 3 sessions \(303 events\)/);
  assert.match(dry.stderr, /warning: Dropped a torn last line/);
  assert.equal((await tableCounts(database.db)).projects, 0);
  assert.ok(existsSync(path.join(home, "settings.json")));

  const real = await cli("--home", home, "--database-url", database.url);
  assert.match(real.stdout, /Imported .*: 3 projects/);
  assert.match(real.stdout, /settings\.json moved to .*settings\.json\.imported-/);
  const again = await cli("--database-url", database.url);
  assert.match(again.stdout, /Already imported/);

  await assert.rejects(cli("--bogus"), (err) => err.code === 2 && /Unknown option '--bogus'/.test(err.stderr));
  await assert.rejects(
    cli("--database-url", "postgres://portal:portal@127.0.0.1:1/none"),
    (err) => err.code === 1 && /^Import failed, nothing was imported: /m.test(err.stderr),
  );
});

test("the orchestrator's file guard covers the settings backups and the server key", () => {
  const home = "/Users/me/.portal";
  assert.equal(portalSecretFile(`${home}/settings.json`, home), "settings");
  assert.equal(portalSecretFile(`${home}/settings.json.imported-2026-09-22T12-00-00-000Z`, home), "settings");
  assert.equal(portalSecretFile(`${home}/settings.json.bad-1758542400000`, home), "settings");
  assert.equal(portalSecretFile(`${home}/settings.json.tmp-1a2b3c4d`, home), "settings");
  assert.equal(portalSecretFile(`${home}/Settings.JSON`, home), "settings");
  assert.equal(portalSecretFile(`${home}/server.key`, home), "server-key");
  assert.equal(portalSecretFile(`${home}/sub/../server.key`, home), "server-key");
  assert.equal(portalSecretFile(`${home}/IMPORTED-2026.json`, home), null);
  assert.equal(portalSecretFile(`${home}/projects/settings.json`, home), null);
  assert.equal(portalSecretFile("/elsewhere/server.key", home), null);
});
