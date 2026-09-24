import assert from "node:assert/strict";
import test from "node:test";
import { CORE_BUDGET_TOKENS, RETRIEVED_BUDGET_TOKENS } from "../src/orchestrator/memory/core.ts";
import { MemoryConflictError } from "../src/orchestrator/memory/store.ts";
import { agent, claim, memorySetup, user } from "./fixtures/memory-setup.mjs";

const source = { kind: "pull", pull: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }, quote: "we always squash" };
const proposal = (overrides = {}) => claim({ key: "merge-style", body: "PRs are squash-merged.", authority: "observed", source, ...overrides });

test("remember applies at once; a restatement is a no-op; a new claim for the key supersedes with revisions and activity", async (t) => {
  const { memory, events, activity } = await memorySetup(t);
  const first = await memory.remember(claim({ source: { kind: "message", quote: "review tests before code" } }), agent);
  assert.equal(first.record.status, "active");
  assert.equal(first.record.authority, "user_stated");
  assert.equal(first.record.trust, 1);
  assert.deepEqual(events.filter((event) => event.type === "memory").at(-1), { type: "memory", recordIds: [first.record.id] });

  const again = await memory.remember(claim({ body: "  review tests before CODE. " }), agent);
  assert.equal(again.unchanged, true);
  assert.equal(again.record.id, first.record.id);

  const next = await memory.remember(claim({ body: "Review docs before code." }), agent);
  assert.equal(next.superseded.id, first.record.id);
  assert.equal(next.record.supersedes, first.record.id);
  const old = await memory.store.getRecord(first.record.id);
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, next.record.id);
  assert.deepEqual((await memory.store.listRevisions({ recordId: first.record.id })).map((r) => r.action), ["superseded", "created"]);
  const log = await activity();
  assert.deepEqual(log.map((entry) => entry.kind), ["memory.remembered", "memory.remembered", "memory.superseded"]);
  assert.equal(log[0].actor, "agent");
  assert.deepEqual(log[0].refs, { recordId: first.record.id, entityId: first.record.entityId, runId: "run1", threadId: "main" });
});

test("create (the browser) is user-stated but refuses a taken key with a conflict naming the holder", async (t) => {
  const { memory } = await memorySetup(t);
  const { record } = await memory.create(claim(), user);
  assert.equal(record.source.kind, "ui");
  assert.equal(record.authority, "user_stated");
  await assert.rejects(memory.create(claim({ body: "Something else." }), user), (err) => err instanceof MemoryConflictError && err.existing.id === record.id);
  assert.equal((await memory.create(claim(), user)).unchanged, true);
});

