import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchRepo, githubRepoUrl, pullFastForward, readCommitPage, readGithubSummary, redactCredentials, resetGithubSummaryCaches,
} from "../src/lib/github-summary.ts";
import { WorktreeError } from "../src/lib/worktrees.ts";

// The module under test inherits process.env, so isolate it from the developer's git config too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd, args, env = {}) {
  return execFileSync("git", args, {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...identity, ...env },
  }).toString().trim();
}

/** Commit at a fixed second so ordering by committer date is deterministic. */
function commit(cwd, message, seconds) {
  const date = `@${seconds} +0000`;
  git(cwd, ["commit", "-q", "--allow-empty", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Write a file and commit it at a fixed second. */
function commitFile(cwd, file, content, message, seconds) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, ["add", file]);
  return commit(cwd, message, seconds);
}

function tempRoot(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-gh-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A bare "origin" cloned into "main" (so origin/HEAD exists) whose main branch has `a.txt`, plus a
 * second clone "other" for advancing origin behind main's back.
 */
function fixture(t) {
  const root = tempRoot(t);
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  git(root, ["init", "-q", "-b", "main", seed]);
  const init = commitFile(seed, "a.txt", "one\n", "init", 1_000_000);
  git(root, ["init", "-q", "--bare", origin]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
  const main = path.join(root, "main");
  git(root, ["clone", "-q", origin, main]);
  const other = path.join(root, "other");
  git(root, ["clone", "-q", origin, other]);
  return { root, origin, main, other, init };
}

/** Check out a new `feat` branch in `main` with two pushed commits and one local-only commit. */
function featureBranch({ main }) {
  git(main, ["checkout", "-q", "-b", "feat"]);
  const c1 = commit(main, "feat one", 1_000_100);
  const c2 = commit(main, "feat two", 1_000_200);
  git(main, ["push", "-q", "-u", "origin", "feat"]);
  const c3 = commit(main, "feat three (local)", 1_000_300);
  return { c1, c2, c3 };
}

function fakeGh(handler) {
  const calls = [];
  const gh = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    return handler(args);
  };
  return { gh, calls };
}

function ghError(stderr, code) {
  return Object.assign(new Error(`gh failed: ${stderr}`), { stderr, code });
}

/** A gh that finds no PR for any branch, like a repository without pull requests. */
const noPulls = () => fakeGh(() => { throw ghError("no pull requests found for branch \"feat\""); });

async function rejectsWith(promise, status, check = () => {}) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof WorktreeError, `expected WorktreeError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    check(err);
    return true;
  });
}

test.beforeEach(() => resetGithubSummaryCaches());

test("githubRepoUrl accepts GitHub origins in every form and drops credentials", () => {
  assert.equal(githubRepoUrl("git@github.com:owner/name.git"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("git@github.com:owner/name"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("ssh://git@github.com/owner/name.git"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("https://github.com/owner/name.git\n"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("https://github.com/owner/name"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("https://x-token-x@github.com/owner/name.git"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("https://user:x-token-x@github.com/owner/name"), "https://github.com/owner/name");
  assert.equal(githubRepoUrl("https://gitlab.com/owner/name.git"), null);
  assert.equal(githubRepoUrl("/srv/git/origin.git"), null);
  assert.equal(githubRepoUrl("git@github.com:owner"), null);
  assert.equal(redactCredentials("fatal: unable to access 'https://x-token-x@github.com/o/r.git/': denied"), "fatal: unable to access 'https://github.com/o/r.git/': denied");
  assert.equal(redactCredentials("From https://user:x-token-x@github.com/o/r\n * branch main -> FETCH_HEAD"), "From https://github.com/o/r\n * branch main -> FETCH_HEAD");
  assert.equal(redactCredentials("git@github.com:o/r.git and a@b in prose"), "git@github.com:o/r.git and a@b in prose");
});

test("a feature branch lists its own commits plus the merge-base row and counts ahead/behind", async (t) => {
  const f = fixture(t);
  const { c1, c2, c3 } = featureBranch(f);
  const { gh, calls } = noPulls();
  const summary = await readGithubSummary(f.main, { gh, now: () => 5 });
  assert.equal(summary.branch, "feat");
  assert.equal(summary.detached, false);
  assert.equal(summary.defaultBranch, "main");
  assert.equal(summary.upstream, "origin/feat");
  assert.equal(summary.ahead, 1);
  assert.equal(summary.behind, 0);
  assert.equal(summary.fetchedAt, null);
  assert.equal(summary.fetchError, null);
  assert.equal(summary.repoUrl, null, "a local bare origin is not GitHub");
  assert.equal(summary.logBase, "origin/main");
  assert.deepEqual(summary.commits, [
    { sha: c3, short: c3.slice(0, 7), subject: "feat three (local)", author: "t", committedAt: 1_000_300_000, head: true, remoteHead: false, base: false },
    { sha: c2, short: c2.slice(0, 7), subject: "feat two", author: "t", committedAt: 1_000_200_000, head: false, remoteHead: true, base: false },
    { sha: c1, short: c1.slice(0, 7), subject: "feat one", author: "t", committedAt: 1_000_100_000, head: false, remoteHead: false, base: false },
    { sha: f.init, short: f.init.slice(0, 7), subject: "init", author: "t", committedAt: 1_000_000_000, head: false, remoteHead: false, base: true },
  ]);
  assert.equal(summary.cursor, `${f.init}:1`, "paging continues into the base's history below the merge-base row");
  assert.deepEqual(await readCommitPage(f.main, summary.cursor), { commits: [], cursor: null }, "the root commit has nothing before it");
  assert.equal(summary.pull, null);
  assert.equal(summary.pullError, null);
  assert.deepEqual(summary.conflicts, { status: "clean", base: "main", source: "local" });
  assert.equal(summary.at, 5);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [["pr", "view", "feat"]]);
  assert.equal(calls[0].cwd, f.main);
});

test("fetchRepo picks up origin's new commit and pullFastForward catches up", async (t) => {
  const f = fixture(t);
  featureBranch(f);
  const { gh } = noPulls();
  // Advance origin/feat behind main's back, on a commit main does not have (main's local commit is not pushed).
  git(f.other, ["fetch", "-q", "origin"]);
  git(f.other, ["checkout", "-q", "feat"]);
  git(f.main, ["reset", "-q", "--hard", "origin/feat"]); // drop the local-only commit so the pull can fast-forward
  const remote = commit(f.other, "remote work", 1_000_400);
  git(f.other, ["push", "-q", "origin", "feat"]);

  const before = await readGithubSummary(f.main, { gh });
  assert.equal(before.behind, 0, "nothing is known until a fetch");
  const start = Date.now();
  const fetched = await fetchRepo(f.main);
  assert.ok(fetched.fetchedAt >= start);
  assert.equal(fetched.fetchError, null);
  const after = await readGithubSummary(f.main, { gh });
  assert.equal(after.behind, 1);
  assert.equal(after.ahead, 0);
  assert.equal(after.fetchedAt, fetched.fetchedAt);
  assert.equal(after.commits.find((row) => row.remoteHead), undefined, "the remote head is not among HEAD's commits yet");

  const pulled = await pullFastForward(f.main, { gh });
  assert.equal(pulled.behind, 0);
  assert.equal(pulled.commits[0].sha, remote);
  assert.equal(pulled.commits[0].head, true);
  assert.equal(pulled.commits[0].remoteHead, true);
  assert.ok(pulled.fetchedAt >= fetched.fetchedAt);
  assert.equal(git(f.main, ["rev-parse", "HEAD"]), remote);
});

test("pullFastForward refuses a diverged branch and a dirty tree with git's own message", async (t) => {
  const f = fixture(t);
  featureBranch(f); // leaves one local-only commit on feat
  const { gh } = noPulls();
  git(f.other, ["fetch", "-q", "origin"]);
  git(f.other, ["checkout", "-q", "feat"]);
  commitFile(f.other, "a.txt", "remote\n", "remote change", 1_000_400);
  git(f.other, ["push", "-q", "origin", "feat"]);
  await rejectsWith(pullFastForward(f.main, { gh }), 409, (err) => {
    assert.equal(err.message, "fatal: Not possible to fast-forward, aborting.");
  });

  git(f.main, ["reset", "-q", "--hard", "HEAD~1"]); // back to the pushed commit: a fast-forward is possible now…
  writeFileSync(path.join(f.main, "a.txt"), "local edit\n"); // …unless the tree is dirty on the file the pull touches
  await rejectsWith(pullFastForward(f.main, { gh }), 409, (err) => {
    assert.match(err.message, /^error: Your local changes to the following files would be overwritten by merge:\n\ta\.txt/);
  });
  assert.equal(git(f.main, ["status", "--porcelain"]), "M a.txt", "the edit is kept");
});

test("on the default branch the log is HEAD's history and pages through readCommitPage", async (t) => {
  const f = fixture(t);
  const shas = [f.init];
  for (let i = 1; i <= 34; i++) shas.push(commit(f.main, `work ${i}`, 1_000_000 + i * 10));
  const { gh, calls } = noPulls();
  const summary = await readGithubSummary(f.main, { gh });
  assert.equal(summary.branch, "main");
  assert.equal(summary.logBase, null);
  assert.equal(summary.conflicts, null, "main compared to itself is not a comparison");
  assert.equal(summary.commits.length, 30);
  assert.deepEqual(summary.commits.map((row) => row.sha), shas.slice(-30).reverse());
  assert.equal(summary.commits[0].head, true);
  assert.equal(summary.ahead, 34);
  assert.equal(summary.commits.filter((row) => row.base).length, 0);
  assert.equal(summary.cursor, `${shas[34]}:30`, "an opaque offset from HEAD");
  assert.deepEqual(calls.map((c) => c.args[2]), ["main"]);

  const page = await readCommitPage(f.main, summary.cursor);
  assert.deepEqual(page.commits.map((row) => row.sha), shas.slice(0, 5).reverse());
  assert.equal(page.commits[4].subject, "init");
  assert.equal(page.cursor, null, "reached the root commit");
  assert.equal(page.commits.some((row) => row.head || row.base), false);
  const short = await readCommitPage(f.main, `${shas[3].slice(0, 7)}:1`);
  assert.deepEqual(short.commits.map((row) => row.sha), [shas[2], shas[1], shas[0]]);
  for (const bad of ["not-a-cursor", shas[3], `${shas[3]}:x`, "", `${shas[3]}:1:${shas[2]}:3`]) await rejectsWith(readCommitPage(f.main, bad), 400);
  await rejectsWith(readCommitPage(f.main, "abcdef0123456789abcdef0123456789abcdef01:0"), 404);
  await rejectsWith(readCommitPage(f.main, `${shas[3]}:0:abcdef0123456789abcdef0123456789abcdef01`), 404);
});

test("conflicts are detected locally against origin/<base> without touching the tree", async (t) => {
  const f = fixture(t);
  const { gh } = noPulls();
  git(f.main, ["checkout", "-q", "-b", "feat"]);
  commitFile(f.main, "a.txt", "feat\n", "feat edits a", 1_000_100);
  git(f.main, ["checkout", "-q", "-b", "clean-feat", "main"]);
  commitFile(f.main, "b.txt", "new\n", "adds b", 1_000_100);
  commitFile(f.other, "a.txt", "main change\n", "main edits a", 1_000_200);
  git(f.other, ["push", "-q", "origin", "main"]);
  await fetchRepo(f.main);

  git(f.main, ["checkout", "-q", "feat"]);
  const conflicting = await readGithubSummary(f.main, { gh });
  assert.deepEqual(conflicting.conflicts, { status: "conflicts", base: "main", source: "local", files: ["a.txt"] });
  assert.equal(git(f.main, ["status", "--porcelain"]), "", "the working tree is untouched");
  assert.equal(conflicting.upstream, null, "feat was never pushed");
  assert.equal(conflicting.ahead, 0);

  git(f.main, ["checkout", "-q", "clean-feat"]);
  const clean = await readGithubSummary(f.main, { gh });
  assert.deepEqual(clean.conflicts, { status: "clean", base: "main", source: "local" });
  assert.equal(clean.commits.length, 2);
  assert.equal(clean.commits[1].base, true);
});

const prView = {
  number: 42, title: "Add the panel", author: { login: "moses" }, url: "https://github.com/o/r/pull/42", state: "OPEN",
  isDraft: true, baseRefName: "release", headRefName: "feat", headRefOid: "", mergeable: "MERGEABLE", reviewDecision: "CHANGES_REQUESTED",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/lint" },
    { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://ci/test" },
    { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null },
    { __typename: "StatusContext", context: "deploy/preview", state: "FAILURE", targetUrl: "https://ci/deploy" },
  ],
};

const graphqlCounts = (nodes, comments = 3, hasNextPage = false) => ({
  data: { repository: { pullRequest: {
    comments: { totalCount: comments },
    reviewThreads: { totalCount: nodes.length, pageInfo: { hasNextPage, endCursor: hasNextPage ? "CURSOR" : null }, nodes },
  } } },
});

test("a PR from gh is mapped with its checks and counts, and the log anchors on the PR's base", async (t) => {
  const f = fixture(t);
  git(f.main, ["checkout", "-q", "-b", "release"]);
  const releaseTip = commit(f.main, "release work", 1_000_100);
  git(f.main, ["push", "-q", "-u", "origin", "release"]);
  git(f.main, ["checkout", "-q", "-b", "feat"]);
  const featTip = commit(f.main, "feat work", 1_000_200);
  git(f.main, ["push", "-q", "-u", "origin", "feat"]);
  const { gh, calls } = fakeGh((args) => {
    if (args[0] === "pr") return { stdout: JSON.stringify({ ...prView, headRefOid: featTip }), stderr: "" };
    if (args.includes("after=CURSOR")) return { stdout: JSON.stringify(graphqlCounts([{ isResolved: false }])), stderr: "" };
    return { stdout: JSON.stringify(graphqlCounts([{ isResolved: false }, { isResolved: true }, { isResolved: false }], 3, true)), stderr: "" };
  });
  const summary = await readGithubSummary(f.main, { gh });
  assert.deepEqual(summary.pull, {
    number: 42, title: "Add the panel", author: "moses", url: "https://github.com/o/r/pull/42", state: "open", draft: true,
    baseBranch: "release", headSha: featTip, reviewDecision: "changes_requested", unresolvedThreads: 3, comments: 3,
    checks: {
      state: "failing", passing: 1, failing: 1, pending: 1,
      checks: [
        { name: "lint", state: "passing", url: "https://ci/lint" },
        { name: "test", state: "pending", url: "https://ci/test" },
        { name: "docs", state: "skipped", url: null },
        { name: "deploy/preview", state: "failing", url: "https://ci/deploy" },
      ],
    },
    mergeable: "mergeable",
  });
  assert.equal(summary.pullError, null);
  assert.equal(summary.logBase, "origin/release");
  assert.deepEqual(summary.commits.map((row) => [row.sha, row.base]), [[featTip, false], [releaseTip, true]]);
  assert.equal(summary.cursor, `${releaseTip}:1`);
  assert.deepEqual(summary.conflicts, { status: "clean", base: "release", source: "local" });
  assert.deepEqual(calls[0].args, ["pr", "view", "feat", "--json", "number,title,author,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup"]);
  assert.equal(calls.length, 3, "one pr view and two GraphQL pages");
  assert.deepEqual(calls[1].args.slice(0, 2), ["api", "graphql"]);
  assert.ok(calls[1].args.includes("owner={owner}") && calls[1].args.includes("name={repo}") && calls[1].args.includes("number=42"));
  assert.deepEqual(calls[2].args.slice(-2), ["-f", "after=CURSOR"], "the cursor is passed as a string field");

  // A second read within a minute reuses gh's answer; the git half stays live.
  const again = await readGithubSummary(f.main, { gh });
  assert.equal(calls.length, 3);
  assert.deepEqual(again.pull, summary.pull);
  await readGithubSummary(f.main, { gh, fetch: true });
  assert.equal(calls.length, 6, "fetch bypasses the gh cache");
});

test("check states: all passing, pending beats passing, skipped alone counts as passing, no checks is null", async (t) => {
  const f = fixture(t);
  git(f.main, ["checkout", "-q", "-b", "feat"]);
  commit(f.main, "feat work", 1_000_200);
  const read = async (statusCheckRollup, extra = {}) => {
    resetGithubSummaryCaches();
    const { gh } = fakeGh((args) => args[0] === "pr"
      ? { stdout: JSON.stringify({ ...prView, statusCheckRollup, ...extra }), stderr: "" }
      : { stdout: JSON.stringify(graphqlCounts([])), stderr: "" });
    return (await readGithubSummary(f.main, { gh })).pull;
  };
  assert.equal((await read([])).checks, null);
  assert.equal((await read([{ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "NEUTRAL" }])).checks.state, "passing");
  assert.equal((await read([{ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SKIPPED" }])).checks.state, "passing");
  assert.equal((await read([
    { __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "StatusContext", context: "b", state: "PENDING" },
  ])).checks.state, "pending");
  assert.equal((await read([{ __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "TIMED_OUT" }])).checks.state, "failing");
  const merged = await read([], { state: "MERGED", reviewDecision: "APPROVED", mergeable: "CONFLICTING", author: null });
  assert.equal(merged.state, "merged");
  assert.equal(merged.reviewDecision, "approved");
  assert.equal(merged.mergeable, "conflicting");
  assert.equal(merged.author, "");
  assert.deepEqual([merged.unresolvedThreads, merged.comments], [0, 3]);
});

test("gh failures are reported without losing the git half; a missing PR is not an error", async (t) => {
  const f = fixture(t);
  featureBranch(f);
  const missing = fakeGh(() => { throw ghError("", "ENOENT"); });
  const summary = await readGithubSummary(f.main, { gh: missing.gh });
  assert.equal(summary.pull, null);
  assert.equal(summary.pullError, "gh is not installed");
  assert.equal(summary.branch, "feat");
  assert.equal(summary.commits.length, 4);
  assert.equal(summary.ahead, 1);
  assert.deepEqual(summary.conflicts, { status: "clean", base: "main", source: "local" });

  resetGithubSummaryCaches();
  const loggedOut = fakeGh(() => { throw ghError("To get started with GitHub CLI, please run:  gh auth login"); });
  assert.equal((await readGithubSummary(f.main, { gh: loggedOut.gh })).pullError, "gh is not logged in");

  resetGithubSummaryCaches();
  // gh's "no known GitHub host" message mentions `gh auth login`; it must not read as a login problem.
  const notGithub = fakeGh(() => { throw ghError("none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`"); });
  assert.equal((await readGithubSummary(f.main, { gh: notGithub.gh })).pullError, "origin is not a GitHub repository");

  resetGithubSummaryCaches();
  const none = fakeGh(() => { throw ghError("no pull requests found for branch \"feat\""); });
  const noPull = await readGithubSummary(f.main, { gh: none.gh });
  assert.deepEqual([noPull.pull, noPull.pullError], [null, null]);

  resetGithubSummaryCaches();
  const countsDown = fakeGh((args) => {
    if (args[0] === "pr") return { stdout: JSON.stringify(prView), stderr: "" };
    throw ghError("GraphQL: rate limited");
  });
  const partial = await readGithubSummary(f.main, { gh: countsDown.gh });
  assert.equal(partial.pull.number, 42);
  assert.deepEqual([partial.pull.unresolvedThreads, partial.pull.comments], [null, null]);
  assert.equal(partial.pullError, null);
});

