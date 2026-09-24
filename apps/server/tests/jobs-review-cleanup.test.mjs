import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REVIEW_CHECK_MS } from "../src/orchestrator/jobs/review-watch.ts";
import { project, sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { flush, jobsHarness, started } from "./fixtures/jobs-harness.mjs";

const url = (n) => `https://github.com/acme/app/pull/${n}`;

/** A parent project and a review worktree project, both on real folders so the removal reaches git. */
function projects() {
  const root = mkdtempSync(path.join(os.tmpdir(), "portal-review-cleanup-"));
  const parent = project({ id: "p1", name: "app", path: path.join(root, "app") });
  const worktree = project({ id: "p2", name: "feature-x", path: path.join(root, "wt", "feature-x"), worktree: { parentId: "p1", branch: "feature-x" } });
  return { root, parent, worktree };
}

async function harness(t, { sessions, worktreeCreated = true, git = {} } = {}) {
  const { parent, worktree } = projects();
  for (const dir of [parent.path, worktree.path]) (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const h = await started(jobsHarness(t, { sessions: sessions ?? [sessionMeta({ id: "s1", projectId: "p2", busy: false })], projects: [parent, worktree] }));
  const removals = [];
  h.deps.git.removeWorktree = async (opts) => {
    removals.push(opts);
    return { branchDeleted: opts.deleteBranch === "pushed" };
  };
  Object.assign(h.deps.git, git);
  const { intent } = await h.jobs.createIntent({
    text: "Review PR 1 on acme/app", trigger: "The review session finished.", action: "Summarize.",
    scope: { sessionIds: ["s1"], pulls: [{ repo: "acme/app", number: 1, url: url(1) }], repos: ["acme/app"] },
    fireBudget: 1, check: { type: "every", everyMs: REVIEW_CHECK_MS },
    checkPayload: { review: { repo: "acme/app", sessions: [{ pr: 1, url: url(1), sessionId: "s1", projectId: "p2", worktreeCreated }] } },
  }, { actor: "agent", runId: "run1", threadId: "main" });
  const item = await h.store.createItem({
    kind: "review_findings", title: "Review of acme/app#1: looks good", body: "Fine.", fingerprint: "review_findings:acme/app#1:s1",
    links: { pull: { repo: "acme/app", number: 1, url: url(1) }, sessionId: "s1", projectId: "p2", intentId: intent.id },
    actions: [],
  });
  return { h, item, removals, worktree };
}

test("settling a findings item removes the review worktree Portal created, deletes a branch that is on origin, and says so in the thread", async (t) => {
  const { h, item, removals } = await harness(t);
  await h.runtime.updateItem(item.id, { status: "resolved" });
  await flush();
  assert.equal(removals.length, 1);
  assert.equal(removals[0].branch, "feature-x");
  assert.equal(removals[0].deleteBranch, "pushed");
  assert.equal(removals[0].force, false, "never forced: a dirty worktree is left to the user");
  assert.deepEqual(h.state.removed.map((entry) => entry.id), ["p2"]);
  assert.equal(h.state.removed[0].keep, true, "the review session still exists, so the project stays restorable");
  const note = (await h.store.readMessages("main")).at(-1);
  assert.equal(note.parts[0].text, "Removed the review worktree for acme/app#1 and its local branch feature-x, now that its findings are read.");
  const [entry] = await h.hub.activity.list({ kind: "review.worktree_removed" });
  assert.deepEqual(entry.refs, { projectId: "p2", itemId: item.id, sessionId: "s1", intentId: item.links.intentId });
  assert.equal((await h.store.listItems()).filter((row) => row.kind === "worktree_dirty").length, 0);
});

test("dismissing counts as read too, and a branch with local commits stays with a note", async (t) => {
  const { h, item, removals } = await harness(t);
  h.deps.git.removeWorktree = async (opts) => {
    removals.push(opts);
    return { branchDeleted: false };
  };
  await h.runtime.updateItem(item.id, { status: "dismissed" });
  await flush();
  assert.equal(removals.length, 1);
  const note = (await h.store.readMessages("main")).at(-1);
  assert.match(note.parts[0].text, /^Removed the review worktree for acme\/app#1, now that its findings are read; the local branch feature-x stays/);
});

test("a dirty worktree, or one a session still works in, is kept with a Needs-you item carrying the Remove worktree action", async (t) => {
  const dirty = await harness(t, { git: { worktreeState: async () => ({ exists: true, merged: false, dirty: true }) } });
  await dirty.h.runtime.updateItem(dirty.item.id, { status: "resolved" });
  await flush();
  assert.equal(dirty.removals.length, 0);
  assert.deepEqual(dirty.h.state.removed, []);
  const kept = (await dirty.h.store.listItems()).find((row) => row.kind === "worktree_dirty");
  assert.equal(kept.title, "The review worktree for acme/app#1 was kept");
  assert.match(kept.body, /^It has uncommitted changes\./);
  assert.deepEqual(kept.actions, [{ type: "remove_worktree", projectId: "p2", label: "Remove worktree" }, { type: "open_session", sessionId: "s1", label: "Open review" }]);
  assert.equal(kept.fingerprint, "review_worktree:p2");
  assert.equal((await dirty.h.hub.activity.list({ kind: "review.worktree_kept" })).length, 1);

  const busy = await harness(t, { sessions: [sessionMeta({ id: "s1", projectId: "p2", busy: true })] });
  await busy.h.runtime.updateItem(busy.item.id, { status: "resolved" });
  await flush();
  assert.equal(busy.removals.length, 0);
  assert.match((await busy.h.store.listItems()).find((row) => row.kind === "worktree_dirty").body, /^A session is still working in it\./);
});

test("a worktree the review did not create, and a findings item of another kind, are left alone", async (t) => {
  const { h, item, removals } = await harness(t, { worktreeCreated: false });
  await h.runtime.updateItem(item.id, { status: "resolved" });
  await flush();
  assert.equal(removals.length, 0);
  assert.deepEqual(h.state.removed, []);
  assert.equal((await h.store.readMessages("main")).length, 0);
  const other = await h.store.createItem({ kind: "session_finished", title: "Done", body: "", fingerprint: "session_finished:s1", links: { sessionId: "s1", projectId: "p2" }, actions: [] });
  await h.runtime.updateItem(other.id, { status: "resolved" });
  await flush();
  assert.equal(removals.length, 0);
});
