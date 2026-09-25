import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANGE_LOG_KEEP_MS, changeEntries, createMemoryChangeStore, recordChanges, settleChanges, stillHolds,
} from "../src/orchestrator/world/changes.ts";
import { createPgChangeStore } from "../src/orchestrator/world/pg-store.ts";
import { T0, attentionPull } from "./fixtures/orchestrator-fakes.mjs";
import { temporaryDatabase } from "./helpers/db.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;

function snap(overrides = {}) {
  return { at: T0, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [], ...overrides };
}

function session(overrides = {}) {
  return { activity: "idle", lastActiveAt: T0 - HOUR, title: "Fix the login bug", projectId: "p1", link: "live", ...overrides };
}

/** A world around a snapshot, as `changeEntries` and `recordChanges` read it. */
function world(snapshot, overrides = {}) {
  return {
    at: snapshot.at, login: "moses-lee", projects: [{ id: "p1", name: "app" }], repos: [], sessions: [{ id: "s1", createdAt: T0 - 2 * HOUR }], terminals: [],
    pulls: Object.values(snapshot.pulls), intents: [], jobs: [], items: [], errors: [], snapshot, ...overrides,
  };
}

const pull = (overrides = {}) => attentionPull({ createdAt: T0 - 3 * HOUR, pushedAt: T0 - HOUR, ...overrides });
const pulls = (...list) => Object.fromEntries(list.map((entry) => [`${entry.repo}#${entry.number}`, entry]));

test("changeEntries: nothing on the first snapshot, then one entry per changed subject with its refs, owner, and last activity", () => {
  const next = snap({
    sessions: { s1: session({ activity: "waiting", lastActiveAt: T0 - 10 * MIN }) },
    pulls: pulls(pull({ checks: "failing", localProjectId: "p1" })),
    missingProjects: ["p1"],
  });
  assert.deepEqual(changeEntries(null, world(next)), [], "a first look reports nothing as news");

  const entries = changeEntries(snap({ at: T0 - HOUR, sessions: { s1: session() }, pulls: pulls(pull()) }), world(next));
  const bySubject = Object.fromEntries(entries.map((entry) => [entry.subject, entry]));
  assert.deepEqual(Object.keys(bySubject).sort(), ["folder:p1", "pr:acme/app#7", "session:s1"]);
  assert.deepEqual(bySubject["session:s1"], {
    kind: "session_waiting", fingerprint: "session_waiting:s1", summary: 'Session "Fix the login bug" is waiting for your permission', detail: null,
    subject: "session:s1", refs: { sessionId: "s1", projectId: "p1" }, mine: true, activeAt: T0 - 10 * MIN,
  });
  assert.equal(bySubject["pr:acme/app#7"].kind, "pr_checks_failing");
  assert.equal(bySubject["pr:acme/app#7"].fingerprint, "pr:acme/app#7");
  assert.deepEqual(bySubject["pr:acme/app#7"].refs, { pull: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }, projectId: "p1" });
  assert.equal(bySubject["pr:acme/app#7"].mine, true);
  assert.equal(bySubject["pr:acme/app#7"].activeAt, T0 - HOUR, "the later of opened and pushed");
  assert.equal(bySubject["folder:p1"].summary, "The folder of project app is missing", "names, not ids");
  assert.equal(bySubject["folder:p1"].mine, false);
});

