import assert from "node:assert/strict";
import test from "node:test";
import { createPgMemoryStore } from "../src/orchestrator/memory/pg-store.ts";
import { MemoryConflictError, createInMemoryMemoryStore, newRecordId } from "../src/orchestrator/memory/store.ts";
import { OrchestratorStoreError } from "../src/orchestrator/store.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const scope = { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] };

let clock = 1_700_000_000_000;
const now = () => ++clock;

function record(entityId, overrides = {}) {
  const at = now();
  return {
    id: newRecordId(), entityId, type: "convention", key: "review-style", body: "Reviews focus on tests first.", status: "active", scope,
    authority: "user_stated", source: { kind: "message", quote: "focus on tests first" }, trust: 1, pinned: false, reviewBy: null,
    supersedes: null, supersededBy: null, createdAt: at, updatedAt: at, ...overrides,
  };
}

const meta = (action, reason = null) => ({ actor: "user", action, reason });

function behaviour(label, open) {
  test(`${label}: entities are ensured once per type and key, listed global first with active counts`, async (t) => {
    const store = await open(t);
    const repo = await store.ensureEntity({ type: "repo", key: "acme/app", name: "App" });
    const again = await store.ensureEntity({ type: "repo", key: "acme/app", name: "Other" });
    assert.equal(again.id, repo.id);
    assert.equal(again.name, "App");
    const global = await store.ensureEntity({ type: "global", key: "global" });
    const person = await store.ensureEntity({ type: "person", key: "octocat" });
    assert.equal(person.name, "octocat");
    await store.commit([{ op: "insert", record: record(repo.id), revision: meta("created") }]);
    await store.commit([{ op: "insert", record: record(repo.id, { key: "tests", status: "proposed" }), revision: meta("created") }]);
    const listed = await store.listEntities();
    assert.deepEqual(listed.map((entity) => [entity.type, entity.activeRecords]), [["global", 0], ["person", 0], ["repo", 1]]);
    assert.equal((await store.getEntity(repo.id)).activeRecords, 1);
    assert.equal((await store.findEntity("repo", "acme/app")).id, repo.id);
    assert.equal(await store.findEntity("repo", "acme/none"), null);
    assert.deepEqual((await store.listEntities({ type: "person" })).map((entity) => entity.id), [person.id]);
    assert.deepEqual((await store.listEntities({ ids: [global.id] })).map((entity) => entity.id), [global.id]);
  });

  test(`${label}: a second active record for a key is a 409 naming the holder, and nothing of the commit lands`, async (t) => {
    const store = await open(t);
    const entity = await store.ensureEntity({ type: "repo", key: "acme/app" });
    const first = record(entity.id);
    await store.commit([{ op: "insert", record: first, revision: meta("created") }]);
    const other = record(entity.id, { key: "other" });
    const clash = record(entity.id, { body: "Reviews focus on docs." });
    await assert.rejects(
      store.commit([{ op: "insert", record: other, revision: meta("created") }, { op: "insert", record: clash, revision: meta("created") }]),
      (err) => err instanceof MemoryConflictError && err.status === 409 && err.existing.id === first.id && err.message.includes(first.id),
    );
    assert.equal(await store.getRecord(other.id), null, "the whole commit rolled back");
    assert.equal((await store.listRevisions()).length, 1);
    // A proposed record for the same key is fine: the inbox may hold a rival claim.
    await store.commit([{ op: "insert", record: record(entity.id, { status: "proposed", body: "Rival." }), revision: meta("created") }]);
    // So is the same key on another entity.
    const second = await store.ensureEntity({ type: "repo", key: "acme/web" });
    await store.commit([{ op: "insert", record: record(second.id), revision: meta("created") }]);
  });

  test(`${label}: superseding is one commit: the old record points at the new, both get revisions`, async (t) => {
    const store = await open(t);
    const entity = await store.ensureEntity({ type: "repo", key: "acme/app" });
    const old = record(entity.id);
    await store.commit([{ op: "insert", record: old, revision: meta("created") }]);
    const next = record(entity.id, { body: "Reviews focus on docs first.", supersedes: old.id });
    const [was, now_] = await store.commit([
      { op: "update", id: old.id, from: ["active"], patch: { status: "superseded", supersededBy: next.id }, revision: meta("superseded", "replaced") },
      { op: "insert", record: next, revision: meta("created") },
    ]);
    assert.equal(was.status, "superseded");
    assert.equal(was.supersededBy, next.id);
    assert.ok(was.updatedAt > old.updatedAt);
    assert.equal(was.body, old.body, "the claim itself never changes");
    assert.equal(now_.supersedes, old.id);
    assert.equal((await store.activeRecord(entity.id, "review-style")).id, next.id);
    const revisions = await store.listRevisions({ entityId: entity.id });
    assert.deepEqual(revisions.map((revision) => revision.action), ["created", "superseded", "created"]);
    assert.equal(revisions[1].before.status, "active");
    assert.equal(revisions[1].after.status, "superseded");
    assert.equal(revisions[1].reason, "replaced");
    assert.deepEqual((await store.listRevisions({ recordId: old.id })).map((revision) => revision.action), ["superseded", "created"]);
    // A stale update (the record is no longer active) is refused.
    await assert.rejects(
      store.commit([{ op: "update", id: old.id, from: ["active"], patch: { status: "archived" }, revision: meta("archived") }]),
      (err) => err instanceof OrchestratorStoreError && err.status === 409,
    );
    await assert.rejects(store.commit([{ op: "update", id: "nope", patch: {}, revision: meta("updated") }]), (err) => err.status === 404);
  });

  test(`${label}: records list by status, entity, type, and key, newest first; counts agree`, async (t) => {
    const store = await open(t);
    const a = await store.ensureEntity({ type: "repo", key: "acme/app" });
    const b = await store.ensureEntity({ type: "person", key: "octocat" });
    await store.commit([
      { op: "insert", record: record(a.id, { key: "one" }), revision: meta("created") },
      { op: "insert", record: record(a.id, { key: "two", status: "proposed", type: "fact" }), revision: meta("created") },
      { op: "insert", record: record(b.id, { key: "three", pinned: true }), revision: meta("created") },
    ]);
    assert.deepEqual((await store.listRecords()).map((r) => r.key), ["three", "two", "one"]);
    assert.deepEqual((await store.listRecords({ status: ["active"] })).map((r) => r.key), ["three", "one"]);
    assert.deepEqual((await store.listRecords({ entityIds: [a.id], type: "fact" })).map((r) => r.key), ["two"]);
    assert.deepEqual((await store.listRecords({ pinned: true })).map((r) => r.key), ["three"]);
    assert.deepEqual((await store.listRecords({ key: "one" })).map((r) => r.key), ["one"]);
    assert.deepEqual(await store.listRecords({ entityIds: [] }), []);
    assert.equal(await store.countRecords({ status: ["proposed"] }), 1);
    assert.equal(await store.countRecords(), 3);
    assert.deepEqual((await store.listRecords({ limit: 1 })).map((r) => r.key), ["three"]);
  });

  test(`${label}: full-text search matches key and body; all-terms and any-term modes; filters apply`, async (t) => {
    const store = await open(t);
    const entity = await store.ensureEntity({ type: "repo", key: "acme/app" });
    await store.commit([
      { op: "insert", record: record(entity.id, { key: "review-style", body: "Check the migrations before anything else." }), revision: meta("created") },
      { op: "insert", record: record(entity.id, { key: "deploy", body: "Deploys go through the staging cluster." }), revision: meta("created") },
      { op: "insert", record: record(entity.id, { key: "models", body: "Use opus for review work.", status: "proposed" }), revision: meta("created") },
    ]);
    assert.deepEqual((await store.searchRecords("migrations")).map((hit) => hit.record.key), ["review-style"]);
    assert.deepEqual((await store.searchRecords("review")).map((hit) => hit.record.key).sort(), ["models", "review-style"], "the key is searchable");
    assert.deepEqual((await store.searchRecords("staging cluster")).map((hit) => hit.record.key), ["deploy"]);
    assert.deepEqual(await store.searchRecords("staging migrations"), [], "all terms must match");
    const any = await store.searchRecords("staging migrations", { mode: "any" });
    assert.deepEqual(any.map((hit) => hit.record.key).sort(), ["deploy", "review-style"]);
    assert.ok(any.every((hit) => hit.rank > 0));
    assert.deepEqual((await store.searchRecords("review", { status: ["active"] })).map((hit) => hit.record.key), ["review-style"]);
    assert.deepEqual(await store.searchRecords("   "), []);
    assert.deepEqual(await store.searchRecords("the of", { mode: "any" }), []);
  });

  test(`${label}: revisions page newest first and filter by action; a free-standing revision is stored`, async (t) => {
    const store = await open(t);
    const entity = await store.ensureEntity({ type: "global", key: "global" });
    for (const key of ["a", "b", "c"]) await store.commit([{ op: "insert", record: record(entity.id, { key }), revision: meta("created") }]);
    const marker = await store.appendRevision({ recordId: null, entityId: entity.id, actor: "system", action: "imported", before: null, after: null, reason: "marker", runId: null });
    assert.equal(marker.action, "imported");
    const all = await store.listRevisions();
    assert.equal(all.length, 4);
    assert.equal(all[0].id, marker.id);
    const page = await store.listRevisions({ before: all[1].id, limit: 1 });
    assert.deepEqual(page.map((revision) => revision.id), [all[2].id]);
    assert.deepEqual((await store.listRevisions({ action: "imported" })).map((revision) => revision.reason), ["marker"]);
  });

  test(`${label}: an entity summary is replaced with a revision that names no record`, async (t) => {
    const store = await open(t);
    const entity = await store.ensureEntity({ type: "repo", key: "acme/app" });
    await store.commit([{ op: "insert", record: record(entity.id), revision: meta("created") }]);
    const updated = await store.setEntitySummary(entity.id, "Reviews start with the tests.\u0000", { actor: "consolidator", action: "summarized", reason: "Curation", runId: "r1" });
    assert.equal(updated.summary.replace("\u0000", ""), "Reviews start with the tests.");
    assert.equal(updated.activeRecords, 1);
    assert.ok(updated.updatedAt >= entity.updatedAt);
    assert.equal((await store.getEntity(entity.id)).summary, updated.summary);
    const [revision] = await store.listRevisions({ action: "summarized" });
    assert.deepEqual(
      { recordId: revision.recordId, entityId: revision.entityId, actor: revision.actor, reason: revision.reason, runId: revision.runId, before: revision.before, after: revision.after },
      { recordId: null, entityId: entity.id, actor: "consolidator", reason: "Curation", runId: "r1", before: null, after: null },
    );
    await assert.rejects(store.setEntitySummary("e-missing", "x", { actor: "consolidator", action: "summarized" }), (err) => err instanceof OrchestratorStoreError && err.status === 404);
  });
}

behaviour("memory store", async () => createInMemoryMemoryStore({ now }));
behaviour("postgres store", async (t) => {
  const { db } = await temporaryDatabase(t);
  return createPgMemoryStore({ db, now });
});

test("postgres store: the partial unique index backs the conflict check, and NUL is stripped", async (t) => {
  const { db, sql } = await temporaryDatabase(t);
  const store = createPgMemoryStore({ db, now });
  const entity = await store.ensureEntity({ type: "repo", key: "acme/app" });
  const first = record(entity.id, { body: "Nul\u0000 here." });
  await store.commit([{ op: "insert", record: first, revision: meta("created") }]);
  assert.equal((await store.getRecord(first.id)).body, "Nul here.");
  // Straight to the table, past the store's own check: Postgres still refuses a second active key.
  await assert.rejects(sql`insert into memory_records (id, entity_id, type, key, body, status, scope, authority, source, trust, pinned, created_at, updated_at)
    values ('x1', ${entity.id}, 'fact', 'review-style', 'other', 'active', '{}', 'user_stated', '{}', 1, false, 1, 1)`, /memory_records_active_key_idx/);
  const [{ search }] = await sql`select search::text as search from memory_records where id = ${first.id}`;
  assert.match(search, /review/);
});
