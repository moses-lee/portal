import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ATTENTION_PAGE_QUERY, ATTENTION_QUERY, AUTHORED_SEARCH, MAX_SEARCH_PAGES, REVIEW_REQUESTED_SEARCH, attachLocalProjects, attentionReasons,
  cloneRepo, getGithubLogin, isTransientGhFailure, portalReposDir, pullKey, readOriginUrl, resetGithubAttentionCaches, searchAttentionPulls,
} from "../src/lib/orchestrator/github-attention.ts";
import { WorktreeError } from "../src/lib/worktrees.ts";

// The module under test inherits process.env, so isolate it from the developer's git config too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env }).toString().trim();
}

function tempRoot(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-attn-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeGh(handler) {
  const calls = [];
  const gh = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    return handler(args, opts);
  };
  return { gh, calls };
}

function ghError(stderr, code) {
  return Object.assign(new Error(`gh failed: ${stderr}`), { stderr, code });
}

/** One PullRequest node as GitHub's GraphQL search returns it. */
function node(overrides = {}) {
  return {
    __typename: "PullRequest",
    number: 1,
    title: "Add a thing",
    url: "https://github.com/acme/app/pull/1",
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    baseRefName: "main",
    headRefName: "feat/thing",
    updatedAt: "2026-09-18T10:00:00Z",
    author: { login: "moses-lee" },
    repository: { nameWithOwner: "acme/app" },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

/** One page of a search as GitHub returns it; `cursor` set means there is a next page. */
function page(nodes, { issueCount = nodes.length, cursor = null } = {}) {
  return { issueCount, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor }, nodes };
}

function response(authored, requested) {
  return { stdout: JSON.stringify({ data: { authored: page(authored), requested: page(requested) } }), stderr: "" };
}

/** The result of a search that could not run at all. */
function failed(error) {
  return { pulls: [], error, warning: null, truncated: false, total: { authored: 0, requested: 0 } };
}

/** The `-f name=value` variables of a `gh api graphql` invocation. */
function variablesOf(args) {
  const vars = {};
  args.forEach((arg, i) => {
    if (arg !== "-f") return;
    const [name, value] = args[i + 1].split(/=(.*)/s);
    vars[name] = value;
  });
  return vars;
}

/** Run one search over canned nodes and return the single mapped pull. */
async function mapOne(overrides) {
  const { gh } = fakeGh(() => response([node(overrides)], []));
  const { pulls, error } = await searchAttentionPulls({ gh, cwd: "/tmp" });
  assert.equal(error, null);
  assert.equal(pulls.length, 1);
  return pulls[0];
}

async function rejectsWith(promise, status, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof WorktreeError, `expected WorktreeError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test.beforeEach(() => resetGithubAttentionCaches());

test("getGithubLogin asks gh once per process and can be reset", async () => {
  const { gh, calls } = fakeGh(() => ({ stdout: "moses-lee\n", stderr: "" }));
  assert.equal(await getGithubLogin(gh, "/tmp"), "moses-lee");
  assert.equal(await getGithubLogin(gh, "/tmp"), "moses-lee");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { args: ["api", "user", "--jq", ".login"], cwd: "/tmp" });

  resetGithubAttentionCaches();
  await getGithubLogin(gh, "/tmp");
  assert.equal(calls.length, 2, "reset forgets the login");
});

test("getGithubLogin shares one in-flight call and does not cache failures", async () => {
  let resolve;
  const { gh, calls } = fakeGh(() => new Promise((r) => { resolve = r; }));
  const [a, b] = [getGithubLogin(gh, "/tmp"), getGithubLogin(gh, "/tmp")];
  resolve({ stdout: "moses-lee", stderr: "" });
  assert.deepEqual(await Promise.all([a, b]), ["moses-lee", "moses-lee"]);
  assert.equal(calls.length, 1);

  resetGithubAttentionCaches();
  const loggedOut = fakeGh(() => { throw ghError("To get started with GitHub CLI, please run:  gh auth login"); });
  await rejectsWith(getGithubLogin(loggedOut.gh, "/tmp"), 409, /^gh is not logged in$/);
  const empty = fakeGh(() => ({ stdout: "\n", stderr: "" }));
  await rejectsWith(getGithubLogin(empty.gh, "/tmp"), 409, /unexpected output/);
  const missing = fakeGh(() => { throw ghError("", "ENOENT"); });
  await rejectsWith(getGithubLogin(missing.gh, "/tmp"), 409, /^gh is not installed$/);
});

test("searchAttentionPulls makes one aliased GraphQL call and merges roles across both searches", async () => {
  const authored = [
    node({ number: 1, updatedAt: "2026-09-18T10:00:00Z" }),
    node({ number: 2, url: "https://github.com/acme/app/pull/2", updatedAt: "2026-09-18T12:00:00Z", headRefName: "feat/two" }),
  ];
  const requested = [
    node({ number: 2, url: "https://github.com/acme/app/pull/2", updatedAt: "2026-09-18T12:00:00Z", headRefName: "feat/two" }),
    node({
      number: 7, title: "Their PR", url: "https://github.com/other/lib/pull/7", repository: { nameWithOwner: "other/lib" },
      author: { login: "someone" }, updatedAt: "2026-09-18T11:00:00Z", headRefName: "fix/x",
    }),
  ];
  const { gh, calls } = fakeGh(() => response(authored, requested));
  const { pulls, error, warning, truncated, total } = await searchAttentionPulls({ gh, cwd: "/tmp" });

  assert.equal(error, null);
  assert.equal(warning, null);
  assert.equal(truncated, false);
  assert.deepEqual(total, { authored: 2, requested: 2 });
  assert.equal(calls.length, 1, "both searches travel in one request");
  assert.equal(calls[0].cwd, "/tmp");
  assert.deepEqual(calls[0].args, [
    "api", "graphql", "-f", `query=${ATTENTION_QUERY}`, "-f", `authored=${AUTHORED_SEARCH}`, "-f", `requested=${REVIEW_REQUESTED_SEARCH}`,
  ]);
  assert.match(ATTENTION_QUERY, /authored: search\(type: ISSUE, query: \$authored, first: 50\)\{ issueCount pageInfo \{ hasNextPage endCursor \} nodes/);
  assert.match(ATTENTION_QUERY, /requested: search\(type: ISSUE, query: \$requested, first: 50\)\{ issueCount pageInfo/);
  assert.match(ATTENTION_QUERY, /commits\(last: 1\) \{ nodes \{ commit \{ statusCheckRollup \{ state \} \} \} \}/);
  assert.match(ATTENTION_PAGE_QUERY, /page: search\(type: ISSUE, query: \$search, first: 50, after: \$after\)\{ issueCount pageInfo/);
  assert.ok(!/\$query\b/.test(ATTENTION_PAGE_QUERY), "a variable named `query` would collide with gh's -f query=<document>");
  assert.equal(AUTHORED_SEARCH, "is:pr is:open author:@me sort:updated-desc");
  assert.equal(REVIEW_REQUESTED_SEARCH, "is:pr is:open review-requested:@me sort:updated-desc");

  assert.deepEqual(pulls.map(pullKey), ["acme/app#2", "other/lib#7", "acme/app#1"], "newest updated first");
  const byKey = Object.fromEntries(pulls.map((pull) => [pullKey(pull), pull]));
  assert.deepEqual(byKey["acme/app#1"].roles, ["author"]);
  assert.deepEqual(byKey["acme/app#2"].roles, ["author", "reviewer"]);
  assert.deepEqual(byKey["other/lib#7"].roles, ["reviewer"]);
  assert.deepEqual(byKey["acme/app#1"], {
    repo: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1", title: "Add a thing", author: "moses-lee",
    roles: ["author"], state: "open", draft: false, baseBranch: "main", headBranch: "feat/thing", checks: "passing",
    reviewDecision: "review_required", mergeable: "mergeable", updatedAt: Date.parse("2026-09-18T10:00:00Z"),
    localProjectId: null, worktreeProjectId: null,
  });
  assert.equal(byKey["other/lib#7"].author, "someone");
});

test("searchAttentionPulls maps every GitHub enum onto the contract's values", async () => {
  const rollup = (state) => ({ nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] });
  assert.equal((await mapOne({ commits: rollup("SUCCESS") })).checks, "passing");
  assert.equal((await mapOne({ commits: rollup("FAILURE") })).checks, "failing");
  assert.equal((await mapOne({ commits: rollup("ERROR") })).checks, "failing");
  assert.equal((await mapOne({ commits: rollup("PENDING") })).checks, "pending");
  assert.equal((await mapOne({ commits: rollup("EXPECTED") })).checks, "pending");
  assert.equal((await mapOne({ commits: rollup(null) })).checks, null, "no checks configured");
  assert.equal((await mapOne({ commits: { nodes: [] } })).checks, null, "no commits");
  assert.equal((await mapOne({ commits: undefined })).checks, null);

  assert.equal((await mapOne({ mergeable: "MERGEABLE" })).mergeable, "mergeable");
  assert.equal((await mapOne({ mergeable: "CONFLICTING" })).mergeable, "conflicting");
  assert.equal((await mapOne({ mergeable: "UNKNOWN" })).mergeable, "unknown");
  assert.equal((await mapOne({ mergeable: undefined })).mergeable, "unknown");

  assert.equal((await mapOne({ reviewDecision: "APPROVED" })).reviewDecision, "approved");
  assert.equal((await mapOne({ reviewDecision: "CHANGES_REQUESTED" })).reviewDecision, "changes_requested");
  assert.equal((await mapOne({ reviewDecision: "REVIEW_REQUIRED" })).reviewDecision, "review_required");
  assert.equal((await mapOne({ reviewDecision: null })).reviewDecision, null);

  assert.equal((await mapOne({ state: "OPEN" })).state, "open");
  assert.equal((await mapOne({ state: "CLOSED" })).state, "closed");
  assert.equal((await mapOne({ state: "MERGED" })).state, "merged");
  assert.equal((await mapOne({ isDraft: true })).draft, true);
  assert.equal((await mapOne({ updatedAt: "not a date" })).updatedAt, 0);
  assert.equal((await mapOne({ url: undefined })).url, "https://github.com/acme/app/pull/1", "url is rebuilt when absent");
});

test("searchAttentionPulls skips nodes that are not pull requests and never throws when gh cannot answer", async () => {
  const junk = fakeGh(() => response([node(), { __typename: "Issue", number: 9 }, null, node({ repository: null })], "not-an-array"));
  assert.deepEqual((await searchAttentionPulls({ gh: junk.gh, cwd: "/tmp" })).pulls.map(pullKey), ["acme/app#1"]);

  const missing = fakeGh(() => { throw ghError("", "ENOENT"); });
  assert.deepEqual(await searchAttentionPulls({ gh: missing.gh, cwd: "/tmp" }), failed("gh is not installed"));

  const loggedOut = fakeGh(() => { throw ghError("To get started with GitHub CLI, please run:  gh auth login"); });
  assert.deepEqual(await searchAttentionPulls({ gh: loggedOut.gh, cwd: "/tmp" }), failed("gh is not logged in"));
  assert.equal(loggedOut.calls.length, 1, "a login problem is not retried");

  const rateLimited = fakeGh(() => { throw ghError("gh: API rate limit exceeded for user ID 1. (HTTP 403)\nmore detail"); });
  assert.deepEqual(await searchAttentionPulls({ gh: rateLimited.gh, cwd: "/tmp" }), failed("gh: API rate limit exceeded for user ID 1. (HTTP 403)"));

  const offline = fakeGh(() => { throw ghError("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com") ; });
  assert.deepEqual(await searchAttentionPulls({ gh: offline.gh, cwd: "/tmp" }), failed("error connecting to api.github.com"));

  const notJson = fakeGh(() => ({ stdout: "<html>", stderr: "" }));
  assert.deepEqual(await searchAttentionPulls({ gh: notJson.gh, cwd: "/tmp" }), failed("gh returned unexpected output"));

  const graphqlErrors = fakeGh(() => ({ stdout: JSON.stringify({ data: null, errors: [{ message: "Something went wrong\nrequest id" }] }), stderr: "" }));
  assert.deepEqual(await searchAttentionPulls({ gh: graphqlErrors.gh, cwd: "/tmp" }), failed("Something went wrong"));

  // gh exits 1 for a response with errors even when it printed the body; with no data that is a failure with GitHub's message.
  const rejectedNoData = fakeGh(() => {
    throw Object.assign(ghError("gh: Field 'nope' doesn't exist on type 'Query'"), {
      stdout: JSON.stringify({ data: null, errors: [{ message: "Field 'nope' doesn't exist on type 'Query'" }] }),
    });
  });
  assert.deepEqual(await searchAttentionPulls({ gh: rejectedNoData.gh, cwd: "/tmp" }), failed("Field 'nope' doesn't exist on type 'Query'"));

  const empty = fakeGh(() => response([], []));
  assert.deepEqual(await searchAttentionPulls({ gh: empty.gh, cwd: "/tmp" }), { pulls: [], error: null, warning: null, truncated: false, total: { authored: 0, requested: 0 } });
});

test("searchAttentionPulls keeps the data of a partial GraphQL response and reports the rest as a warning", async () => {
  const body = {
    data: { authored: page([node()]), requested: null },
    errors: [{ message: "Something went wrong while executing your query. Please include `ABCD` when reporting.\nmore", path: ["requested"] }],
  };
  // The usual shape: gh exits 1 (the error is on stderr, without a 5xx) but the body is on stdout.
  const rejected = fakeGh(() => { throw Object.assign(ghError("gh: Something went wrong while executing your query."), { stdout: JSON.stringify(body) }); });
  const result = await searchAttentionPulls({ gh: rejected.gh, cwd: "/tmp" });
  assert.deepEqual(result.pulls.map(pullKey), ["acme/app#1"]);
  assert.equal(result.error, null);
  assert.equal(result.warning, "Something went wrong while executing your query. Please include `ABCD` when reporting.");
  assert.deepEqual(result.total, { authored: 1, requested: 0 });
  assert.equal(rejected.calls.length, 1, "not a transient failure, so not retried");

  // Should gh ever exit 0 with such a body, the same applies.
  const resolved = fakeGh(() => ({ stdout: JSON.stringify(body), stderr: "" }));
  const same = await searchAttentionPulls({ gh: resolved.gh, cwd: "/tmp" });
  assert.deepEqual(same.pulls.map(pullKey), ["acme/app#1"]);
  assert.equal(same.warning, "Something went wrong while executing your query. Please include `ABCD` when reporting.");

  // A rejection whose stdout is not a body (or has no errors) falls back to gh's reason.
  const noMessage = fakeGh(() => { throw Object.assign(ghError("gh: boom"), { stdout: JSON.stringify({ data: { authored: page([]), requested: page([]) } }) }); });
  assert.deepEqual(await searchAttentionPulls({ gh: noMessage.gh, cwd: "/tmp" }), { pulls: [], error: null, warning: "gh: boom", truncated: false, total: { authored: 0, requested: 0 } });
});

test("searchAttentionPulls pages each search up to the cap, reports totals and truncation, and narrows by updatedSince", async () => {
  const nodes = (from, to, repo = "acme/app") => Array.from({ length: to - from + 1 }, (_, i) => node({
    number: from + i, url: `https://github.com/${repo}/pull/${from + i}`, repository: { nameWithOwner: repo },
  }));
  const since = ` updated:>=2026-09-17`;
  const { gh, calls } = fakeGh((args) => {
    const vars = variablesOf(args);
    if (vars.query === ATTENTION_QUERY) {
      assert.equal(vars.authored, AUTHORED_SEARCH + since);
      assert.equal(vars.requested, REVIEW_REQUESTED_SEARCH + since);
      return { stdout: JSON.stringify({ data: {
        authored: page(nodes(1, 2), { issueCount: 3, cursor: "a1" }),
        requested: page(nodes(101, 102, "other/lib"), { issueCount: 153, cursor: "r1" }),
      } }), stderr: "" };
    }
    assert.equal(vars.query, ATTENTION_PAGE_QUERY);
    const pages = {
      a1: { search: AUTHORED_SEARCH + since, body: page(nodes(3, 3), { issueCount: 3 }) },
      r1: { search: REVIEW_REQUESTED_SEARCH + since, body: page(nodes(103, 104, "other/lib"), { issueCount: 153, cursor: "r2" }) },
      r2: { search: REVIEW_REQUESTED_SEARCH + since, body: page(nodes(105, 105, "other/lib"), { issueCount: 153, cursor: "r3" }) },
    };
    const expected = pages[vars.after];
    assert.ok(expected, `unexpected page ${vars.after}: the cap is ${MAX_SEARCH_PAGES} pages per search`);
    assert.equal(vars.search, expected.search);
    return { stdout: JSON.stringify({ data: { page: expected.body } }), stderr: "" };
  });
  // 23:30 UTC on the 17th: the day, not the instant, is what GitHub filters on.
  const result = await searchAttentionPulls({ gh, cwd: "/tmp", updatedSince: Date.UTC(2026, 8, 17, 23, 30) });
  assert.equal(result.error, null);
  assert.equal(result.warning, null);
  assert.equal(calls.length, 4, "first page for both, one more for authored, two more (the cap) for requested");
  assert.deepEqual(calls[1].args.slice(0, 4), ["api", "graphql", "-f", `query=${ATTENTION_PAGE_QUERY}`]);
  assert.deepEqual(result.pulls.map(pullKey).sort(), [
    "acme/app#1", "acme/app#2", "acme/app#3", "other/lib#101", "other/lib#102", "other/lib#103", "other/lib#104", "other/lib#105",
  ]);
  assert.deepEqual(result.pulls.map((pull) => pull.roles).filter((roles) => roles[0] === "author").length, 3);
  assert.equal(result.truncated, true, "requested still had a next page after the third");
  assert.deepEqual(result.total, { authored: 3, requested: 153 });

  // Without updatedSince the searches are untouched; with everything on one page nothing is truncated.
  const plain = fakeGh((args) => {
    const vars = variablesOf(args);
    assert.equal(vars.authored, AUTHORED_SEARCH);
    return response([node()], []);
  });
  const single = await searchAttentionPulls({ gh: plain.gh, cwd: "/tmp" });
  assert.equal(single.truncated, false);
  assert.equal(plain.calls.length, 1);

  // A later page that fails keeps the earlier ones, flags truncation, and explains in the warning.
  const flakyPage = fakeGh((args) => {
    const vars = variablesOf(args);
    if (vars.query === ATTENTION_QUERY) return { stdout: JSON.stringify({ data: { authored: page(nodes(1, 1), { issueCount: 2, cursor: "a1" }), requested: page([]) } }), stderr: "" };
    throw ghError("gh: API rate limit exceeded (HTTP 403)");
  });
  const partial = await searchAttentionPulls({ gh: flakyPage.gh, cwd: "/tmp" });
  assert.deepEqual(partial.pulls.map(pullKey), ["acme/app#1"]);
  assert.equal(partial.error, null);
  assert.equal(partial.warning, "gh: API rate limit exceeded (HTTP 403)");
  assert.equal(partial.truncated, true);
  assert.deepEqual(partial.total, { authored: 2, requested: 0 });
});