test("a detached HEAD shows its history and asks gh nothing", async (t) => {
  const f = fixture(t);
  const { c3 } = featureBranch(f);
  git(f.main, ["checkout", "-q", "--detach"]);
  const { gh, calls } = noPulls();
  const summary = await readGithubSummary(f.main, { gh });
  assert.equal(summary.detached, true);
  assert.equal(summary.branch, null);
  assert.equal(summary.upstream, null);
  assert.deepEqual([summary.ahead, summary.behind], [0, 0]);
  assert.equal(summary.logBase, null);
  assert.equal(summary.commits[0].sha, c3);
  assert.equal(summary.commits.length, 4);
  assert.equal(summary.cursor, null);
  assert.deepEqual([summary.pull, summary.pullError, summary.conflicts], [null, null, null]);
  assert.equal(calls.length, 0);
});

test("without an origin remote the fetch fails but the log still renders", async (t) => {
  const root = tempRoot(t);
  git(root, ["init", "-q", "-b", "main"]);
  const init = commit(root, "init", 1_000_000);
  git(root, ["checkout", "-q", "-b", "feat"]);
  const work = commit(root, "work", 1_000_100);
  const { gh } = noPulls();
  const summary = await readGithubSummary(root, { gh, fetch: true });
  assert.equal(summary.fetchedAt, null);
  assert.match(summary.fetchError, /origin/);
  assert.equal(summary.branch, "feat");
  assert.equal(summary.defaultBranch, "main");
  assert.equal(summary.upstream, null);
  assert.equal(summary.repoUrl, null);
  assert.equal(summary.logBase, null, "no origin/main to anchor on");
  assert.deepEqual(summary.commits.map((row) => row.sha), [work, init]);
  assert.equal(summary.cursor, null);
  assert.deepEqual(summary.conflicts, { status: "unknown", base: "main", reason: "origin/main does not exist locally; fetch to compare." });
});

