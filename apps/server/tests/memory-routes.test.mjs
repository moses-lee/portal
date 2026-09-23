import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fakeDeps, fakeSettings, fakeTimers } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const home = mkdtempSync(path.join(os.tmpdir(), "portal-memory-routes-"));
process.env.PORTAL_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { appContext, buildApp } = await import("../src/app.ts");

async function setup(t) {
  const database = await temporaryDatabase(t);
  const { deps } = fakeDeps();
  const app = await buildApp({ database, orchestrator: { settingsStore: fakeSettings(), deps, timers: fakeTimers() } });
  t.after(() => app.close());
  return { app, database };
}

const inject = (app, method, url, payload, headers = {}) => app.inject({ method, url, payload, headers });
const input = (overrides = {}) => ({ entity: { type: "repo", key: "Acme/App", name: "App" }, type: "convention", key: "review-style", body: "Review tests first.", ...overrides });

test("create, list, read an entity, edit (supersedes), revisions, and CORE.md over HTTP", async (t) => {
  const { app } = await setup(t);
  assert.deepEqual((await inject(app, "GET", "/api/portal/memory/entities")).json(), { entities: [] });
  assert.deepEqual((await inject(app, "GET", "/api/portal/memory/core")).json().text, "");

  const created = await inject(app, "POST", "/api/portal/memory/records", input({ source: { kind: "pull", quote: "forged" }, pinned: true }));
  assert.equal(created.statusCode, 200, created.body);
  const { record } = created.json();
  assert.equal(record.authority, "user_stated");
  assert.deepEqual(record.source, { kind: "ui" }, "the browser's source is always ui");
  assert.equal(record.pinned, true);

  const conflict = await inject(app, "POST", "/api/portal/memory/records", input({ body: "Review docs first." }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().existing.id, record.id);
  assert.match(conflict.json().error, new RegExp(record.id));

  const [entity] = (await inject(app, "GET", "/api/portal/memory/entities")).json().entities;
  assert.equal(entity.key, "acme/app");
  assert.equal(entity.name, "App");
  assert.equal(entity.activeRecords, 1);
  const one = (await inject(app, "GET", `/api/portal/memory/entities/${entity.id}`)).json();
  assert.deepEqual(one.records.map((r) => r.id), [record.id]);
  assert.equal((await inject(app, "GET", "/api/portal/memory/entities/nope")).statusCode, 404);

  const edited = await inject(app, "PATCH", `/api/portal/memory/records/${record.id}`, { body: "Review migrations first." });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().record.supersedes, record.id);
  assert.equal(edited.json().record.pinned, true);
  const listed = (await inject(app, "GET", "/api/portal/memory/records?status=active")).json().records;
  assert.deepEqual(listed.map((r) => r.body), ["Review migrations first."]);
  assert.deepEqual((await inject(app, "GET", "/api/portal/memory/records?status=superseded,archived")).json().records.map((r) => r.id), [record.id]);
  assert.deepEqual((await inject(app, "GET", "/api/portal/memory/records?q=migrations")).json().records.map((r) => r.id), [edited.json().record.id]);
  assert.deepEqual((await inject(app, "GET", `/api/portal/memory/records?entityId=${entity.id}&type=fact`)).json().records, []);
  assert.equal((await inject(app, "GET", "/api/portal/memory/records?status=bogus")).statusCode, 400);

  const revisions = (await inject(app, "GET", `/api/portal/memory/revisions?entityId=${entity.id}`)).json().revisions;
  assert.deepEqual(revisions.map((r) => r.action), ["updated", "superseded", "created"]);
  const page = (await inject(app, "GET", `/api/portal/memory/revisions?entityId=${entity.id}&before=${revisions[0].id}&limit=1`)).json().revisions;
  assert.deepEqual(page.map((r) => r.id), [revisions[1].id]);

  const core = (await inject(app, "GET", "/api/portal/memory/core")).json();
  assert.match(core.text, /Review migrations first\./);
  assert.equal(typeof core.generatedAt, "number");
  assert.equal(typeof core.tokens, "number");

  assert.equal((await inject(app, "PATCH", `/api/portal/memory/records/${record.id}`, { body: "x" })).statusCode, 409, "a superseded record is history");
  assert.equal((await inject(app, "PATCH", `/api/portal/memory/records/${record.id}`, { pinned: "yes" })).statusCode, 400);
  assert.equal((await inject(app, "PATCH", `/api/portal/memory/records/${record.id}`, { status: "active" })).statusCode, 400);
  assert.equal((await inject(app, "POST", "/api/portal/memory/records", input({ key: "Bad Key" }))).statusCode, 400);
  assert.equal((await inject(app, "POST", "/api/portal/memory/records", input({ key: "k2", body: "token ghp_abcdefghijklmnopqrstuvwxyz0123" }))).statusCode, 400);
});