test("searchAttentionPulls retries a transient GitHub failure once", async () => {
  let attempts = 0;
  const flaky = fakeGh(() => {
    if (attempts++ === 0) throw ghError("gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)");
    return response([node()], []);
  });
  const result = await searchAttentionPulls({ gh: flaky.gh, cwd: "/tmp", retryDelayMs: 1 });
  assert.equal(result.error, null);
  assert.deepEqual(result.pulls.map(pullKey), ["acme/app#1"]);
  assert.equal(flaky.calls.length, 2);

  // execFile's own timeout counts too.
  let killed = 0;
  const slow = fakeGh(() => {
    if (killed++ === 0) throw Object.assign(new Error("Command failed: gh api graphql"), { killed: true, stderr: "" });
    return response([], []);
  });
  assert.equal((await searchAttentionPulls({ gh: slow.gh, cwd: "/tmp", retryDelayMs: 1 })).error, null);
  assert.equal(slow.calls.length, 2);

  // Still down after the retry: reported once, not retried forever.
  const down = fakeGh(() => { throw ghError("gh: HTTP 504 Gateway Timeout"); });
  assert.deepEqual(await searchAttentionPulls({ gh: down.gh, cwd: "/tmp", retryDelayMs: 1 }), failed("gh: HTTP 504 Gateway Timeout"));
  assert.equal(down.calls.length, 2);

  assert.equal(isTransientGhFailure(ghError("gh: HTTP 502")), true);
  assert.equal(isTransientGhFailure(ghError("Gateway Timeout")), true);
  assert.equal(isTransientGhFailure(ghError("gh: Something went wrong while executing your query. This may be the result of a timeout")), true);
  assert.equal(isTransientGhFailure(Object.assign(new Error("x"), { killed: true })), true);
  assert.equal(isTransientGhFailure(ghError("gh: API rate limit exceeded (HTTP 403)")), false);
  assert.equal(isTransientGhFailure(ghError("", "ENOENT")), false);
  assert.equal(isTransientGhFailure(ghError("To get started with GitHub CLI, please run:  gh auth login")), false);
});