test("fetchRepo shares an in-flight fetch and skips fetches inside the minimum interval", async (t) => {
  const f = fixture(t);
  const first = fetchRepo(f.main);
  const second = fetchRepo(f.main);
  assert.equal(first, second, "concurrent callers share one fetch");
  const result = await first;
  assert.equal(result.fetchError, null);
  assert.ok(result.fetchedAt > 0);

  // With origin gone, a real fetch would fail; inside the interval the last result is returned instead.
  git(f.main, ["remote", "remove", "origin"]);
  assert.deepEqual(await fetchRepo(f.main), result);
  const failed = await fetchRepo(f.main, { minIntervalMs: 0 });
  assert.equal(failed.fetchedAt, result.fetchedAt, "the last successful time survives a failure");
  assert.match(failed.fetchError, /origin/);
  const summary = await readGithubSummary(f.main, { gh: noPulls().gh });
  assert.deepEqual([summary.fetchedAt, summary.fetchError], [failed.fetchedAt, failed.fetchError]);
});

test("an empty repository yields a branch with no commits", async (t) => {
  const root = tempRoot(t);
  git(root, ["init", "-q", "-b", "main"]);
  const { gh, calls } = noPulls();
  const summary = await readGithubSummary(root, { gh });
  assert.equal(summary.branch, "main");
  assert.equal(summary.detached, false);
  assert.equal(summary.defaultBranch, null);
  assert.deepEqual(summary.commits, []);
  assert.equal(summary.cursor, null);
  assert.equal(summary.logBase, null);
  assert.equal(summary.conflicts, null);
  assert.deepEqual([summary.ahead, summary.behind, summary.upstream], [0, 0, null]);
  assert.equal(calls.length, 1, "gh is still asked about the branch");
  await rejectsWith(pullFastForward(root, { gh }), 409);
});