test("propose goes to the inbox; duplicates are no-ops; approving supersedes the active claim as user_confirmed", async (t) => {
  const { memory, activity } = await memorySetup(t);
  const proposed = await memory.propose(proposal(), agent);
  assert.equal(proposed.record.status, "proposed");
  assert.equal(proposed.record.trust, 0.6);
  assert.equal(await memory.inboxCount(), 1);
  assert.equal((await memory.propose(proposal({ body: "PRs are squash-merged. " }), agent)).record.id, proposed.record.id);
  assert.equal(await memory.inboxCount(), 1);
  // The same claim from the same source is nothing new; from another source it is a sighting, not a second proposal.
  assert.equal((await memory.propose(proposal({ source: { ...source, quote: "squash again" } }), agent)).unchanged, true);
  const fromSession = { kind: "session", sessionId: "s9", quote: "we squash on merge" };
  const seen = await memory.propose(proposal({ source: fromSession }), agent);
  assert.equal(seen.corroborated, true);
  assert.equal(seen.record.id, proposed.record.id);
  assert.deepEqual(seen.record.sightings, [fromSession]);
  assert.equal(seen.record.source.quote, "we always squash", "the first source stays the record's own");
  assert.equal((await memory.propose(proposal({ source: fromSession }), agent)).unchanged, true, "the same session again adds nothing");
  assert.equal((await memory.propose(proposal({ source: { ...fromSession, runId: "run2", quote: "squash!" } }), agent)).unchanged, true, "nor does the same session in a later turn");
  assert.equal((await memory.store.getRecord(proposed.record.id)).sightings.length, 1);
  assert.equal(await memory.inboxCount(), 1);
  assert.deepEqual((await memory.store.listRevisions({ recordId: proposed.record.id })).map((r) => r.action), ["corroborated", "created"]);
  assert.equal((await activity()).at(-1).kind, "memory.corroborated");

  const approved = await memory.approve(proposed.record.id, user);
  assert.equal(approved.record.status, "active");
  assert.equal(approved.record.authority, "user_confirmed");
  assert.equal(approved.record.trust, 0.9);
  assert.equal(await memory.inboxCount(), 0);
  // The same claim again is already known.
  const known = await memory.propose(proposal(), agent);
  assert.equal(known.unchanged, true);
  assert.equal(known.record.id, proposed.record.id);

  // A different claim for the key is proposed as its successor; approving it supersedes.
  const rival = await memory.propose(proposal({ body: "PRs are rebased and merged.", authority: "inferred" }), agent);
  assert.equal(rival.record.supersedes, proposed.record.id);
  assert.equal((await memory.store.getRecord(proposed.record.id)).status, "active", "a proposal changes nothing until approved");
  const swap = await memory.approve(rival.record.id, user);
  assert.equal(swap.superseded.id, proposed.record.id);
  assert.equal((await memory.store.getRecord(proposed.record.id)).status, "superseded");
  await assert.rejects(memory.approve(rival.record.id, user), (err) => err.status === 409);
  assert.deepEqual((await memory.store.listRevisions({ recordId: rival.record.id })).map((r) => r.action), ["approved", "created"]);
  assert.deepEqual((await activity()).map((entry) => entry.kind), ["memory.proposed", "memory.corroborated", "memory.approved", "memory.proposed", "memory.approved", "memory.superseded"]);

  await assert.rejects(memory.propose(proposal({ authority: "user_stated" }), agent), (err) => err.status === 400);
});

test("reject and forget keep the record and its lineage; only the right statuses move", async (t) => {
  const { memory, activity } = await memorySetup(t);
  const proposed = await memory.propose(proposal(), agent);
  const rejected = await memory.reject(proposed.record.id, "Not true", user);
  assert.equal(rejected.status, "rejected");
  await assert.rejects(memory.reject(proposed.record.id, null, user), (err) => err.status === 409);
  const revision = (await memory.store.listRevisions({ recordId: proposed.record.id }))[0];
  assert.equal(revision.action, "rejected");
  assert.equal(revision.reason, "Not true");

  const first = await memory.remember(claim(), agent);
  const second = await memory.remember(claim({ body: "Review docs before code." }), agent);
  const forgotten = await memory.forget(second.record.id, "User retracted it", agent);
  assert.equal(forgotten.status, "archived");
  assert.equal(await memory.store.activeRecord(first.record.entityId, "review-style"), null);
  const explained = await memory.explain(second.record.id);
  assert.deepEqual(explained.lineage.earlier.map((record) => record.id), [first.record.id]);
  assert.deepEqual(explained.revisions.map((r) => r.action), ["forgotten", "created"]);
  assert.equal(explained.entity.key, "acme/app");
  await assert.rejects(memory.forget(first.record.id, null, user), (err) => err.status === 409, "a superseded record is not forgotten again");
  await assert.rejects(memory.forget("nope", null, user), (err) => err.status === 404);
  assert.deepEqual((await activity()).map((entry) => entry.kind).filter((kind) => kind !== "memory.remembered" && kind !== "memory.superseded"),
    ["memory.proposed", "memory.rejected", "memory.forgotten"]);
});