test("the inbox over HTTP: approve, reject, forget, with the inbox count on status", async (t) => {
  const { app } = await setup(t);
  // Proposals come from the agent; reach the service the way its tools do.
  const memory = appContext(app).orchestrator.hub.memory;
  const agent = { actor: "agent" };
  const source = { kind: "session", sessionId: "s1", quote: "we squash" };
  const inbox = async () => (await inject(app, "GET", "/api/portal")).json().status.counts.inbox;
  const a = (await memory.propose(input({ key: "merge-style", body: "PRs are squash-merged.", authority: "observed", source }), agent)).record;
  const b = (await memory.propose(input({ key: "ci", body: "CI runs on every push.", authority: "inferred", source }), agent)).record;
  assert.equal(await inbox(), 2);
  assert.deepEqual((await inject(app, "GET", "/api/portal/memory/records?status=proposed")).json().records.map((r) => r.id).sort(), [a.id, b.id].sort());

  const approved = await inject(app, "POST", `/api/portal/memory/records/${a.id}/approve`);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().record.status, "active");
  assert.equal(approved.json().record.authority, "user_confirmed");
  assert.equal((await inject(app, "POST", `/api/portal/memory/records/${a.id}/approve`)).statusCode, 409);

  const rejected = await inject(app, "POST", `/api/portal/memory/records/${b.id}/reject`, { reason: "Wrong" });
  assert.equal(rejected.json().record.status, "rejected");
  assert.equal(await inbox(), 0);

  const forgotten = await inject(app, "POST", `/api/portal/memory/records/${a.id}/forget`, {});
  assert.equal(forgotten.json().record.status, "archived");
  assert.equal((await inject(app, "POST", "/api/portal/memory/records/nope/forget")).statusCode, 404);
  const revisions = (await inject(app, "GET", `/api/portal/memory/revisions?recordId=${b.id}`)).json().revisions;
  assert.equal(revisions[0].reason, "Wrong");
  const activity = await appContext(app).orchestrator.hub.activity.list({ kind: "memory." });
  assert.deepEqual(activity.map((entry) => [entry.kind, entry.actor]).slice(0, 3), [["memory.forgotten", "user"], ["memory.rejected", "user"], ["memory.approved", "user"]]);

  // Retrieval on Postgres: the any-term search finds the claim from the turn's text.
  const kept = (await memory.remember(input({ entity: { type: "task_type", key: "deploy" }, key: "steps", body: "Roll out through staging." }), agent)).record;
  const context = await memory.promptContext({ scope: { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] }, query: "how do we roll out?", threadId: null });
  assert.ok(context.retrieved.includes(kept.id));
});

test("memory routes refuse cross-origin requests", async (t) => {
  const { app } = await setup(t);
  const headers = { origin: "https://evil.example", host: "portal.local" };
  for (const [method, url] of [
    ["GET", "/api/portal/memory/entities"], ["GET", "/api/portal/memory/entities/x"], ["GET", "/api/portal/memory/records"],
    ["POST", "/api/portal/memory/records"], ["PATCH", "/api/portal/memory/records/x"], ["POST", "/api/portal/memory/records/x/approve"],
    ["POST", "/api/portal/memory/records/x/reject"], ["POST", "/api/portal/memory/records/x/forget"], ["GET", "/api/portal/memory/revisions"],
    ["GET", "/api/portal/memory/core"],
  ]) {
    const response = await inject(app, method, url, method === "GET" ? undefined : {}, headers);
    assert.equal(response.statusCode, 403, `${method} ${url}`);
  }
});
