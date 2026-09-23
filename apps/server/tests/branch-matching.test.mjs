import assert from "node:assert/strict";
import test from "node:test";
import {
  isProbablyRefName,
  isPullNumberQuery,
  plannedWorktreePath,
  rankPickerRows,
  sanitizeBranchForPath,
  shortenHome,
  worktreeTarget,
} from "../src/lib/branch-matching.ts";

function branch(name, committedAt = 0, extra = {}) {
  return { name, local: true, remote: false, committedAt, worktreePath: null, ...extra };
}

function pull(number, branch, title = `PR ${number}`, extra = {}) {
  return { number, title, branch, state: "open", updatedAt: number, fork: false, ...extra };
}

function listing(overrides = {}) {
  return { defaultBranch: "main", branches: [], pulls: [], pullsError: null, ...overrides };
}

const kinds = (rows) => rows.map((row) => row.kind);
const names = (rows) => rows.map((row) => (
  row.kind === "pull" ? `#${row.pull.number}` : row.kind === "branch" ? row.branch.name : row.kind === "create" ? `+${row.name}` : "original"
));

test("empty query: Original, open PRs by updatedAt, then recent branches not shown via a PR", () => {
  const rows = rankPickerRows(listing({
    pulls: [pull(1, "feat/a"), pull(3, "feat/c"), pull(2, "feat/b")],
    branches: [branch("feat/a", 50), branch("old", 10), branch("new", 90)],
  }), "", null, { canCreate: true });
  assert.deepEqual(names(rows), ["original", "#3", "#2", "#1", "new", "old"]);
});

test("empty query caps each section at 10", () => {
  const pulls = Array.from({ length: 15 }, (_, i) => pull(i + 1, `pr-${i + 1}`));
  const branches = Array.from({ length: 15 }, (_, i) => branch(`b-${i}`, i));
  const rows = rankPickerRows(listing({ pulls, branches }), "  ", null, { canCreate: true });
  assert.equal(rows.filter((r) => r.kind === "pull").length, 10);
  assert.equal(rows.filter((r) => r.kind === "branch").length, 10);
  assert.equal(rows[0].kind, "original");
  assert.equal(rows.at(-1).branch.name, "b-5");
  assert.ok(!rows.some((r) => r.kind === "create"));
});

test("empty query with a null listing is just Original", () => {
  assert.deepEqual(kinds(rankPickerRows(null, "", null, { canCreate: true })), ["original"]);
  assert.deepEqual(kinds(rankPickerRows(listing({ pulls: null, pullsError: "gh is not installed" }), "", null, { canCreate: true })), ["original"]);
});

test("non-empty query: no Original row; prefix matches before substring, PRs before branches within a tier", () => {
  const rows = rankPickerRows(listing({
    pulls: [pull(10, "x/other", "The login flow fix"), pull(11, "fix/logout", "Something else")],
    branches: [branch("hotfix/login"), branch("fix/typo"), branch("unrelated")],
  }), "fix", null, { canCreate: false });
  assert.deepEqual(names(rows), ["#11", "fix/typo", "#10", "hotfix/login"]);
});

test("matching is case-insensitive and trims the query", () => {
  const rows = rankPickerRows(listing({ branches: [branch("Feat/Login")] }), "  feat/LOG ", null, { canCreate: false });
  assert.deepEqual(names(rows), ["Feat/Login"]);
});

test("pull rows match on #number, number, title, and branch name", () => {
  const l = listing({ pulls: [pull(42, "feat/answer", "Deep thought")] });
  for (const q of ["#42", "42", "deep", "feat/ans", "thought"]) {
    assert.deepEqual(names(rankPickerRows(l, q, null, { canCreate: false })), [`#42`], q);
  }
  assert.deepEqual(names(rankPickerRows(l, "99", null, { canCreate: false })), []);
});

test("a branch shown through a matching PR is not listed twice", () => {
  const rows = rankPickerRows(listing({
    pulls: [pull(5, "feat/x", "Title")],
    branches: [branch("feat/x"), branch("feat/y")],
  }), "feat", null, { canCreate: false });
  assert.deepEqual(names(rows), ["#5", "feat/y"]);
});

test("a looked-up PR is pinned first and replaces the listing's copy", () => {
  const listed = pull(7, "feat/seven", "Listed copy");
  const fresh = pull(7, "feat/seven", "Fresh copy");
  const rows = rankPickerRows(listing({ pulls: [pull(70, "feat/seventy"), listed], branches: [branch("feat/seven")] }), "7", fresh, { canCreate: true });
  assert.deepEqual(names(rows), ["#7", "#70"]);
  assert.equal(rows[0].pull.title, "Fresh copy");
  assert.deepEqual(names(rankPickerRows(listing(), "#7", fresh, { canCreate: true })), ["#7"]);
});

test("a looked-up PR for another number is ignored", () => {
  const rows = rankPickerRows(listing(), "8", pull(7, "feat/seven"), { canCreate: true });
  assert.deepEqual(names(rows), ["+8"]);
});

test("create row comes last when allowed and nothing matches exactly", () => {
  const l = listing({ branches: [branch("feat/login-form")], pulls: [pull(1, "feat/login-page")] });
  assert.deepEqual(names(rankPickerRows(l, "feat/login", null, { canCreate: true })), ["#1", "feat/login-form", "+feat/login"]);
  assert.deepEqual(names(rankPickerRows(l, "feat/login", null, { canCreate: false })), ["#1", "feat/login-form"]);
});

