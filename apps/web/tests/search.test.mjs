import assert from "node:assert/strict";
import test from "node:test";
import {
  highlightRanges, isMacPlatform, matchProjects, matchSessions, mergePullHits, newestSessions, paletteShortcut,
  parseRecents, pruneRecents, pullLabel, rankScore, recentsAfterOpen, resolveRecents,
} from "../src/lib/search.ts";

const project = (id, name, extra = {}) => ({ id, name, displayPath: `~/repos/${name}`, path: `/r/${name}`, ...extra });
const session = (id, title, extra = {}) => ({
  id,
  title,
  projectId: "p1",
  project: { id: "p1", name: "portal" },
  agentName: "Claude Code",
  git: { branch: "main" },
  displayCwd: "~/repos/portal",
  lastActiveAt: 0,
  ...extra,
});

test("rankScore: title prefix over word start over substring", () => {
  assert.equal(rankScore("Fix login", [], "fix"), 3);
  assert.equal(rankScore("Please fix login", [], "fix"), 2);
  assert.equal(rankScore("Prefix login", [], "fix"), 1);
  assert.equal(rankScore("Something", ["feature/fix-login"], "fix"), 2);
  assert.equal(rankScore("Something", ["prefixed"], "fix"), 1);
  assert.equal(rankScore("Something", [null, undefined], "fix"), 0);
  assert.equal(rankScore("Anything", [], "  "), 0);
  assert.equal(rankScore("FIX", [], "fix"), 3);
});

test("matchSessions searches title, project, branch, agent, folder and ranks with recency ties", () => {
  const rows = [
    session("a", "Refactor the router", { lastActiveAt: 1 }),
    session("b", "Router cleanup", { lastActiveAt: 2 }),
    session("c", "Unrelated", { git: { branch: "feat/router" }, lastActiveAt: 3 }),
    session("d", "Also unrelated", { lastActiveAt: 4 }),
    session("e", "Nested routers", { lastActiveAt: 5 }),
  ];
  assert.deepEqual(matchSessions(rows, [], "router").map((row) => row.item.id), ["b", "e", "c", "a"]);
  assert.deepEqual(matchSessions(rows, [], "codex").map((row) => row.item.id), []);
  assert.deepEqual(matchSessions(rows, [], "claude").length, 5);
  assert.deepEqual(matchSessions(rows, [], "").length, 0);
  // An untitled session matches by its display title; the project name falls back to the project list.
  const untitled = session("u", null, { project: null, projectId: "p9", agentName: "x", displayCwd: "", git: null });
  assert.deepEqual(matchSessions([untitled], [], "new conv").map((row) => row.item.id), ["u"]);
  assert.deepEqual(matchSessions([untitled], [project("p9", "atlas")], "atlas").map((row) => row.item.id), ["u"]);
});

test("matchProjects searches name, path, worktree branch and caps", () => {
  const projects = [
    project("p1", "portal"),
    project("p2", "chat-ui", { worktree: { parentId: "p1", branch: "feature/portal-chat" } }),
    project("p3", "other", { displayPath: "~/work/portal-legacy" }),
    project("p4", "portal-docs"),
    project("p5", "notes"),
  ];
  assert.deepEqual(matchProjects(projects, "portal", 10).map((row) => row.item.id), ["p1", "p4", "p2", "p3"]);
  assert.equal(matchProjects(projects, "portal", 2).length, 2);
  assert.deepEqual(matchProjects(projects, "zzz"), []);
});

test("mergePullHits adds the PR to a local match, adds unmatched sessions, drops unknown ones, and caps", () => {
  const sessions = [
    session("a", "Fix 12 flaky tests", { lastActiveAt: 1 }),
    session("b", "Something", { lastActiveAt: 2 }),
    session("c", "Other", { lastActiveAt: 3 }),
  ];
  const local = matchSessions(sessions, [], "12");
  const pull = (sessionId, number, title) => ({
    sessionId, via: "branch", pull: { repo: "o/r", number, url: "u", ...(title ? { title } : {}) },
  });
  const merged = mergePullHits(local, [pull("a", 12, "Flaky"), pull("b", 12), pull("b", 12, "dup"), pull("gone", 12)], sessions);
  assert.deepEqual(merged.map((row) => [row.item.id, row.pull]), [
    ["b", { number: 12 }],
    ["a", { number: 12, title: "Flaky" }],
  ]);
  assert.equal(mergePullHits(local, [pull("b", 12), pull("c", 12)], sessions, 2).length, 2);
  // A local match that is also a PR hit ranks with the PR-only hits, not by its weaker local score.
  const both = mergePullHits(local, [pull("a", 12), pull("c", 12)], sessions);
  assert.equal(local[0].score, 2);
  assert.deepEqual(both.map((row) => [row.item.id, row.score]), [["c", 3], ["a", 3]]);
  assert.deepEqual(mergePullHits(local, [], sessions), local);
  assert.equal(pullLabel({ number: 3 }), "PR #3");
  assert.equal(pullLabel({ number: 3, title: "T" }), "PR #3 · T");
});