test("changeEntries: a review request is one entry per newly requested PR, never for a shrinking or unchanged list", () => {
  const one = pull({ number: 1, roles: ["reviewer"], author: "alice", title: "Tidy up" });
  const two = pull({ number: 2, roles: ["reviewer"], author: "bob", title: "Speed up" });
  const grown = changeEntries(snap({ at: T0 - HOUR, pulls: pulls(one) }), world(snap({ pulls: pulls(one, two) })));
  assert.deepEqual(grown.map((entry) => [entry.subject, entry.kind, entry.fingerprint, entry.summary]), [
    ["review:acme/app#2", "pr_review_requested", "pr_review_requested:acme/app", 'bob asked for your review on acme/app#2 "Speed up"'],
  ]);
  assert.equal(grown[0].mine, false);
  assert.deepEqual(changeEntries(snap({ at: T0 - HOUR, pulls: pulls(one, two) }), world(snap({ pulls: pulls(one) }))), []);
  assert.deepEqual(changeEntries(snap({ at: T0 - HOUR, pulls: pulls(one) }), world(snap({ pulls: pulls(one) }))), []);
});

test("stillHolds: each subject against the current snapshot; merged and closed always hold", () => {
  const now = snap({
    sessions: { s1: session({ activity: "waiting" }), s2: session({ activity: "working" }), s3: session() },
    pulls: pulls(pull({ checks: "failing" }), pull({ number: 8 }), pull({ number: 9, roles: ["reviewer"] })),
    missingProjects: ["p9"],
  });
  assert.equal(stillHolds({ subject: "session:s1", kind: "session_waiting" }, now), true);
  assert.equal(stillHolds({ subject: "session:s3", kind: "session_waiting" }, now), false);
  assert.equal(stillHolds({ subject: "session:s3", kind: "session_finished" }, now), true);
  assert.equal(stillHolds({ subject: "session:s2", kind: "session_finished" }, now), false, "working again");
  assert.equal(stillHolds({ subject: "session:gone", kind: "session_finished" }, now), false);
  assert.equal(stillHolds({ subject: "pr:acme/app#7", kind: "pr_checks_failing" }, now), true);
  assert.equal(stillHolds({ subject: "pr:acme/app#8", kind: "pr_checks_failing" }, now), false, "green again");
  assert.equal(stillHolds({ subject: "pr:acme/app#99", kind: "pr_merged" }, now), true);
  assert.equal(stillHolds({ subject: "review:acme/app#9", kind: "pr_review_requested" }, now), true);
  assert.equal(stillHolds({ subject: "review:acme/app#8", kind: "pr_review_requested" }, now), false);
  assert.equal(stillHolds({ subject: "folder:p9", kind: "folder_missing" }, now), true);
  assert.equal(stillHolds({ subject: "folder:p1", kind: "folder_missing" }, now), false);
});

test("settleChanges: an entry replaces its subject's row; a row with no entry goes once its state no longer holds", () => {
  const entry = { subject: "pr:acme/app#7", kind: "pr_conflicts" };
  const stored = [{ subject: "pr:acme/app#7", kind: "pr_checks_failing" }, { subject: "session:s1", kind: "session_waiting" }, { subject: "pr:acme/app#1", kind: "pr_merged" }];
  const settled = settleChanges(stored, [entry, { ...entry, kind: "pr_changes_requested" }], snap({ sessions: { s1: session() } }));
  assert.deepEqual(settled.record, [{ ...entry, kind: "pr_changes_requested" }], "one entry per subject, the last");
  assert.deepEqual(settled.remove, ["session:s1"]);
});