test("a user edit of the body supersedes; pinning is only for the user's own claims; archive forgets", async (t) => {
  const { memory } = await memorySetup(t);
  const { record } = await memory.remember(claim(), agent);
  const edited = await memory.edit(record.id, { body: "Review migrations before code." }, user);
  assert.notEqual(edited.record.id, record.id);
  assert.equal(edited.record.authority, "user_stated");
  assert.equal(edited.record.source.kind, "ui");
  assert.equal(edited.record.supersedes, record.id);
  assert.equal((await memory.store.getRecord(record.id)).status, "superseded");
  assert.deepEqual((await memory.store.listRevisions({ recordId: edited.record.id })).map((r) => r.action), ["updated"]);

  const pinned = await memory.edit(edited.record.id, { pinned: true, reviewBy: 1_800_000_000_000 }, user);
  assert.equal(pinned.record.id, edited.record.id, "metadata changes in place");
  assert.equal(pinned.record.pinned, true);
  assert.equal(pinned.record.reviewBy, 1_800_000_000_000);
  assert.equal((await memory.edit(edited.record.id, { pinned: true }, user)).unchanged, true);

  // Confirmed from a PR: active, but content never becomes a directive.
  const fromPull = await memory.approve((await memory.propose(proposal(), agent)).record.id, user);
  await assert.rejects(memory.edit(fromPull.record.id, { pinned: true }, user), (err) => err.status === 400);

  // Editing an inbox item's body states the edited claim: active, replacing the proposal and the holder of its key.
  const inbox = await memory.propose(proposal({ body: "PRs are merged with a merge commit." }), agent);
  const rewritten = await memory.edit(inbox.record.id, { body: "PRs are squash-merged, always." }, user);
  assert.equal(rewritten.record.status, "active");
  assert.equal((await memory.store.getRecord(inbox.record.id)).status, "superseded");
  assert.equal((await memory.store.getRecord(fromPull.record.id)).status, "superseded");

  const archived = await memory.edit(rewritten.record.id, { status: "archived" }, user);
  assert.equal(archived.record.status, "archived");
});

test("secrets never land: the stored API key and credential formats are refused", async (t) => {
  const { memory } = await memorySetup(t, { key: "zz-custom-secret-123" });
  await assert.rejects(memory.remember(claim({ body: "Our key is zz-custom-secret-123." }), agent), /never stores secrets/);
  await assert.rejects(memory.propose(proposal({ body: "Deploy token ghp_abcdefghijklmnopqrstuvwxyz0123" }), agent), /never stores secrets/);
  assert.equal(await memory.store.countRecords(), 0);
});

test("CORE.md: pinned directives first, then one index line per entity; cached until memory changes", async (t) => {
  const { memory } = await memorySetup(t);
  assert.equal((await memory.core()).text, "");
  await memory.remember(claim({ entity: { type: "global", key: "global" }, type: "preference", key: "answers", body: "Keep answers short.", pinned: true }), agent);
  await memory.remember(claim(), agent);
  await memory.remember(claim({ key: "conventions.tests", body: "Tests use node:test." }), agent);
  await memory.remember(claim({ entity: { type: "person", key: "octocat" }, key: "review-style", body: "Octocat wants small PRs." }), agent);
  await memory.propose(proposal({ key: "inbox-only" }), agent);
  const core = await memory.core();
  const lines = core.text.split("\n");
  assert.match(lines[0], /^Directives/);
  assert.match(lines[1], /^- \[m[\w-]+\] global · answers: Keep answers short\.$/);
  assert.ok(lines.includes("- repo acme/app — 2 records: conventions.tests, review-style"));
  assert.ok(lines.includes("- person octocat — 1 record: review-style"));
  assert.ok(lines.includes("- global — 1 record: answers"));
  assert.ok(!core.text.includes("inbox-only"), "proposed records are not in CORE.md");
  assert.ok(core.text.indexOf("- global —") < core.text.indexOf("- person octocat"));
  assert.equal(core.tokens, Math.ceil(core.text.length / 4));
  assert.equal(await memory.core(), core, "cached");
  await memory.remember(claim({ key: "deploys", body: "Deploys are manual." }), agent);
  const next = await memory.core();
  assert.notEqual(next, core);
  assert.match(next.text, /3 records: conventions\.tests, deploys, review-style/);
});

