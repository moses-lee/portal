import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRTY_IDLE_MS, REVIEW_LIST_ROWS, STALE_PULL_MS, collectSnapshot, diffSnapshots, resetDigestCaches,
  reviewDetail, snapshotActivity,
} from "../src/orchestrator/digest.ts";
import { createMemoryOrchestratorStore } from "../src/orchestrator/store.ts";
import { T0, attentionPull, fakeDeps, project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";

const DAY = 86_400_000;

function snap(overrides = {}) {
  return { at: T0, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [], ...overrides };
}

function session(overrides = {}) {
  return { activity: "idle", lastActiveAt: T0 - 60_000, title: "Fix login", projectId: "p1", link: "live", ...overrides };
}

const pull = (overrides = {}) => attentionPull({ localProjectId: "p1", ...overrides });
/** A PR whose review was requested, keyed for a snapshot. */
const review = (number, overrides = {}) => pull({ number, roles: ["reviewer"], title: `Review ${number}`, updatedAt: T0 - number * DAY, ...overrides });
const keyed = (...pulls) => Object.fromEntries(pulls.map((entry) => [`${entry.repo}#${entry.number}`, entry]));

function item(fingerprint, overrides = {}) {
  const kind = fingerprint.split(":")[0];
  return {
    id: `item-${fingerprint}`, kind: kind === "pr" ? "pr_checks_failing" : kind, title: "t", body: "", links: {}, actions: [],
    fingerprint, status: "open", createdAt: 1, updatedAt: 1, snoozedUntil: null, ...overrides,
  };
}

const kinds = (changes) => changes.map((change) => change.kind);
const only = (changes, kind) => changes.filter((change) => change.kind === kind);
const fingerprints = (changes) => changes.map((change) => change.fingerprint);

// ---------------------------------------------------------------------------------------------
// First snapshot
// ---------------------------------------------------------------------------------------------

test("the first snapshot reports current conditions only, never transitions", () => {
  const next = snap({
    sessions: {
      idle: session(),
      waiting: session({ activity: "waiting" }),
      offline: session({ activity: "error" }),
      working: session({ activity: "working" }),
    },
    pulls: keyed(pull({ checks: "failing", mergeable: "conflicting" }), review(1), review(2), review(3, { repo: "acme/web" })),
    worktrees: { w1: { branch: "feat", merged: true, dirty: false, parentId: "p1" }, w2: { branch: "old", merged: false, dirty: true, parentId: "p1" } },
    missingProjects: ["gone"],
  });
  const changes = diffSnapshots(null, next, []);
  assert.deepEqual(kinds(changes).sort(), [
    "folder_missing", "pr_checks_failing", "pr_review_requested", "pr_review_requested", "session_offline", "session_waiting", "worktree_dirty", "worktree_merged",
  ]);
  assert.ok(!kinds(changes).includes("session_finished"), "finished is a transition");
  for (const change of changes) {
    assert.equal(change.existingItemId, null);
    assert.equal(change.resolvesItemId, undefined);
    assert.match(change.fingerprint, /^[a-z_]+:\S+$/);
  }
  const waiting = only(changes, "session_waiting")[0];
  assert.equal(waiting.fingerprint, "session_waiting:waiting");
  assert.deepEqual(waiting.links, { sessionId: "waiting", projectId: "p1" });
  assert.match(waiting.summary, /"Fix login" is waiting/);
  const authored = only(changes, "pr_checks_failing")[0];
  assert.equal(authored.fingerprint, "pr:acme/app#7");
  assert.equal(authored.summary, 'PR acme/app#7 "Add thing" needs attention: checks failing, merge conflicts');
  assert.deepEqual(authored.links, { pull: { repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }, projectId: "p1" });
  assert.equal(authored.detail, undefined);
  assert.deepEqual(fingerprints(only(changes, "pr_review_requested")), ["pr_review_requested:acme/app", "pr_review_requested:acme/web"]);
});

test("nothing to report yields no changes", () => {
  assert.deepEqual(diffSnapshots(null, snap({ sessions: { s1: session() } }), []), []);
  assert.deepEqual(diffSnapshots(snap({ sessions: { s1: session() } }), snap({ at: T0 + 1, sessions: { s1: session() } }), []), []);
  assert.deepEqual(diffSnapshots(null, snap({ pulls: keyed(pull()) }), []), [], "a clean authored PR is not news");
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

test("a session that went from working to idle without a new prompt finished, but only while its agent is live", () => {
  const prev = snap({ sessions: { s1: session({ activity: "working", lastActiveAt: T0 - 60_000 }) } });
  const finished = diffSnapshots(prev, snap({ at: T0 + 1, sessions: { s1: session({ activity: "idle", lastActiveAt: T0 - 60_000 }) } }), []);
  assert.deepEqual(kinds(finished), ["session_finished"]);
  assert.equal(finished[0].fingerprint, "session_finished:s1");

  // Prompted again since: the user is on it, so nothing is reported.
  const prompted = diffSnapshots(prev, snap({ at: T0 + 1, sessions: { s1: session({ activity: "idle", lastActiveAt: T0 }) } }), []);
  assert.deepEqual(prompted, []);
  // Still working: nothing yet.
  assert.deepEqual(diffSnapshots(prev, snap({ at: T0 + 1, sessions: { s1: session({ activity: "working", lastActiveAt: T0 - 60_000 }) } }), []), []);
  // Portal restarted: the session reads idle because it is offline, not because the agent finished.
  for (const link of ["offline", "connecting", undefined]) {
    const restarted = snap({ at: T0 + 1, sessions: { s1: session({ activity: "idle", lastActiveAt: T0 - 60_000, link }) } });
    assert.deepEqual(diffSnapshots(prev, restarted, []), [], `link ${link}`);
  }
});

test("a session whose turn was cancelled is reported as stopped, not finished; working again resolves that item", () => {
  const prev = snap({ sessions: { s1: session({ activity: "working" }) } });
  const stopped = diffSnapshots(prev, snap({ at: T0 + 1, sessions: { s1: session({ stopped: true }) } }), []);
  assert.deepEqual(kinds(stopped), ["session_stopped"]);
  assert.equal(stopped[0].fingerprint, "session_stopped:s1");
  assert.match(stopped[0].summary, /stopped: its turn was cancelled/);
  assert.doesNotMatch(stopped[0].summary, /finished/);
  const [working] = diffSnapshots(snap({ sessions: { s1: session() } }), snap({ at: T0 + 1, sessions: { s1: session({ activity: "working" }) } }), [item("session_stopped:s1")]);
  assert.equal(working.resolvesItemId, "item-session_stopped:s1");
});

test("collectSnapshot marks a session that went idle through a cancelled turn, reading events only for sessions that just went idle", async () => {
  const cancelled = [{ type: "turn_start", seq: 0, ts: 0 }, { type: "permission_response", requestId: "r", outcome: "cancelled", seq: 1, ts: 0 }, { type: "turn_end", stopReason: "cancelled", seq: 2, ts: 0 }];
  const done = [{ type: "turn_start", seq: 0, ts: 0 }, { type: "turn_end", stopReason: "end_turn", seq: 1, ts: 0 }];
  const { deps } = fakeDeps({ sessions: [sessionMeta({ id: "s1" }), sessionMeta({ id: "s2" }), sessionMeta({ id: "s3" })], events: { s1: cancelled, s2: done, s3: cancelled } });
  const reads = [];
  const readEvents = deps.sessions.readEvents;
  deps.sessions.readEvents = async (id, opts) => { reads.push(id); return readEvents(id, opts); };
  const busy = session({ activity: "working", lastActiveAt: T0 - 30_000 });
  const previous = snap({ sessions: { s1: busy, s2: busy, s3: session() } });
  const snapshot = await collectSnapshot({ deps, previous, now: T0, log: [] });
  assert.equal(snapshot.sessions.s1.stopped, true);
  assert.equal(snapshot.sessions.s2.stopped, undefined, "a turn that ended by itself finished");
  assert.equal(snapshot.sessions.s3.stopped, undefined, "idle before: an old stop is not news");
  assert.deepEqual(reads.sort(), ["s1", "s2"]);
  assert.deepEqual(kinds(diffSnapshots(previous, snapshot, [])), ["session_stopped", "session_finished"]);
});

test("entering waiting or error is reported once; leaving it resolves the open item", () => {
  const idle = snap({ sessions: { s1: session() } });
  const waiting = snap({ at: T0 + 1, sessions: { s1: session({ activity: "waiting" }) } });
  assert.deepEqual(kinds(diffSnapshots(idle, waiting, [])), ["session_waiting"]);
  assert.deepEqual(diffSnapshots(waiting, { ...waiting, at: T0 + 2 }, []), [], "still waiting is not news");

  const open = [item("session_waiting:s1")];
  const [cleared] = diffSnapshots(waiting, snap({ at: T0 + 3, sessions: { s1: session({ activity: "working" }) } }), open);
  assert.equal(cleared.kind, "session_waiting");
  assert.equal(cleared.resolvesItemId, "item-session_waiting:s1");
  assert.equal(cleared.existingItemId, "item-session_waiting:s1");
  assert.match(cleared.summary, /: cleared$/);
  // Without an open item the clearing is silent.
  assert.deepEqual(diffSnapshots(waiting, snap({ at: T0 + 3, sessions: { s1: session() } }), []), []);

  const offline = snap({ at: T0 + 1, sessions: { s1: session({ activity: "error" }) } });
  assert.deepEqual(kinds(diffSnapshots(idle, offline, [])), ["session_offline"]);
  const [back] = diffSnapshots(offline, snap({ at: T0 + 2, sessions: { s1: session() } }), [item("session_offline:s1")]);
  assert.equal(back.resolvesItemId, "item-session_offline:s1");
});

test("a finished item resolves once the session works again, and a deleted session resolves its items", () => {
  const idle = snap({ sessions: { s1: session() } });
  const [working] = diffSnapshots(idle, snap({ at: T0 + 1, sessions: { s1: session({ activity: "working" }) } }), [item("session_finished:s1")]);
  assert.equal(working.resolvesItemId, "item-session_finished:s1");

  const gone = diffSnapshots(idle, snap({ at: T0 + 1 }), [item("session_waiting:s1"), item("session_finished:s1")]);
  assert.deepEqual(gone.map((change) => change.resolvesItemId).sort(), ["item-session_finished:s1", "item-session_waiting:s1"]);
  for (const change of gone) assert.match(change.summary, /deleted: cleared$/);
});

test("existingItemId names the open or snoozed item that already covers a condition", () => {
  const prev = snap({ sessions: { s1: session() } });
  const next = snap({ at: T0 + 1, sessions: { s1: session({ activity: "waiting" }) } });
  const [change] = diffSnapshots(prev, next, [item("session_waiting:s1")]);
  assert.equal(change.existingItemId, "item-session_waiting:s1");
  assert.equal(change.resolvesItemId, undefined);
  assert.equal(diffSnapshots(prev, next, [item("session_waiting:s1", { status: "snoozed", snoozedUntil: T0 + DAY })])[0].existingItemId, "item-session_waiting:s1");
  // A wrong fingerprint must not match.
  assert.equal(diffSnapshots(prev, next, [item("session_waiting:other")])[0].existingItemId, null);
});

// ---------------------------------------------------------------------------------------------
// Authored pull requests: one item per PR
// ---------------------------------------------------------------------------------------------

test("an authored PR is one change whose kind is its most severe reason; it is repeated only when the reason set changes", () => {
  const key = "acme/app#7";
  const clean = snap({ pulls: keyed(pull()) });
  const failing = snap({ at: T0 + 1, pulls: keyed(pull({ checks: "failing" })) });
  const first = diffSnapshots(clean, failing, []);
  assert.deepEqual(kinds(first), ["pr_checks_failing"]);
  assert.equal(first[0].fingerprint, `pr:${key}`);
  assert.equal(first[0].summary, 'PR acme/app#7 "Add thing" needs attention: checks failing');
  assert.deepEqual(diffSnapshots(failing, { ...failing, at: T0 + 2 }, []), [], "the same reasons are not repeated");
  assert.deepEqual(diffSnapshots(failing, { ...failing, at: T0 + 2 }, [item(`pr:${key}`)]), [], "not even with an open item");

  const worse = snap({ at: T0 + 2, pulls: keyed(pull({ checks: "failing", reviewDecision: "changes_requested", mergeable: "conflicting" })) });
  const [escalated] = diffSnapshots(failing, worse, [item(`pr:${key}`)]);
  assert.equal(escalated.kind, "pr_changes_requested", "changes requested outranks failing checks");
  assert.equal(escalated.fingerprint, `pr:${key}`);
  assert.equal(escalated.existingItemId, `item-pr:${key}`);
  assert.equal(escalated.resolvesItemId, undefined);
  assert.equal(escalated.summary, 'PR acme/app#7 "Add thing" needs attention: changes requested, checks failing, merge conflicts');

  // Fewer reasons is a change too; the kind follows.
  const [reduced] = diffSnapshots(worse, snap({ at: T0 + 3, pulls: keyed(pull({ mergeable: "conflicting" })) }), []);
  assert.equal(reduced.kind, "pr_conflicts");
  assert.equal(reduced.summary, 'PR acme/app#7 "Add thing" needs attention: merge conflicts');
  // Reasons only count for the author.
  assert.deepEqual(diffSnapshots(clean, snap({ at: T0 + 1, pulls: keyed(pull({ checks: "failing", roles: ["reviewer"] })) }), []).map((c) => c.kind), ["pr_review_requested"]);
});

test("when every reason clears, the PR's item is resolved; a reason that comes back is reported again", () => {
  const key = "acme/app#7";
  const failing = snap({ pulls: keyed(pull({ checks: "failing" })) });
  const passing = snap({ at: T0 + 1, pulls: keyed(pull({ checks: "passing" })) });
  const [cleared] = diffSnapshots(failing, passing, [item(`pr:${key}`)]);
  assert.equal(cleared.kind, "pr_checks_failing", "the item's own kind");
  assert.equal(cleared.fingerprint, `pr:${key}`);
  assert.equal(cleared.resolvesItemId, `item-pr:${key}`);
  assert.match(cleared.summary, /no longer needs your attention: cleared$/);
  assert.deepEqual(diffSnapshots(failing, passing, []), [], "silent without an item");

  const again = diffSnapshots(passing, snap({ at: T0 + 2, pulls: keyed(pull({ checks: "failing" })) }), []);
  assert.deepEqual(fingerprints(again), [`pr:${key}`]);
});

test("a pull that left the set as merged or closed is reported and resolves every item on it", () => {
  const key = "acme/app#7";
  const prev = snap({ pulls: keyed(pull({ checks: "failing", mergeable: "conflicting" })) });
  // The item on #8 is newer than the previous snapshot, so the vanished-subject sweep leaves it alone.
  const open = [item(`pr:${key}`), item(`pr_conflicts:${key}`), item("pr:acme/app#8", { createdAt: T0 + 5 })];
  const merged = diffSnapshots(prev, snap({ at: T0 + 1, pulls: keyed(pull({ state: "merged" })) }), open);
  assert.deepEqual(fingerprints(merged), [`pr_merged:${key}`, `pr:${key}`, `pr_conflicts:${key}`]);
  assert.equal(merged[0].kind, "pr_merged");
  assert.equal(merged[0].resolvesItemId, undefined);
  assert.match(merged[0].summary, /was merged$/);
  assert.deepEqual(merged.slice(1).map((change) => change.resolvesItemId), [`item-pr:${key}`, `item-pr_conflicts:${key}`]);

  const closed = diffSnapshots(prev, snap({ at: T0 + 1, pulls: keyed(pull({ state: "closed" })) }), []);
  assert.deepEqual(kinds(closed), ["pr_closed"]);
  // Reported once: the refresh after, the pull is still non-open and nothing new is said.
  const after = snap({ at: T0 + 2, pulls: keyed(pull({ state: "merged" })) });
  assert.deepEqual(diffSnapshots(snap({ at: T0 + 1, pulls: keyed(pull({ state: "merged" })) }), after, []), []);
});

test("a pull that simply vanished from the search resolves its items, old per-reason ones included", () => {
  const key = "acme/app#7";
  const prev = snap({ pulls: keyed(pull({ checks: "failing" })) });
  const changes = diffSnapshots(prev, snap({ at: T0 + 1 }), [item(`pr:${key}`), item(`pr_checks_failing:${key}`)]);
  assert.deepEqual(changes.map((change) => change.resolvesItemId), [`item-pr:${key}`, `item-pr_checks_failing:${key}`]);
  for (const change of changes) assert.match(change.summary, /no longer needs your attention: cleared$/);
  assert.deepEqual(changes[0].links.pull.number, 7, "links come from the previous snapshot");
});

test("items from before the redesign (one per reason) are cleared once their reason stops applying", () => {
  const key = "acme/app#7";
  const both = snap({ pulls: keyed(pull({ checks: "failing", mergeable: "conflicting" })) });
  const fixed = snap({ at: T0 + 1, pulls: keyed(pull({ mergeable: "conflicting" })) });
  const legacy = [item(`pr_checks_failing:${key}`), item(`pr_conflicts:${key}`)];
  const changes = diffSnapshots(both, fixed, legacy);
  // The reason set changed (a new per-PR line) and the checks item is resolved; the conflicts item stays.
  assert.deepEqual(fingerprints(changes), [`pr:${key}`, `pr_checks_failing:${key}`]);
  assert.equal(changes[1].resolvesItemId, `item-pr_checks_failing:${key}`);
});

// ---------------------------------------------------------------------------------------------
// Review requests: one item per repository
// ---------------------------------------------------------------------------------------------

test("review requests are aggregated per repo with a detail list, newest first, and repeated only when the set changes", () => {
  const two = snap({ pulls: keyed(review(1), review(2), pull({ number: 9 })) });
  const [change] = diffSnapshots(null, two, []);
  assert.equal(change.kind, "pr_review_requested");
  assert.equal(change.fingerprint, "pr_review_requested:acme/app");
  assert.equal(change.summary, "2 PRs in acme/app await your review");
  assert.equal(change.detail, "- #1 Review 1 (1d)\n- #2 Review 2 (2d)");
  assert.deepEqual(change.links, { projectId: "p1" });

  // Same members, new activity on one of them: not news.
  const touched = snap({ at: T0 + 1, pulls: keyed(review(1, { updatedAt: T0 + 1 }), review(2)) });
  assert.deepEqual(diffSnapshots(two, touched, [item("pr_review_requested:acme/app")]), []);

  // A third PR joins: the existing item is named so it gets updated.
  const three = snap({ at: T0 + 2, pulls: keyed(review(1), review(2), review(3)) });
  const [grown] = diffSnapshots(two, three, [item("pr_review_requested:acme/app")]);
  assert.equal(grown.existingItemId, "item-pr_review_requested:acme/app");
  assert.equal(grown.resolvesItemId, undefined);
  assert.equal(grown.summary, "3 PRs in acme/app await your review");
  assert.equal(grown.detail.split("\n").length, 3);

  // One left: also a change, with the singular form.
  const [shrunk] = diffSnapshots(three, snap({ at: T0 + 3, pulls: keyed(review(2)) }), []);
  assert.equal(shrunk.summary, "1 PR in acme/app awaits your review");
  assert.equal(shrunk.detail, "- #2 Review 2 (2d)");
});

test("an empty review set resolves the repo item; drafts and PRs the user authored do not count", () => {
  const prev = snap({ pulls: keyed(review(1), review(2)) });
  const [cleared] = diffSnapshots(prev, snap({ at: T0 + 1, pulls: keyed(review(2, { draft: true })) }), [item("pr_review_requested:acme/app")]);
  assert.equal(cleared.resolvesItemId, "item-pr_review_requested:acme/app");
  assert.equal(cleared.fingerprint, "pr_review_requested:acme/app");
  assert.match(cleared.summary, /No PRs in acme\/app await your review: cleared$/);
  assert.deepEqual(diffSnapshots(prev, snap({ at: T0 + 1 }), []), [], "silent without an item");

  const drafts = snap({ pulls: keyed(review(1, { draft: true }), pull({ number: 5, checks: "failing" })) });
  assert.deepEqual(kinds(diffSnapshots(null, drafts, [])), ["pr_checks_failing"]);
  // A PR the user both authored and must review counts for both lines.
  const both = snap({ pulls: keyed(pull({ checks: "failing", roles: ["author", "reviewer"] })) });
  assert.deepEqual(fingerprints(diffSnapshots(null, both, [])), ["pr:acme/app#7", "pr_review_requested:acme/app"]);
});

test("the review detail lists at most 15 rows and counts the rest; per-PR review items from before are cleared", () => {
  const many = Array.from({ length: 20 }, (_, i) => review(i + 1));
  const detail = reviewDetail(many, T0);
  const rows = detail.split("\n");
  assert.equal(rows.length, REVIEW_LIST_ROWS + 1);
  assert.equal(rows[0], "- #1 Review 1 (1d)");
  assert.equal(rows.at(-1), "- +5 more");
  assert.equal(reviewDetail([review(3, { updatedAt: T0 + DAY })], T0), "- #3 Review 3 (0d)", "the future is 0d");

  const prev = snap({ pulls: keyed(review(1), review(2)) });
  const next = snap({ at: T0 + 1, pulls: keyed(review(2)) });
  const changes = diffSnapshots(prev, next, [item("pr_review_requested:acme/app#1"), item("pr_review_requested:acme/app#2")]);
  assert.deepEqual(fingerprints(changes), ["pr_review_requested:acme/app", "pr_review_requested:acme/app#1"]);
  assert.equal(changes[1].resolvesItemId, "item-pr_review_requested:acme/app#1");
});

// ---------------------------------------------------------------------------------------------
// Items whose subject vanished
// ---------------------------------------------------------------------------------------------

test("an item whose subject is in neither snapshot is resolved, unless it is newer than the previous snapshot", () => {
  const prev = snap({ at: T0, sessions: { s1: session() } });
  const next = snap({ at: T0 + 1, sessions: { s1: session() } });
  const items = [
    item("session_waiting:gone", { createdAt: T0 - 1, status: "snoozed", snoozedUntil: T0 + DAY }),
    item("pr:acme/app#42", { createdAt: T0 - 1 }),
    item("pr_review_requested:acme/old", { createdAt: T0 - 1 }),
    item("worktree_merged:w9", { createdAt: T0 - 1 }),
    item("folder_missing:p9", { createdAt: T0 - 1 }),
    item("session_waiting:s1", { createdAt: T0 - 1 }),
    item("session_waiting:fresh", { createdAt: T0 + 1 }),
    item("custom:anything", { createdAt: T0 - 1 }),
    item("watch_update:w", { createdAt: T0 - 1 }),
    item("pr_merged:acme/app#3", { createdAt: T0 - 1 }),
    item("pr_closed:acme/app#4", { createdAt: T0 - 1 }),
  ];
  const changes = diffSnapshots(prev, next, items);
  assert.deepEqual(changes.map((change) => change.resolvesItemId).sort(), [
    "item-folder_missing:p9", "item-pr:acme/app#42", "item-pr_review_requested:acme/old", "item-session_waiting:gone", "item-session_waiting:s1", "item-worktree_merged:w9",
  ].sort());
  const gone = changes.find((change) => change.fingerprint === "session_waiting:gone");
  assert.match(gone.summary, /gone is gone\): cleared$/);
  // s1 is present: its waiting item is resolved by the ordinary rule (not waiting), not by the sweep.
  assert.match(changes.find((change) => change.fingerprint === "session_waiting:s1").summary, /no longer waiting/);
  assert.deepEqual(diffSnapshots(null, next, items.slice(0, 1)), [], "no previous snapshot, no sweep");
});

// ---------------------------------------------------------------------------------------------
// Worktrees and folders
// ---------------------------------------------------------------------------------------------

test("a worktree whose branch got merged is reported once and resolved when it is not merged any more", () => {
  const prev = snap({ worktrees: { w1: { branch: "feat", merged: false, dirty: false, parentId: "p1" } } });
  const merged = snap({ at: T0 + 1, worktrees: { w1: { branch: "feat", merged: true, dirty: false, parentId: "p1" } } });
  const changes = diffSnapshots(prev, merged, []);
  assert.deepEqual(kinds(changes), ["worktree_merged"]);
  assert.equal(changes[0].fingerprint, "worktree_merged:w1");
  assert.deepEqual(changes[0].links, { projectId: "w1" });
  assert.deepEqual(diffSnapshots(merged, { ...merged, at: T0 + 2 }, []), []);
  const [back] = diffSnapshots(merged, { ...prev, at: T0 + 3 }, [item("worktree_merged:w1")]);
  assert.equal(back.resolvesItemId, "item-worktree_merged:w1");
});

test("a branch just created off the default branch is not suggested for removal while someone works in it", () => {
  // Such a branch is an ancestor of the default branch too, so `merged` is true from its first minute.
  const fresh = { branch: "new", merged: true, dirty: false, parentId: "p1" };
  const active = snap({ worktrees: { w1: fresh }, sessions: { s1: session({ projectId: "w1", lastActiveAt: T0 - 60_000 }) } });
  assert.deepEqual(diffSnapshots(null, active, []), []);
  const idle = snap({ at: T0 + DIRTY_IDLE_MS, worktrees: { w1: fresh }, sessions: { s1: session({ projectId: "w1", lastActiveAt: T0 - 60_000 }) } });
  assert.deepEqual(kinds(diffSnapshots(active, idle, [])), ["worktree_merged"]);
  const dirty = snap({ at: T0 + DIRTY_IDLE_MS, worktrees: { w1: { ...fresh, dirty: true } } });
  assert.ok(!kinds(diffSnapshots(active, dirty, [])).includes("worktree_merged"), "uncommitted work is never suggested for removal");
});

test("a dirty worktree is reported once no session touched it for 24 h, and only once", () => {
  const dirty = { branch: "feat", merged: false, dirty: true, parentId: "p1" };
  const recent = snap({ worktrees: { w1: dirty }, sessions: { s1: session({ projectId: "w1", lastActiveAt: T0 - 60_000 }) } });
  assert.deepEqual(diffSnapshots(null, recent, []), [], "a session was active in the worktree");

  const stale = snap({ at: T0 + DIRTY_IDLE_MS, worktrees: { w1: dirty }, sessions: { s1: session({ projectId: "w1", lastActiveAt: T0 - 60_000 }) } });
  const changes = diffSnapshots(recent, stale, []);
  assert.deepEqual(kinds(changes), ["worktree_dirty"]);
  assert.equal(changes[0].fingerprint, "worktree_dirty:w1");
  assert.deepEqual(diffSnapshots(stale, { ...stale, at: stale.at + 1 }, []), [], "not repeated while it stays dirty and idle");

  const clean = snap({ at: stale.at + 2, worktrees: { w1: { ...dirty, dirty: false } }, sessions: stale.sessions });
  const [cleared] = diffSnapshots(stale, clean, [item("worktree_dirty:w1")]);
  assert.equal(cleared.resolvesItemId, "item-worktree_dirty:w1");
});

test("a removed worktree project resolves its items", () => {
  const prev = snap({ worktrees: { w1: { branch: "feat", merged: true, dirty: false, parentId: "p1" } } });
  const [cleared] = diffSnapshots(prev, snap({ at: T0 + 1 }), [item("worktree_merged:w1")]);
  assert.equal(cleared.resolvesItemId, "item-worktree_merged:w1");
  assert.match(cleared.summary, /removed: cleared$/);
});

test("a project folder that went missing is reported once and resolved when it is back", () => {
  const fine = snap();
  const missing = snap({ at: T0 + 1, missingProjects: ["p1"] });
  const changes = diffSnapshots(fine, missing, []);
  assert.deepEqual(kinds(changes), ["folder_missing"]);
  assert.equal(changes[0].fingerprint, "folder_missing:p1");
  assert.deepEqual(diffSnapshots(missing, { ...missing, at: T0 + 2 }, []), []);
  const [back] = diffSnapshots(missing, { ...fine, at: T0 + 3 }, [item("folder_missing:p1")]);
  assert.equal(back.resolvesItemId, "item-folder_missing:p1");
});

test("changes come out in a stable order: sessions, authored PRs, review repos, worktrees, folders, each sorted by key", () => {
  const next = snap({
    sessions: { b: session({ activity: "waiting" }), a: session({ activity: "waiting" }) },
    pulls: keyed(pull({ number: 9, checks: "failing" }), pull({ number: 2, checks: "failing" }), review(4, { repo: "zed/z" }), review(3, { repo: "acme/web" })),
    worktrees: { w: { branch: "x", merged: true, dirty: false, parentId: null } },
    missingProjects: ["z", "y"],
  });
  assert.deepEqual(fingerprints(diffSnapshots(null, next, [])), [
    "session_waiting:a", "session_waiting:b", "pr:acme/app#2", "pr:acme/app#9", "pr_review_requested:acme/web", "pr_review_requested:zed/z",
    "worktree_merged:w", "folder_missing:y", "folder_missing:z",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------------------------

test("collectSnapshot records sessions with their link, attaches local projects to pulls, and asks the search for recent PRs only", async () => {
  resetDigestCaches();
  const { deps, state } = fakeDeps({
    sessions: [sessionMeta(), sessionMeta({ id: "s2", link: { status: "offline", error: null } })],
    projects: [project()],
    pulls: [pull({ localProjectId: null }), pull({ number: 8, updatedAt: T0 - STALE_PULL_MS - 1 })],
    originUrl: async () => "git@github.com:acme/app.git",
  });
  const log = [];
  const snapshot = await collectSnapshot({ deps, previous: null, now: T0, log });
  assert.deepEqual(snapshot.sessions.s1, { activity: "idle", lastActiveAt: T0 - 30_000, title: "Fix the login bug", projectId: "p1", link: "live" });
  assert.equal(snapshot.sessions.s2.activity, "idle", "quietly offline reads as idle");
  assert.equal(snapshot.sessions.s2.link, "offline");
  assert.deepEqual(Object.keys(snapshot.pulls), ["acme/app#7"], "the stale PR is left out");
  assert.equal(snapshot.pulls["acme/app#7"].localProjectId, "p1");
  assert.deepEqual(state.searches, [{ updatedSince: T0 - STALE_PULL_MS }]);
  assert.deepEqual(log, ["Skipped 1 pull request untouched for over 14 days."]);
});

test("collectSnapshot keeps the previous slice of every source that fails and says so", async () => {
  resetDigestCaches();
  const previous = snap({
    at: T0 - 1000,
    sessions: { old: session() },
    pulls: keyed(pull({ number: 1 })),
    worktrees: { w1: { branch: "kept", merged: false, dirty: true, parentId: "p1" } },
    missingProjects: ["m1"],
  });
  const boom = async () => { throw new Error("boom"); };

  // Sessions and projects unreadable: their previous slices stand, pulls are still searched.
  const broken = fakeDeps({ pulls: [attentionPull({ number: 2 })] });
  broken.deps.sessions.list = boom;
  broken.deps.projects.list = boom;
  let log = [];
  let snapshot = await collectSnapshot({ deps: broken.deps, previous, now: T0, log });
  assert.deepEqual(snapshot.sessions, previous.sessions);
  assert.deepEqual(snapshot.worktrees, previous.worktrees);
  assert.deepEqual(snapshot.missingProjects, ["m1"]);
  assert.deepEqual(Object.keys(snapshot.pulls), ["acme/app#2"]);
  assert.equal(snapshot.pulls["acme/app#2"].localProjectId, null, "no projects to attach");
  assert.match(log[0], /Sessions could not be listed \(boom\)/);
  assert.match(log[1], /Projects could not be listed \(boom\)/);
  assert.match(log[2], /acme\/app#1 left the attention list; its state could not be read/);

  // The search reports an error, or throws: previous pulls stand.
  for (const github of [{ searchAttentionPulls: async () => ({ pulls: [], error: "rate limited" }) }, { searchAttentionPulls: boom }]) {
    log = [];
    snapshot = await collectSnapshot({ deps: fakeDeps({ github }).deps, previous, now: T0, log });
    assert.deepEqual(snapshot.pulls, previous.pulls);
    assert.match(log[0], /GitHub search failed \((rate limited|boom)\); kept the previous pull requests/);
  }

  // A warning and a cut-short search are logged but the pulls are used.
  log = [];
  const partial = fakeDeps({ github: { searchAttentionPulls: async () => ({ pulls: [pull()], error: null, warning: "page 2 failed", truncated: true, total: { authored: 120, requested: 3 } }) } });
  snapshot = await collectSnapshot({ deps: partial.deps, previous: null, now: T0, log });
  assert.deepEqual(Object.keys(snapshot.pulls), ["acme/app#7"]);
  assert.deepEqual(log, ["GitHub search warning: page 2 failed", "GitHub search was cut short; not every matching PR was fetched (120 authored, 3 requested in all)."]);

  // A previously open PR that left the search is carried once with its final state.
  log = [];
  const merged = fakeDeps({ github: { pullState: async () => "merged" } });
  snapshot = await collectSnapshot({ deps: merged.deps, previous, now: T0, log });
  assert.equal(snapshot.pulls["acme/app#1"].state, "merged");
  const stillOpen = fakeDeps({ github: { pullState: async () => "open" } });
  log = [];
  snapshot = await collectSnapshot({ deps: stillOpen.deps, previous, now: T0, log });
  assert.equal(snapshot.pulls["acme/app#1"], undefined);
  assert.match(log[0], /left the attention list while still open/);

  // A worktree that cannot be read keeps its previous entry; a project that cannot be checked keeps its missing flag.
  const worktree = project({ id: "w1", name: "kept", path: "/wt", worktree: { parentId: "p1", branch: "kept" } });
  const flaky = fakeDeps({ projects: [project(), worktree, project({ id: "m1", name: "m", path: "/m" })], worktreeState: boom });
  flaky.deps.projects.summarize = async (entry) => {
    if (entry.id === "m1") throw new Error("stat failed");
    return { ...entry, exists: true, git: null, displayPath: entry.path };
  };
  log = [];
  snapshot = await collectSnapshot({ deps: flaky.deps, previous, now: T0, log });
  assert.deepEqual(snapshot.worktrees, previous.worktrees);
  assert.deepEqual(snapshot.missingProjects, ["m1"]);
  assert.ok(log.some((line) => /Worktree kept could not be read \(boom\)/.test(line)), log.join("\n"));
  assert.ok(log.some((line) => /Project m could not be checked \(stat failed\)/.test(line)), log.join("\n"));
  // Without a previous snapshot the failing sources are simply empty.
  snapshot = await collectSnapshot({ deps: flaky.deps, previous: null, now: T0, log: [] });
  assert.deepEqual(snapshot.worktrees, {});
  assert.deepEqual(snapshot.missingProjects, []);
});

// ---------------------------------------------------------------------------------------------
// Activity, digest, helpers
// ---------------------------------------------------------------------------------------------

test("snapshotActivity treats a quietly offline session as idle and a lost agent as an error", () => {
  const base = { busy: false, awaitingPermission: false };
  assert.equal(snapshotActivity({ ...base, link: { status: "offline", error: null } }), "idle");
  assert.equal(snapshotActivity({ ...base, link: { status: "offline", error: "process exited" } }), "error");
  assert.equal(snapshotActivity({ ...base, busy: true, link: { status: "live" } }), "working");
  assert.equal(snapshotActivity({ ...base, awaitingPermission: true, link: { status: "live" } }), "waiting");
  assert.equal(snapshotActivity({ ...base, link: { status: "connecting" } }), "connecting");
});

test("the diff sees snoozed items too: a snoozed item whose condition cleared is named for resolving", async () => {
  const store = createMemoryOrchestratorStore();
  const base = { kind: "custom", title: "t", body: "", links: {}, actions: [] };
  const snoozedWaiting = await store.createItem({ ...base, kind: "session_waiting", fingerprint: "session_waiting:s2", status: "snoozed", snoozedUntil: T0 + 60_000 });
  const prev = snap({ sessions: { s1: session(), s2: session({ activity: "waiting" }) } });
  const snapshot = snap({ at: T0, sessions: { s1: session({ activity: "waiting" }), s2: session() } });
  const changes = diffSnapshots(prev, snapshot, await store.listItems());
  assert.deepEqual(fingerprints(changes), ["session_waiting:s1", "session_waiting:s2"]);
  assert.equal(changes[1].resolvesItemId, snoozedWaiting.id);
});

test("a dismissed item keeps its condition quiet until it clears, then is released", async () => {
  const store = createMemoryOrchestratorStore();
  const base = { title: "t", body: "", links: {}, actions: [] };
  // The user dismissed the review list for acme/app; a new PR joining it must not bring it back.
  const dismissed = await store.createItem({ ...base, kind: "pr_review_requested", fingerprint: "pr_review_requested:acme/app", status: "dismissed" });
  const one = { "acme/app#1": review(1) };
  const two = { ...one, "acme/app#2": review(2) };
  const growing = { released: [], suppressed: [] };
  assert.deepEqual(diffSnapshots(snap({ at: T0 - 1, pulls: one }), snap({ at: T0, pulls: two }), await store.listItems(), growing), []);
  assert.deepEqual(growing.suppressed, ["pr_review_requested:acme/app"]);
  assert.deepEqual(growing.released, []);
  // Every review done: the condition cleared, so the dismissal has done its job.
  const cleared = { released: [], suppressed: [] };
  assert.deepEqual(diffSnapshots(snap({ at: T0 - 1, pulls: two }), snap({ at: T0, pulls: {} }), await store.listItems(), cleared), []);
  assert.deepEqual(cleared.released, [dismissed.id]);
  // A dismissed item whose subject is gone from both snapshots is released too.
  const gone = await store.createItem({ ...base, kind: "worktree_dirty", fingerprint: "worktree_dirty:w9", status: "dismissed" });
  const later = diffSnapshots(snap({ at: T0 - 1 }), snap({ at: T0 }), [{ ...gone, createdAt: T0 - 10 }], { released: [], suppressed: [] });
  assert.deepEqual(later, []);
  const outcome = { released: [], suppressed: [] };
  diffSnapshots(snap({ at: T0 - 1 }), snap({ at: T0 }), [{ ...gone, createdAt: T0 - 10 }], outcome);
  assert.deepEqual(outcome.released, [gone.id]);
});

test("a session too short for any refresh to see it working still counts as finished", () => {
  const prev = snap({ at: T0 - 600_000, sessions: {} });
  const quick = session({ lastActiveAt: T0 - 300_000, title: "Review acme/app#7" });
  assert.deepEqual(fingerprints(diffSnapshots(prev, snap({ sessions: { s9: quick } }), [])), ["session_finished:s9"]);
  // Not when it never got a prompt, is still connecting, lost its agent, or was already there before.
  assert.deepEqual(diffSnapshots(prev, snap({ sessions: { s9: { ...quick, title: null } } }), []), []);
  assert.deepEqual(diffSnapshots(prev, snap({ sessions: { s9: { ...quick, link: "connecting" } } }), []), []);
  assert.deepEqual(diffSnapshots(prev, snap({ sessions: { s9: { ...quick, lastActiveAt: prev.at - 1 } } }), []), []);
  assert.deepEqual(diffSnapshots(null, snap({ sessions: { s9: quick } }), []), [], "the first snapshot reports conditions, not transitions");
});
