import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_CHECK_MS } from "../src/orchestrator/jobs/review-watch.ts";
import { adviseReadOnly, commandOf } from "../src/orchestrator/jobs/review-permissions.ts";
import { sessionMeta } from "./fixtures/orchestrator-fakes.mjs";
import { jobsHarness, started } from "./fixtures/jobs-harness.mjs";

const options = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-always", name: "Yes, always", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
const execute = (command) => ({ kind: "execute", title: command, rawInput: { command } });

test("adviseReadOnly allows reads, searches, and shell commands the checker vouches for, always once", () => {
  assert.deepEqual(adviseReadOnly({ kind: "read", title: "Read src/auth.ts" }, options), { optionId: "allow-once", reason: "Portal allowed this read step of the review: it only reads." });
  assert.equal(adviseReadOnly({ kind: "search", title: "Grep" }, options).optionId, "allow-once");
  const readOnly = execute("cd /Users/moses/.portal/worktrees/monorepo/pr && git status -sb | head -5 && git log --oneline -3 && gh pr view 2275 --json state");
  assert.deepEqual(adviseReadOnly(readOnly, options), { optionId: "allow-once", reason: "Portal allowed this command of the review: it only reads." });
  assert.equal(adviseReadOnly(execute("rg -n 'linger' tests/ | head -20"), options).optionId, "allow-once");
  // Writes, network, unknown commands, and anything the parser cannot vouch for wait for the user.
  assert.equal(adviseReadOnly(execute("gh api -X POST repos/acme/app/pulls/1/reviews --input review.json"), options), null);
  assert.equal(adviseReadOnly(execute("git fetch origin feature && git log"), options), null);
  assert.equal(adviseReadOnly(execute("python3 review_payload.py"), options), null);
  assert.equal(adviseReadOnly(execute("cat $(find . -name x)"), options), null);
  assert.equal(adviseReadOnly({ kind: "edit", title: "Edit src/auth.ts", rawInput: { path: "src/auth.ts" } }, options), null);
  assert.equal(adviseReadOnly({ kind: "fetch", title: "Fetch https://example.com" }, options), null);
  assert.equal(adviseReadOnly({ kind: "execute", title: "Run", rawInput: {} }, options), null, "no command to judge");
  // Without an "allow once" option there is nothing safe to pick.
  assert.equal(adviseReadOnly({ kind: "read", title: "Read" }, options.filter((option) => option.kind !== "allow_once")), null);
  assert.equal(adviseReadOnly({ kind: "read", title: "Read" }, []), null);
});

test("commandOf reads Claude Code's string and Codex's argv, unwrapping a shell -c", () => {
  assert.equal(commandOf(execute(" git status ")), "git status");
  assert.equal(commandOf({ kind: "execute", rawInput: { command: ["bash", "-lc", "git diff --stat"] } }), "git diff --stat");
  assert.equal(commandOf({ kind: "execute", rawInput: { command: ["/bin/zsh", "-c", "ls -la"] } }), "ls -la");
  assert.equal(commandOf({ kind: "execute", rawInput: { command: ["git", "status"] } }), "git status");
  assert.equal(commandOf({ kind: "read", rawInput: { command: "git status" } }), null);
  assert.equal(commandOf({ kind: "execute", rawInput: "git status" }), null);
  assert.equal(commandOf({ kind: "execute", rawInput: { command: 7 } }), null);
});

const url = (n) => `https://github.com/acme/app/pull/${n}`;
async function reviewGoal(h, review = {}) {
  return h.jobs.createIntent({
    text: "Review PR 1 on acme/app", trigger: "The review session finished.", action: "Summarize.",
    scope: { sessionIds: ["s1"], pulls: [{ repo: "acme/app", number: 1, url: url(1) }], repos: ["acme/app"] },
    fireBudget: 1, check: { type: "every", everyMs: REVIEW_CHECK_MS },
    checkPayload: { review: { repo: "acme/app", sessions: [{ pr: 1, url: url(1), sessionId: "s1", projectId: "p2" }], ...review } },
  }, { actor: "agent", runId: "run1", threadId: "main" });
}
const request = (sessionId, command) => ({ sessionId, requestId: `req-${command}`, toolCall: execute(command), options });

test("the installed advisor answers only for sessions of an active review goal, honours the setting and the goal's opt-out, and logs each answer", async (t) => {
  const h = await started(jobsHarness(t, { sessions: [sessionMeta({ id: "s1", projectId: "p2", busy: true }), sessionMeta({ id: "s2", projectId: "p1", busy: true })] }));
  const advisor = h.state.permissionAdvisor;
  assert.equal(typeof advisor, "function", "the runtime installs the advisor on the sessions service");
  assert.equal(await advisor(request("s1", "git status")), null, "no review goal covers s1 yet");

  const { intent } = await reviewGoal(h);
  assert.deepEqual(await advisor(request("s1", "git status")), { optionId: "allow-once", reason: "Portal allowed this command of the review: it only reads." });
  assert.equal(await advisor(request("s1", "git push")), null, "a write waits for the user");
  assert.equal(await advisor(request("s2", "git status")), null, "a session outside any review goal is the user's to answer");
  const entries = await h.hub.activity.list({ kind: "session.permission_answered" });
  assert.equal(entries.length, 1);
  assert.match(entries[0].summary, /^Allowed a read-only step of the review of acme\/app#1: git status/);
  assert.deepEqual(entries[0].refs, { sessionId: "s1", intentId: intent.id });
  assert.equal(entries[0].detail.command, "git status");

  // The setting turns it off for every review; the goal's own opt-out for that goal.
  await h.settings.change({ reviews: { answerReadOnly: false } });
  assert.equal(await advisor(request("s1", "git status")), null);
  await h.settings.change({ reviews: { answerReadOnly: true } });
  assert.notEqual(await advisor(request("s1", "git status")), null);
  await h.jobs.updateIntent(intent.id, { status: "cancelled" }, "user");
  assert.equal(await advisor(request("s1", "git status")), null, "a cancelled goal answers nothing");

  const quiet = await reviewGoal(h, { answerPermissions: false });
  assert.equal(quiet.intent.status, "active");
  assert.equal(await advisor(request("s1", "git status")), null, "the goal asked to leave every request to the user");
});