test("no create row for an exact branch name, an exact PR branch, or the default branch", () => {
  const l = listing({ branches: [branch("feat/a")], pulls: [pull(1, "feat/b")] });
  assert.deepEqual(names(rankPickerRows(l, "feat/a", null, { canCreate: true })), ["feat/a"]);
  assert.deepEqual(names(rankPickerRows(l, "feat/b", null, { canCreate: true })), ["#1"]);
  assert.deepEqual(names(rankPickerRows(l, "main", null, { canCreate: true })), []);
  // Exact match is case-sensitive: git branch names are.
  assert.deepEqual(names(rankPickerRows(l, "Feat/A", null, { canCreate: true })), ["feat/a", "+Feat/A"]);
});

test("create row waits while a PR lookup is pending", () => {
  assert.deepEqual(names(rankPickerRows(listing(), "123", null, { canCreate: true, pullLookupPending: true })), []);
  assert.deepEqual(names(rankPickerRows(listing(), "123", null, { canCreate: true, pullLookupPending: false })), ["+123"]);
});

test("does not mutate the listing", () => {
  const l = listing({ pulls: [pull(1, "a"), pull(2, "b")], branches: [branch("x", 1), branch("y", 2)] });
  rankPickerRows(l, "", null, { canCreate: true });
  assert.deepEqual(l.pulls.map((p) => p.number), [1, 2]);
  assert.deepEqual(l.branches.map((b) => b.name), ["x", "y"]);
});

test("isPullNumberQuery accepts digits only", () => {
  assert.equal(isPullNumberQuery("123"), true);
  assert.equal(isPullNumberQuery(" 7 "), true);
  assert.equal(isPullNumberQuery("#7"), false);
  assert.equal(isPullNumberQuery(""), false);
  assert.equal(isPullNumberQuery("12a"), false);
});

test("isProbablyRefName rejects what git check-ref-format rejects", () => {
  for (const ok of ["main", "feat/foo", "fix-123", "a.b", "release/v1.2.3", "123", "feat_x"]) assert.equal(isProbablyRefName(ok), true, ok);
  for (const bad of ["", "has space", "a..b", "-lead", "trail/", "x.lock", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "@", "/lead", "a//b", ".hidden", "trail.", "tab\tbed"]) {
    assert.equal(isProbablyRefName(bad), false, JSON.stringify(bad));
  }
});

test("sanitizeBranchForPath replaces slashes and unusual characters with dashes", () => {
  assert.equal(sanitizeBranchForPath("feat/foo"), "feat-foo");
  assert.equal(sanitizeBranchForPath("a b@c#d"), "a-b-c-d");
  assert.equal(sanitizeBranchForPath("release-1.2_x"), "release-1.2_x");
  assert.equal(sanitizeBranchForPath("ünï"), "-n-");
});

test("plannedWorktreePath lives under ~/.portal/worktrees/<repo>/<sanitized>", () => {
  assert.equal(plannedWorktreePath("/Users/me/repos/portal", "feat/foo"), "~/.portal/worktrees/portal/feat-foo");
  assert.equal(plannedWorktreePath("/srv/app/", "x"), "~/.portal/worktrees/app/x");
  assert.equal(plannedWorktreePath("/srv/app", "x", "/opt/portal/worktrees/app"), "/opt/portal/worktrees/app/x");
  // From a worktree the root's name is the branch folder, so the server-provided folder wins.
  assert.equal(plannedWorktreePath("/srv/worktrees/app/feat-y", "x", "/opt/portal/worktrees/app"), "/opt/portal/worktrees/app/x");
});

test("shortenHome uses the home folder implied by a project's display path", () => {
  const sample = { path: "/Users/me/repos/portal", displayPath: "~/repos/portal" };
  assert.equal(shortenHome("/Users/me/.portal/worktrees/portal/x", sample), "~/.portal/worktrees/portal/x");
  assert.equal(shortenHome("/Users/me", sample), "~");
  assert.equal(shortenHome("/Users/meow/x", sample), "/Users/meow/x");
  assert.equal(shortenHome("/srv/x", { path: "/srv/app", displayPath: "/srv/app" }), "/srv/x");
});

test("worktreeTarget: planned path for new or unchecked-out branches, existing path when known, subfolder kept", () => {
  const git = { root: "/Users/me/repos/portal", displayRoot: "~/repos/portal", branch: "main", detached: false };
  const project = { path: "/Users/me/repos/portal", displayPath: "~/repos/portal", git };
  assert.equal(worktreeTarget(project, { kind: "original" }), null);
  assert.deepEqual(worktreeTarget(project, { kind: "create", branch: "feat/x" }), { displayPath: "~/.portal/worktrees/portal/feat-x", branch: "feat/x" });
  assert.deepEqual(worktreeTarget(project, { kind: "branch", branch: "feat/x" }), { displayPath: "~/.portal/worktrees/portal/feat-x", branch: "feat/x" });
  assert.deepEqual(
    worktreeTarget(project, { kind: "create", branch: "feat/x", repoWorktreesDir: "/srv/portal/worktrees/portal" }),
    { displayPath: "/srv/portal/worktrees/portal/feat-x", branch: "feat/x" },
  );
  assert.deepEqual(
    worktreeTarget(project, { kind: "branch", branch: "feat/x", path: "/Users/me/elsewhere/x" }),
    { displayPath: "~/elsewhere/x", branch: "feat/x" },
  );
  const sub = { path: "/Users/me/repos/portal/packages/web", displayPath: "~/repos/portal/packages/web", git };
  assert.deepEqual(worktreeTarget(sub, { kind: "create", branch: "b" }), { displayPath: "~/.portal/worktrees/portal/b/packages/web", branch: "b" });
  assert.equal(worktreeTarget({ ...project, git: null }, { kind: "create", branch: "b" }), null);
});
