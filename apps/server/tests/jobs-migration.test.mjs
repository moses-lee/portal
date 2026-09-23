import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { connect } from "../src/db/client.ts";
import { migrationsFolder } from "../src/db/migrate.ts";
import { createPgJobsStore } from "../src/orchestrator/jobs/pg-store.ts";
import { createPgOrchestratorStore } from "../src/orchestrator/pg-store.ts";

const adminUrl = process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal";
/** The last migration from before jobs and intents replaced watches and tick reports. */
const BEFORE = "0002_orchestrator_v2";

/** A throwaway database migrated only up to `BEFORE`, and a way to run the rest. */
async function databaseBefore(t) {
  const name = `portal_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = connect(url.toString(), { max: 2 });
  const folder = mkdtempSync(path.join(os.tmpdir(), "portal-migrations-"));
  t.after(async () => {
    await handle.close();
    await admin.unsafe(`drop database ${name} with (force)`);
    await admin.end();
    rmSync(folder, { recursive: true, force: true });
  });
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const cut = journal.entries.findIndex((entry) => entry.tag === BEFORE);
  const entries = journal.entries.slice(0, cut + 1);
  mkdirSync(path.join(folder, "meta"));
  writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  await migrate(handle.db, { migrationsFolder: folder });
  return { ...handle, rest: () => migrate(handle.db, { migrationsFolder }) };
}

const pull = { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" };

test("the data migration turns watches into intents with check jobs, relinks items, keeps tick reports as runs, then drops the old tables", async (t) => {
  const { sql, db, rest } = await databaseBefore(t);
  const watch = (id, status, extra = {}) => ({
    id, intent: `Review PRs on acme/app (${id})`, notes: `notes ${id}`, status, links: { sessionIds: ["s1"], projectIds: ["p1"], pulls: [pull, { ...pull, number: 8 }] },
    createdAt: 1000, updatedAt: 2000, lastCheckedAt: 1500, ...extra,
  });
  const watches = [watch("w1", "active"), watch("w2", "done"), watch("w3", "cancelled", { intent: `  ${"long ".repeat(40)}  ` })];
  for (const [i, body] of watches.entries()) {
    await sql`insert into orchestrator_watches (id, status, created_at, updated_at, last_checked_at, body) values (${body.id}, ${body.status}, ${body.createdAt + i}, ${body.updatedAt}, ${body.lastCheckedAt}, ${JSON.stringify(body)}::jsonb)`;
  }
  const item = (id, extra) => ({
    id, list: "needs_you", kind: "custom", title: `Item ${id}`, body: "", links: {}, actions: [], fingerprint: `custom:${id}`, status: "open",
    createdAt: 10, updatedAt: 10, snoozedUntil: null, ...extra,
  });
  const items = [item("i1", { kind: "watch_update", links: { watchId: "w1", sessionId: "s1" } }), item("i2", { links: { projectId: "p1" } }), item("i3", { kind: "watch_update" })];
  for (const body of items) {
    await sql`insert into orchestrator_items (id, list, status, fingerprint, created_at, updated_at, snoozed_until, body) values (${body.id}, ${body.list}, ${body.status}, ${body.fingerprint}, ${body.createdAt}, ${body.updatedAt}, ${null}, ${JSON.stringify(body)}::jsonb)`;
  }
  const tick = (id, extra) => ({
    id, reason: "schedule", startedAt: 5000, finishedAt: 5100, modelInvoked: false, changes: 0, itemsCreated: [], itemsUpdated: [], itemsResolved: [],
    log: [`tick ${id}`], error: null, usage: null, ...extra,
  });
  const ticks = [tick("t1"), tick("t2", { reason: "manual", modelInvoked: true, changes: 2, usage: { inputTokens: 5, outputTokens: 6 }, startedAt: 6000 }), tick("t3", { error: "provider down", startedAt: 7000 })];
  for (const body of ticks) {
    await sql`insert into orchestrator_ticks (id, started_at, finished_at, body) values (${body.id}, ${body.startedAt}, ${body.finishedAt}, ${JSON.stringify(body)}::jsonb)`;
  }

  const before = Date.now();
  await rest();

  const jobs = createPgJobsStore({ db });
  const intents = Object.fromEntries((await jobs.listIntents()).map((intent) => [intent.id, intent]));
  assert.deepEqual(Object.keys(intents).sort(), ["w1", "w2", "w3"]);
  const w1 = intents.w1;
  assert.deepEqual(
    { text: w1.text, notes: w1.notes, status: w1.status, fireBudget: w1.fireBudget, fires: w1.fires, cooldownMs: w1.cooldownMs, lastCheckedAt: w1.lastCheckedAt, threadId: w1.threadId, createdAt: w1.createdAt },
    { text: "Review PRs on acme/app (w1)", notes: "notes w1", status: "active", fireBudget: null, fires: 0, cooldownMs: 0, lastCheckedAt: 1500, threadId: null, createdAt: 1000 },
  );
  assert.deepEqual(w1.scope, { projectIds: ["p1"], sessionIds: ["s1"], pulls: [pull, { ...pull, number: 8 }], repos: ["acme/app"], people: [], taskTypes: [] });
  assert.match(w1.trigger, /notes are waiting for/);
  assert.equal(intents.w2.status, "done");
  assert.equal(intents.w3.status, "cancelled");

  const checks = await jobs.listJobs({ kind: ["intent_check"] });
  assert.deepEqual(checks.map((job) => [job.id, job.intentId, job.status]), [["chk-w1", "w1", "active"]], "only an active watch keeps being checked");
  const [check] = checks;
  assert.deepEqual(check.schedule, { type: "every", everyMs: 600_000 });
  assert.deepEqual(check.payload, { intentId: "w1" });
  assert.equal(check.title, "Check: Review PRs on acme/app (w1)");
  assert.equal(check.createdBy, "system");
  assert.equal(check.lastRunAt, 1500);
  assert.ok(check.nextRunAt >= before + 600_000 - 1000 && check.nextRunAt <= Date.now() + 600_000 + 1000, "ten minutes after the migration");

  const orchestrator = createPgOrchestratorStore({ db });
  const stored = Object.fromEntries((await orchestrator.listItems()).map((entry) => [entry.id, entry]));
  assert.deepEqual(stored.i1, { ...items[0], kind: "intent_update", links: { sessionId: "s1", intentId: "w1" } });
  assert.deepEqual(stored.i2, items[1], "untouched");
  assert.equal(stored.i3.kind, "intent_update");

  const runs = await jobs.listRuns({ jobId: "tick" });
  assert.deepEqual(runs.map((run) => [run.id, run.status, run.trigger]), [["t3", "failed", "schedule"], ["t2", "succeeded", "manual"], ["t1", "succeeded", "schedule"]]);
  assert.deepEqual(runs[1].result, ticks[1]);
  assert.deepEqual(runs[1].usage, { inputTokens: 5, outputTokens: 6 });
  assert.equal(runs[1].summary, "2 change(s) considered");
  assert.equal(runs[0].error, "provider down");
  assert.equal(runs[2].summary, "Nothing changed.");
  assert.deepEqual(runs[2].log, ["tick t1"]);

  const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public'`).map((row) => row.table_name);
  assert.ok(!tables.includes("orchestrator_watches") && !tables.includes("orchestrator_ticks"), tables.join(","));
  assert.ok(tables.includes("intents") && tables.includes("jobs") && tables.includes("job_runs"));
});

test("the migration runs on a database that never had a watch or a tick", async (t) => {
  const { sql, rest } = await databaseBefore(t);
  await rest();
  assert.equal((await sql`select count(*)::int as n from intents`)[0].n, 0);
  assert.equal((await sql`select count(*)::int as n from jobs`)[0].n, 0);
});