test("the collapse rule: failing → passing → failing is one row at its latest state; failing → passing leaves nothing", async () => {
  const store = createMemoryChangeStore();
  const at = (i) => T0 + i * HOUR;
  const failing = (i) => world(snap({ at: at(i), pulls: pulls(pull({ checks: "failing" })) }));
  const passing = (i) => world(snap({ at: at(i), pulls: pulls(pull()) }));
  const start = snap({ at: at(0), pulls: pulls(pull()) });

  assert.equal(await recordChanges(store, start, failing(1)), 1);
  assert.deepEqual((await store.list()).map((row) => [row.subject, row.kind, row.at]), [["pr:acme/app#7", "pr_checks_failing", at(1)]]);
  await recordChanges(store, failing(1).snapshot, passing(2));
  assert.deepEqual(await store.list(), [], "green again before anyone heard: never offered");
  await recordChanges(store, passing(2).snapshot, failing(3));
  const rows = await store.list();
  assert.deepEqual(rows.map((row) => [row.subject, row.kind, row.at]), [["pr:acme/app#7", "pr_checks_failing", at(3)]]);

  // A new state of the same subject replaces the row: conflicts too, then merged.
  const worse = world(snap({ at: at(4), pulls: pulls(pull({ checks: "failing", mergeable: "conflicting" })) }));
  await recordChanges(store, failing(3).snapshot, worse);
  let [row] = await store.list();
  assert.match(row.summary, /checks failing, merge conflicts/);
  assert.equal(row.at, at(4));
  const merged = world(snap({ at: at(5), pulls: pulls(pull({ state: "merged", checks: "failing" })) }));
  await recordChanges(store, worse.snapshot, merged);
  [row] = await store.list();
  assert.equal(row.kind, "pr_merged");
  // The merged PR leaves the snapshot on the refresh after; its row stays.
  await recordChanges(store, merged.snapshot, world(snap({ at: at(6) })));
  assert.deepEqual((await store.list()).map((entry) => entry.kind), ["pr_merged"]);
  assert.equal((await store.list()).length, 1);

  // Rows are pruned after two weeks.
  await recordChanges(store, snap({ at: at(6) }), world(snap({ at: at(5) + CHANGE_LOG_KEEP_MS + 1 })));
  assert.deepEqual(await store.list(), []);
});

function storeBehaviour(label, open) {
  const entry = (subject, overrides = {}) => ({
    subject, kind: "pr_checks_failing", fingerprint: `pr:${subject}`, summary: `about ${subject}`, detail: null,
    refs: { pull: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" } }, mine: true, activeAt: T0 - HOUR, ...overrides,
  });

  test(`${label} change store: record upserts per subject, lists newest first, removes, and prunes`, async (t) => {
    const store = await open(t);
    assert.deepEqual(await store.list(), []);
    await store.record([entry("a"), entry("b", { detail: "- one\n- two", mine: false, activeAt: null })], T0);
    await store.record([entry("c", { summary: "bad\u0000byte" })], T0 + MIN);
    let rows = await store.list();
    assert.deepEqual(rows.map((row) => row.subject), ["c", "b", "a"]);
    assert.equal(rows[0].summary, "badbyte");
    assert.deepEqual(rows[1], { id: rows[1].id, subject: "b", at: T0, kind: "pr_checks_failing", fingerprint: "pr:b", summary: "about b", detail: "- one\n- two", refs: entry("b").refs, mine: false, activeAt: null });

    await store.record([entry("a", { kind: "pr_merged", summary: "merged" })], T0 + 2 * MIN);
    rows = await store.list();
    assert.deepEqual(rows.map((row) => [row.subject, row.kind, row.at]), [["a", "pr_merged", T0 + 2 * MIN], ["c", "pr_checks_failing", T0 + MIN], ["b", "pr_checks_failing", T0]]);
    assert.deepEqual((await store.list({ since: T0 + MIN })).map((row) => row.subject), ["a", "c"]);
    assert.deepEqual((await store.list({ limit: 1 })).map((row) => row.subject), ["a"]);
    assert.deepEqual((await store.subjects()).map((row) => `${row.subject}:${row.kind}`).sort(), ["a:pr_merged", "b:pr_checks_failing", "c:pr_checks_failing"]);

    assert.equal(await store.remove(["b", "nope"]), 1);
    assert.equal(await store.remove([]), 0);
    assert.equal(await store.prune(T0 + 2 * MIN), 1);
    assert.deepEqual((await store.list()).map((row) => row.subject), ["a"]);
  });
}

storeBehaviour("memory", async () => createMemoryChangeStore());
storeBehaviour("postgres", async (t) => createPgChangeStore({ db: (await temporaryDatabase(t)).db }));
