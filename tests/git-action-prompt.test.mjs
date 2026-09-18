import assert from "node:assert/strict";
import test from "node:test";
import { buildGitActionPrompt, gitActionAvailable } from "../src/lib/git-action-prompt.ts";

/** A GithubSummary for branch "feat" with no PR and a clean merge against main, overridable per field. */
const summary = (overrides = {}) => ({
  branch: "feat",
  detached: false,
  defaultBranch: "main",
  upstream: "origin/feat",
  ahead: 0,
  behind: 0,
  fetchedAt: null,
  fetchError: null,
  repoUrl: "https://github.com/o/r",
  logBase: "origin/main",
  commits: [],
  cursor: null,
  pull: null,
  pullError: null,
  conflicts: { status: "clean", base: "main", source: "local" },
  at: 0,
  ...overrides,
});

/** PR #42 from feat into release with no checks, no review decision, and zero counts. */
const pull = (overrides = {}) => ({
  number: 42,
  title: "Add the panel",
  author: "moses",
  url: "https://github.com/o/r/pull/42",
  state: "open",
  draft: false,
  baseBranch: "release",
  headSha: "abc",
  reviewDecision: null,
  unresolvedThreads: 0,
  comments: 0,
  checks: null,
  mergeable: "mergeable",
  ...overrides,
});

const failingChecks = {
  state: "failing", passing: 1, failing: 2, pending: 0,
  checks: [
    { name: "lint", state: "passing", url: "https://ci/lint" },
    { name: "test", state: "failing", url: "https://ci/test" },
    { name: "deploy/preview", state: "failing", url: null },
  ],
};

const conflicting = (files) => ({ status: "conflicts", base: "main", source: "local", files });

test("checks is available only when the PR's checks are failing", () => {
  assert.equal(gitActionAvailable("checks", summary({ pull: pull({ checks: failingChecks }) })), true);
  assert.equal(gitActionAvailable("checks", summary({ pull: pull({ checks: { ...failingChecks, state: "pending" } }) })), false);
  assert.equal(gitActionAvailable("checks", summary({ pull: pull({ checks: { ...failingChecks, state: "passing" } }) })), false);
  assert.equal(gitActionAvailable("checks", summary({ pull: pull({ checks: null }) })), false, "a PR without checks");
  assert.equal(gitActionAvailable("checks", summary()), false, "no PR");
});

test("conflicts is available from the local merge check, PR or not", () => {
  assert.equal(gitActionAvailable("conflicts", summary({ conflicts: conflicting(["a.txt"]) })), true);
  assert.equal(gitActionAvailable("conflicts", summary({ conflicts: { status: "conflicts", base: "main", source: "github", files: [] } })), true);
  assert.equal(gitActionAvailable("conflicts", summary({ pull: pull(), conflicts: conflicting(["a.txt"]) })), true);
  assert.equal(gitActionAvailable("conflicts", summary()), false, "clean");
  assert.equal(gitActionAvailable("conflicts", summary({ conflicts: { status: "unknown", base: "main", reason: "no origin/main" } })), false);
  assert.equal(gitActionAvailable("conflicts", summary({ branch: null, detached: true, conflicts: null })), false, "detached HEAD");
});

test("review is available with unresolved threads, changes requested, or comments", () => {
  assert.equal(gitActionAvailable("review", summary()), false, "no PR");
  assert.equal(gitActionAvailable("review", summary({ pull: pull() })), false, "nothing to review");
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ unresolvedThreads: 1 }) })), true);
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ comments: 2 }) })), true);
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ reviewDecision: "changes_requested" }) })), true);
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ reviewDecision: "approved" }) })), false);
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ reviewDecision: "review_required" }) })), false);
  const unknownCounts = { unresolvedThreads: null, comments: null };
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ ...unknownCounts, reviewDecision: "changes_requested" }) })), true);
  assert.equal(gitActionAvailable("review", summary({ pull: pull({ ...unknownCounts, reviewDecision: "review_required" }) })), false);
  assert.equal(gitActionAvailable("review", summary({ pull: pull(unknownCounts) })), false);
});

test("checks prompt lists the failing checks with their URLs, omitting a missing URL", () => {
  const s = summary({ pull: pull({ checks: failingChecks }) });
  assert.equal(buildGitActionPrompt("checks", s, "Fix the failing CI checks."), [
    "Fix the failing CI checks.",
    "",
    "PR #42: https://github.com/o/r/pull/42 (base: release, head: feat)",
    "Failing checks:",
    "- test: https://ci/test",
    "- deploy/preview",
  ].join("\n"));
});

test("conflicts prompt names the PR base and the conflicting files", () => {
  const s = summary({ pull: pull(), conflicts: conflicting(["src/a.ts", "README.md"]) });
  assert.equal(buildGitActionPrompt("conflicts", s, "Resolve the merge conflicts."), [
    "Resolve the merge conflicts.",
    "",
    "PR #42: https://github.com/o/r/pull/42 (base: release, head: feat)",
    "Conflicting files:",
    "- src/a.ts",
    "- README.md",
  ].join("\n"));
});

test("conflicts prompt without a PR names the branch and the base it conflicts with", () => {
  const s = summary({ conflicts: conflicting(["a.txt"]) });
  assert.equal(buildGitActionPrompt("conflicts", s, "Resolve the merge conflicts."), [
    "Resolve the merge conflicts.",
    "",
    "Branch: feat",
    "Conflicts with base: main",
    "Conflicting files:",
    "- a.txt",
  ].join("\n"));
});

test("conflicts prompt says so when GitHub reported conflicts without listing files", () => {
  const s = summary({ pull: pull(), conflicts: { status: "conflicts", base: "release", source: "github", files: [] } });
  assert.equal(buildGitActionPrompt("conflicts", s, "Resolve the merge conflicts."), [
    "Resolve the merge conflicts.",
    "",
    "PR #42: https://github.com/o/r/pull/42 (base: release, head: feat)",
    "GitHub reported conflicts but did not list the files.",
  ].join("\n"));
});

test("review prompt summarises the decision and counts with correct plurals", () => {
  const build = (overrides) => buildGitActionPrompt("review", summary({ pull: pull(overrides) }), "Address the review.");
  const header = "Address the review.\n\nPR #42: https://github.com/o/r/pull/42 (base: release, head: feat)\n";
  assert.equal(build({ reviewDecision: "changes_requested", unresolvedThreads: 3, comments: 1 }), `${header}Review: changes requested, 3 unresolved threads, 1 comment`);
  assert.equal(build({ reviewDecision: "approved", unresolvedThreads: 1, comments: 0 }), `${header}Review: approved, 1 unresolved thread, 0 comments`);
  assert.equal(build({ reviewDecision: "review_required", unresolvedThreads: 0, comments: 2 }), `${header}Review: review required, 0 unresolved threads, 2 comments`);
  assert.equal(build({ reviewDecision: null, unresolvedThreads: null, comments: null }), `${header}Review: no review decision, unknown unresolved threads, unknown comments`);
});

test("an empty or whitespace prompt yields just the context block", () => {
  const s = summary({ pull: pull({ checks: failingChecks }) });
  const context = [
    "PR #42: https://github.com/o/r/pull/42 (base: release, head: feat)",
    "Failing checks:",
    "- test: https://ci/test",
    "- deploy/preview",
  ].join("\n");
  assert.equal(buildGitActionPrompt("checks", s, ""), context);
  assert.equal(buildGitActionPrompt("checks", s, "  \n\t"), context);
  assert.equal(buildGitActionPrompt("checks", s, "  Fix CI.\n\n"), `Fix CI.\n\n${context}`, "the prompt is trimmed");
});