test("highlightRanges finds every case-insensitive occurrence", () => {
  assert.deepEqual(highlightRanges("Foo bar FOO", "foo"), [[0, 3], [8, 11]]);
  assert.deepEqual(highlightRanges("aaaa", "aa"), [[0, 2], [2, 4]]);
  assert.deepEqual(highlightRanges("abc", " "), []);
  assert.deepEqual(highlightRanges("abc", "x"), []);
});

test("newestSessions keeps the newest few in order", () => {
  const rows = [1, 5, 3, 9, 7].map((at) => session(`s${at}`, "t", { lastActiveAt: at }));
  assert.deepEqual(newestSessions(rows, 3).map((row) => row.id), ["s9", "s7", "s5"]);
});

test("recents: parse defensively, move to front, dedupe, cap, resolve what still exists", () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents("nope"), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.deepEqual(
    parseRecents('[{"kind":"session","id":"a","at":1},{"kind":"x","id":"b","at":2},{"kind":"project","id":"c"}]'),
    [{ kind: "session", id: "a", at: 1 }],
  );
  const list = [
    { kind: "session", id: "a", at: 1 },
    { kind: "project", id: "a", at: 2 },
  ];
  assert.deepEqual(recentsAfterOpen(list, { kind: "session", id: "a", at: 3 }), [
    { kind: "session", id: "a", at: 3 },
    { kind: "project", id: "a", at: 2 },
  ]);
  assert.deepEqual(list.length, 2);
  let many = [];
  for (let i = 0; i < 12; i++) many = recentsAfterOpen(many, { kind: "session", id: `s${i}`, at: i });
  assert.equal(many.length, 8);
  assert.equal(many[0].id, "s11");
  const resolved = resolveRecents(
    [{ kind: "session", id: "a", at: 1 }, { kind: "session", id: "gone", at: 1 }, { kind: "project", id: "p1", at: 1 }],
    [session("a", "A")],
    [project("p1", "portal")],
  );
  assert.deepEqual(resolved.map((entry) => entry.kind), ["session", "project"]);
  assert.deepEqual(
    pruneRecents(
      [{ kind: "session", id: "a", at: 1 }, { kind: "session", id: "gone", at: 1 }, { kind: "project", id: "a", at: 1 }],
      [session("a", "A")],
      [project("p1", "portal")],
    ),
    [{ kind: "session", id: "a", at: 1 }],
  );
});

test("paletteShortcut: ⌘K and ⌘J on a Mac, Ctrl+K and Ctrl+J elsewhere, nothing else", () => {
  const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(paletteShortcut(key("k", { metaKey: true }), true), "search");
  assert.equal(paletteShortcut(key("K", { metaKey: true }), true), "search");
  assert.equal(paletteShortcut(key("j", { metaKey: true }), true), "portal");
  assert.equal(paletteShortcut(key("k", { ctrlKey: true }), true), null);
  assert.equal(paletteShortcut(key("j", { ctrlKey: true }), true), null);
  assert.equal(paletteShortcut(key("k", { ctrlKey: true }), false), "search");
  assert.equal(paletteShortcut(key("j", { ctrlKey: true }), false), "portal");
  assert.equal(paletteShortcut(key("k", { metaKey: true }), false), null);
  assert.equal(paletteShortcut(key("k", { ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(paletteShortcut(key("j", { metaKey: true, altKey: true }), true), null);
  assert.equal(paletteShortcut(key("l", { ctrlKey: true }), false), null);
  assert.equal(paletteShortcut(key("k"), true), null);
  // A non-Latin layout: the K and J keys type other letters.
  assert.equal(paletteShortcut(key("л", { code: "KeyK", metaKey: true }), true), "search");
  assert.equal(paletteShortcut(key("о", { code: "KeyJ", metaKey: true }), true), "portal");
  assert.equal(paletteShortcut(key("л", { code: "KeyL", metaKey: true }), true), null);
  // A Latin layout goes by the letter: Dvorak's physical J key types "h".
  assert.equal(paletteShortcut(key("h", { code: "KeyJ", metaKey: true }), true), null);
  assert.equal(paletteShortcut(key("j", { code: "KeyC", metaKey: true }), true), "portal");
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("iPhone"), true);
  assert.equal(isMacPlatform("Win32"), false);
});