test("CORE.md stays within its budget however much is pinned or indexed", async (t) => {
  const { memory } = await memorySetup(t);
  for (let i = 0; i < 40; i++) {
    await memory.remember(claim({ entity: { type: "global", key: "global" }, key: `rule-${i}`, body: `Rule ${i}: ${"always do the careful thing ".repeat(8)}`, pinned: true }), agent);
  }
  for (let i = 0; i < 60; i++) await memory.remember(claim({ entity: { type: "repo", key: `acme/repo-${i}` }, key: "conventions", body: `Repo ${i} conventions.` }), agent);
  const core = await memory.core();
  assert.ok(core.tokens <= CORE_BUDGET_TOKENS, `${core.tokens} tokens`);
  assert.match(core.text, /more pinned/);
  assert.match(core.text, /more entities/);
  assert.match(core.text, /Index/);
});

test("retrieval: the turn's scope and the entities its text names, plus full-text matches, ranked and capped; pinned stays in CORE", async (t) => {
  const { memory } = await memorySetup(t);
  const app = (await memory.remember(claim({ body: "Review tests before code." }), agent)).record;
  const web = (await memory.remember(claim({ entity: { type: "repo", key: "acme/web" }, body: "Web reviews check accessibility." }), agent)).record;
  const global = (await memory.remember(claim({ entity: { type: "global", key: "global" }, key: "tone", body: "Plain words." }), agent)).record;
  const pinned = (await memory.remember(claim({ entity: { type: "global", key: "global" }, key: "short", body: "Keep it short.", pinned: true }), agent)).record;
  const octo = (await memory.remember(claim({ entity: { type: "person", key: "octocat" }, key: "review-style", body: "Octocat wants small PRs." }), agent)).record;
  const kube = (await memory.remember(claim({ entity: { type: "task_type", key: "deploy" }, key: "steps", type: "procedure", body: "1. Build.\n2. Roll out to kubernetes." }), agent)).record;
  const empty = { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] };

  const scoped = await memory.promptContext({ scope: { ...empty, repos: ["Acme/App"] }, query: "", threadId: null });
  assert.ok(scoped.retrieved.includes(`[${app.id}] convention · repo acme/app · review-style (user_stated): Review tests before code.`));
  assert.ok(scoped.retrieved.includes(global.id));
  assert.ok(!scoped.retrieved.includes(web.id));
  assert.ok(!scoped.retrieved.includes(pinned.id), "pinned records are in CORE.md already");
  assert.ok(scoped.retrieved.indexOf(app.id) < scoped.retrieved.indexOf(global.id), "the repo outranks global");
  assert.match(scoped.core.text, /Keep it short/);

  const named = await memory.promptContext({ scope: empty, query: "How does octocat like reviews? Also kubernetes rollout.", threadId: null });
  assert.ok(named.retrieved.includes(octo.id), "a person named in the text");
  assert.ok(named.retrieved.includes(kube.id), "a full-text match on another entity");
  assert.match(named.retrieved, /procedure \(interpret it, do not paste it\)/);
  assert.ok(!named.retrieved.includes(app.id) || named.retrieved.indexOf(octo.id) < named.retrieved.indexOf(app.id));

  const pulls = await memory.promptContext({ scope: { ...empty, pulls: [{ repo: "acme/web", number: 1, url: "u" }] }, query: "", threadId: null });
  assert.ok(pulls.retrieved.includes(web.id), "a pull's repo is in scope");

  for (let i = 0; i < 80; i++) await memory.remember(claim({ key: `note-${i}`, body: `Note ${i}: ${"detail ".repeat(20)}` }), agent);
  const capped = await memory.promptContext({ scope: { ...empty, repos: ["acme/app"] }, query: "", threadId: null });
  assert.ok(Math.ceil(capped.retrieved.length / 4) <= RETRIEVED_BUDGET_TOKENS);
  assert.match(capped.retrieved, /more \(search_memory finds them\)$/);
});