test("attachLocalProjects matches ssh and https origins and worktrees on the head branch", async () => {
  const { gh } = fakeGh(() => response([
    node({ number: 1, headRefName: "feat/thing" }),
    node({ number: 2, url: "https://github.com/acme/app/pull/2", headRefName: "feat/other" }),
    node({ number: 3, url: "https://github.com/Acme/Lib/pull/3", repository: { nameWithOwner: "Acme/Lib" }, headRefName: "fix/y" }),
    node({ number: 4, url: "https://github.com/nobody/else/pull/4", repository: { nameWithOwner: "nobody/else" } }),
  ], []));
  const { pulls } = await searchAttentionPulls({ gh, cwd: "/tmp" });
  const projects = [
    { id: "app", path: "/p/app", remoteUrl: "git@github.com:acme/app.git" },
    { id: "app-dup", path: "/p/app2", remoteUrl: "ssh://git@github.com/acme/app" },
    { id: "app-wt", path: "/w/app/feat-thing", remoteUrl: "git@github.com:acme/app.git", worktree: { parentId: "app", branch: "feat/thing" } },
    { id: "app-wt-2", path: "/w/app/feat-thing-2", remoteUrl: "git@github.com:acme/app.git", worktree: { parentId: "app", branch: "feat/thing" } },
    { id: "app-wt-old", path: "/w/app/old", remoteUrl: "git@github.com:acme/app.git", worktree: { parentId: "app", branch: "feat/old" } },
    { id: "lib", path: "/p/lib", remoteUrl: "https://user:token@github.com/acme/lib/" },
    { id: "gitlab", path: "/p/gl", remoteUrl: "git@gitlab.com:acme/app.git" },
    { id: "noremote", path: "/p/none", remoteUrl: null },
  ];
  const attached = attachLocalProjects(pulls, projects);
  const byKey = Object.fromEntries(attached.map((pull) => [pullKey(pull), pull]));

  assert.deepEqual([byKey["acme/app#1"].localProjectId, byKey["acme/app#1"].worktreeProjectId], ["app", "app-wt"], "first match wins");
  assert.deepEqual([byKey["acme/app#2"].localProjectId, byKey["acme/app#2"].worktreeProjectId], ["app", null], "worktree on another branch is not it");
  assert.deepEqual([byKey["Acme/Lib#3"].localProjectId, byKey["Acme/Lib#3"].worktreeProjectId], ["lib", null], "case-insensitive, credentials and trailing slash ignored");
  assert.deepEqual([byKey["nobody/else#4"].localProjectId, byKey["nobody/else#4"].worktreeProjectId], [null, null]);

  assert.equal(pulls[0].localProjectId, null, "input pulls are not mutated");
  assert.notEqual(attached[0], pulls[0]);
  attached[0].roles.push("reviewer");
  assert.deepEqual(pulls[0].roles, ["author"], "roles arrays are copied too");
  assert.deepEqual(attachLocalProjects(pulls, []).map((pull) => pull.localProjectId), [null, null, null, null]);
});