test("readGithubSummary coalesces concurrent reads of one directory", async (t) => {
  const f = fixture(t);
  featureBranch(f);
  const { gh, calls } = noPulls();
  const a = readGithubSummary(f.main, { gh });
  const b = readGithubSummary(f.main, { gh });
  assert.equal(a, b);
  await a;
  assert.equal(calls.length, 1);
  await rejectsWith(readGithubSummary(path.join(f.root, "nope"), { gh }), 409);
});

test("paging through a merge reaches every commit, including an older second-parent line", async (t) => {
  const f = fixture(t);
  const { gh } = noPulls();
  git(f.main, ["checkout", "-q", "-b", "side"]);
  for (let i = 1; i <= 3; i++) commit(f.main, `side ${i}`, 1_000_000 + i); // older than everything on main
  git(f.main, ["checkout", "-q", "main"]);
  for (let i = 1; i <= 40; i++) commit(f.main, `main ${i}`, 1_000_100 + i * 10);
  const date = "@1_001_000 +0000".replace(/_/g, "");
  git(f.main, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const all = git(f.main, ["rev-list", "HEAD"]).split("\n");
  assert.equal(all.length, 45);

  const summary = await readGithubSummary(f.main, { gh });
  const seen = summary.commits.map((row) => row.sha);
  let cursor = summary.cursor;
  let pages = 1;
  while (cursor) {
    const page = await readCommitPage(f.main, cursor);
    seen.push(...page.commits.map((row) => row.sha));
    cursor = page.cursor;
    pages++;
  }
  assert.equal(pages, 2);
  assert.equal(new Set(seen).size, seen.length, "no commit is listed twice");
  assert.deepEqual([...seen].sort(), [...all].sort(), "every commit reachable from HEAD is listed");
  assert.ok(seen.indexOf(all[0]) === 0 && seen.slice(-4).map((sha) => sha).includes(f.init));
});

test("a branch with more own commits than the first page shows pages through them before the base row", async (t) => {
  const f = fixture(t);
  const { c1, c2, c3 } = featureBranch(f);
  const originMain = git(f.main, ["rev-parse", "origin/main"]);
  const { gh } = noPulls();
  const summary = await readGithubSummary(f.main, { gh, logCap: 2 });
  assert.deepEqual(summary.commits.map((row) => [row.sha, row.base]), [[c3, false], [c2, false]]);
  assert.equal(summary.cursor, `${c3}:2:${originMain}`, "continue the origin/main..HEAD range");
  assert.equal(summary.logBase, "origin/main");
  const rest = await readCommitPage(f.main, summary.cursor);
  assert.deepEqual(rest.commits.map((row) => [row.sha, row.base]), [[c1, false], [f.init, true]], "the range ends with the merge-base row");
  assert.equal(rest.cursor, `${f.init}:1`);
  assert.deepEqual(await readCommitPage(f.main, rest.cursor), { commits: [], cursor: null });
  const uncapped = await readGithubSummary(f.main, { gh });
  assert.equal(uncapped.commits.length, 4);
  assert.equal(uncapped.cursor, `${f.init}:1`);
});

test("fetch state is shared between the main checkout and its linked worktrees", async (t) => {
  const f = fixture(t);
  const wt = path.join(f.root, "wt");
  git(f.main, ["worktree", "add", "-q", "-b", "wt-branch", wt]);
  commit(wt, "worktree work", 1_000_100);
  const { gh } = noPulls();
  const result = await fetchRepo(f.main);
  assert.equal(result.fetchError, null);
  git(f.main, ["remote", "remove", "origin"]); // a fetch from either checkout would fail now
  assert.deepEqual(await fetchRepo(wt), result, "inside the interval the worktree sees the main checkout's fetch");
  const summary = await readGithubSummary(wt, { gh });
  assert.equal(summary.branch, "wt-branch");
  assert.deepEqual([summary.fetchedAt, summary.fetchError], [result.fetchedAt, null]);
  assert.equal(summary.commits.length, 2, "the worktree's log anchors on the base that was fetched into the shared refs");
});

test("a numeric branch name is not mistaken for a PR number", async (t) => {
  const f = fixture(t);
  git(f.main, ["checkout", "-q", "-b", "123"]);
  commit(f.main, "numbered", 1_000_100);
  const { gh, calls } = fakeGh(() => ({ stdout: JSON.stringify({ ...prView, number: 123, headRefName: "feat" }), stderr: "" }));
  const summary = await readGithubSummary(f.main, { gh });
  assert.deepEqual([summary.pull, summary.pullError], [null, null], "gh answered about PR #123, whose head is another branch");
  assert.equal(calls.length, 1, "no counts are fetched for a PR that is not ours");
  assert.equal(summary.logBase, "origin/main");
});

test("a closed PR's base is not used; the log anchors on the default branch", async (t) => {
  const f = fixture(t);
  git(f.main, ["checkout", "-q", "-b", "release"]);
  commit(f.main, "release work", 1_000_100);
  git(f.main, ["push", "-q", "-u", "origin", "release"]);
  git(f.main, ["checkout", "-q", "-b", "feat"]);
  commit(f.main, "feat work", 1_000_200);
  const { gh } = fakeGh((args) => args[0] === "pr"
    ? { stdout: JSON.stringify({ ...prView, state: "CLOSED" }), stderr: "" }
    : { stdout: JSON.stringify(graphqlCounts([])), stderr: "" });
  const summary = await readGithubSummary(f.main, { gh });
  assert.equal(summary.pull.state, "closed");
  assert.equal(summary.pull.baseBranch, "release");
  assert.equal(summary.logBase, "origin/main");
  assert.deepEqual(summary.commits.map((row) => [row.subject, row.base]), [["feat work", false], ["release work", false], ["init", true]]);
  assert.equal(summary.conflicts.base, "main");
});

test("unrelated histories make the conflict check unknown rather than failing the summary", async (t) => {
  const f = fixture(t);
  git(f.main, ["checkout", "-q", "--orphan", "lonely"]);
  git(f.main, ["rm", "-q", "-rf", "."]);
  const lonely = commit(f.main, "lonely", 1_000_100);
  const { gh } = noPulls();
  const summary = await readGithubSummary(f.main, { gh });
  assert.equal(summary.branch, "lonely");
  assert.deepEqual(summary.conflicts, { status: "unknown", base: "main", reason: "fatal: refusing to merge unrelated histories" });
  assert.equal(summary.logBase, "origin/main");
  assert.deepEqual(summary.commits.map((row) => [row.sha, row.base]), [[lonely, false]], "no merge-base row without a merge base");
  assert.equal(summary.cursor, null);
});

test("credentials in the origin URL never reach the fetch error", async (t) => {
  const f = fixture(t);
  git(f.main, ["remote", "set-url", "origin", "https://x-token-x@github.invalid/o/r.git"]);
  const { gh } = noPulls();
  const summary = await readGithubSummary(f.main, { gh, fetch: true });
  assert.equal(summary.fetchedAt, null);
  assert.match(summary.fetchError, /^fatal: /);
  assert.ok(!summary.fetchError.includes("x-token-x"), summary.fetchError);
  assert.equal(summary.repoUrl, null, "github.invalid is not GitHub");
  git(f.main, ["remote", "set-url", "origin", "https://x-token-x@github.com/o/r.git"]);
  assert.equal((await readGithubSummary(f.main, { gh })).repoUrl, "https://github.com/o/r");
});