test("readOriginUrl reads origin and is null without one or outside a repository", async (t) => {
  const root = tempRoot(t);
  const repo = path.join(root, "repo");
  git(root, ["init", "-q", repo]);
  assert.equal(await readOriginUrl(repo), null);
  git(repo, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
  assert.equal(await readOriginUrl(repo), "git@github.com:acme/app.git");
  const plain = path.join(root, "plain");
  mkdirSync(plain);
  assert.equal(await readOriginUrl(plain), null);
  assert.equal(await readOriginUrl(path.join(root, "missing")), null);
});

test("portalReposDir honours PORTAL_HOME", () => {
  const previous = process.env.PORTAL_HOME;
  try {
    delete process.env.PORTAL_HOME;
    assert.equal(portalReposDir("/home/x"), path.join("/home/x", ".portal", "repos"));
    process.env.PORTAL_HOME = "/custom";
    assert.equal(portalReposDir("/home/x"), path.join("/custom", "repos"));
  } finally {
    if (previous === undefined) delete process.env.PORTAL_HOME; else process.env.PORTAL_HOME = previous;
  }
});

test("cloneRepo clones into <reposDir>/<name>, creating the directory", async (t) => {
  const root = tempRoot(t);
  const reposDir = path.join(root, "home", "repos");
  const { gh, calls } = fakeGh((args) => {
    // Stand in for gh: the clone shows up as a git repository with the expected origin.
    const target = args[3];
    git(root, ["init", "-q", target]);
    git(target, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
    return { stdout: "", stderr: "" };
  });
  const dir = await cloneRepo({ repo: "acme/app", gh, reposDir });
  assert.equal(dir, path.join(reposDir, "app"));
  assert.ok(existsSync(path.join(dir, ".git")));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { args: ["repo", "clone", "acme/app", dir], cwd: reposDir });

  // A second call finds the clone and does not ask gh again.
  assert.equal(await cloneRepo({ repo: "acme/app", gh, reposDir }), dir);
  assert.equal(calls.length, 1);
});

test("cloneRepo reuses a matching checkout (ssh origin) and rejects anything else in the way", async (t) => {
  const root = tempRoot(t);
  const reposDir = path.join(root, "repos");
  const { gh, calls } = fakeGh(() => { throw new Error("gh should not be called"); });

  const app = path.join(reposDir, "app");
  git(root, ["init", "-q", app]);
  git(app, ["remote", "add", "origin", "git@github.com:ACME/App.git"]);
  assert.equal(await cloneRepo({ repo: "acme/app", gh, reposDir }), app, "the origin comparison ignores case");
  assert.equal(calls.length, 0);

  // Same folder name, different repository.
  await rejectsWith(cloneRepo({ repo: "other/app", gh, reposDir }), 409, /already exists but is a clone of https:\/\/github\.com\/ACME\/App, not other\/app/);

  // A repository without origin, a plain folder, and a file.
  const bare = path.join(reposDir, "bare");
  git(root, ["init", "-q", bare]);
  await rejectsWith(cloneRepo({ repo: "acme/bare", gh, reposDir }), 409, /already exists but is not a clone of acme\/bare/);
  mkdirSync(path.join(reposDir, "plain"));
  await rejectsWith(cloneRepo({ repo: "acme/plain", gh, reposDir }), 409, /already exists but is not a clone/);
  writeFileSync(path.join(reposDir, "file"), "x");
  await rejectsWith(cloneRepo({ repo: "acme/file", gh, reposDir }), 409, /already exists but is not a clone/);

  // Not owner/name at all.
  for (const repo of ["app", "acme/app/extra", "../x", "acme/..", "acme/ap p", "https://github.com/acme/app"]) {
    await rejectsWith(cloneRepo({ repo, gh, reposDir }), 400, /is not an owner\/name repository/);
  }
  assert.equal(calls.length, 0);
});

test("cloneRepo reports gh's refusal with a short reason", async (t) => {
  const root = tempRoot(t);
  const reposDir = path.join(root, "repos");
  const loggedOut = fakeGh(() => { throw ghError("To get started with GitHub CLI, please run:  gh auth login"); });
  await rejectsWith(cloneRepo({ repo: "acme/app", gh: loggedOut.gh, reposDir }), 409, /^Could not clone acme\/app: gh is not logged in$/);
  const notFound = fakeGh(() => { throw ghError("GraphQL: Could not resolve to a Repository with the name 'acme/app'. (repository)"); });
  await rejectsWith(cloneRepo({ repo: "acme/app", gh: notFound.gh, reposDir }), 409, /^Could not clone acme\/app: GraphQL: Could not resolve/);
  assert.ok(existsSync(reposDir), "the repos directory is created before cloning");
});

test("cloneRepo removes the half-clone a failed clone leaves behind, so the next call clones again", async (t) => {
  const root = tempRoot(t);
  const reposDir = path.join(root, "repos");
  const target = path.join(reposDir, "app");
  let failures = 0;
  const { gh, calls } = fakeGh((args) => {
    // git has already created the checkout and written origin when the fetch dies (here: a timeout).
    const dir = args[3];
    git(root, ["init", "-q", dir]);
    git(dir, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
    if (failures++ < 2) throw Object.assign(new Error("Command failed: gh repo clone"), { killed: true, stderr: "" });
    return { stdout: "", stderr: "" };
  });
  await rejectsWith(cloneRepo({ repo: "acme/app", gh, reposDir }), 409, /^Could not clone acme\/app: /);
  assert.ok(!existsSync(target), "the partial checkout is removed");
  assert.ok(existsSync(reposDir), "the repos directory stays");

  // A second failure is handled the same way, and a third attempt clones rather than reusing a half-clone.
  await rejectsWith(cloneRepo({ repo: "acme/app", gh, reposDir }), 409, /Could not clone/);
  assert.ok(!existsSync(target));
  assert.equal(await cloneRepo({ repo: "acme/app", gh, reposDir }), target);
  assert.equal(calls.length, 3, "every attempt asked gh; none returned the leftover");
  assert.ok(existsSync(path.join(target, ".git")));
});

test("attentionReasons and pullKey", () => {
  const base = {
    repo: "acme/app", number: 5, url: "https://github.com/acme/app/pull/5", title: "T", author: "moses-lee", roles: ["author"],
    state: "open", draft: false, baseBranch: "main", headBranch: "feat", checks: "passing", reviewDecision: null, mergeable: "mergeable",
    updatedAt: 0, localProjectId: null, worktreeProjectId: null,
  };
  assert.equal(pullKey(base), "acme/app#5");

  assert.deepEqual(attentionReasons(base), []);
  assert.deepEqual(attentionReasons({ ...base, checks: "failing" }), ["pr_checks_failing"]);
  assert.deepEqual(attentionReasons({ ...base, checks: "pending" }), []);
  assert.deepEqual(attentionReasons({ ...base, reviewDecision: "changes_requested" }), ["pr_changes_requested"]);
  assert.deepEqual(attentionReasons({ ...base, reviewDecision: "approved" }), []);
  assert.deepEqual(attentionReasons({ ...base, mergeable: "conflicting" }), ["pr_conflicts"]);
  assert.deepEqual(attentionReasons({ ...base, mergeable: "unknown" }), []);
  assert.deepEqual(
    attentionReasons({ ...base, checks: "failing", reviewDecision: "changes_requested", mergeable: "conflicting" }),
    ["pr_checks_failing", "pr_changes_requested", "pr_conflicts"],
  );
  assert.deepEqual(attentionReasons({ ...base, checks: "failing", draft: true }), ["pr_checks_failing"], "author reasons apply to drafts too");

  const theirs = { ...base, roles: ["reviewer"], author: "someone", checks: "failing", mergeable: "conflicting", reviewDecision: "changes_requested" };
  assert.deepEqual(attentionReasons(theirs), ["pr_review_requested"], "author-only reasons do not apply to a reviewer");
  assert.deepEqual(attentionReasons({ ...theirs, draft: true }), [], "drafts do not ask for review yet");
  assert.deepEqual(
    attentionReasons({ ...base, roles: ["author", "reviewer"], checks: "failing" }),
    ["pr_checks_failing", "pr_review_requested"],
  );
  assert.deepEqual(attentionReasons({ ...theirs, state: "merged" }), []);
  assert.deepEqual(attentionReasons({ ...base, checks: "failing", state: "closed" }), []);
});
