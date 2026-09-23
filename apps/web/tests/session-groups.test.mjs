import assert from "node:assert/strict";
import test from "node:test";
import { capSessions, groupSessionsByProject, orderProjectsByActivity } from "../src/lib/session-groups.ts";

function project(id, createdAt = 0) {
  return { id, name: id, path: `/repos/${id}`, createdAt };
}

function session(id, projectId, createdAt) {
  return {
    id,
    agentId: "a",
    agentName: "Agent",
    cwd: `/repos/${projectId}`,
    displayCwd: `~/repos/${projectId}`,
    projectId,
    createdAt,
    lastActiveAt: createdAt,
    title: null,
    busy: false,
    awaitingPermission: false,
    link: { status: "live" },
    state: { modes: null, configOptions: [], commands: [] },
    git: null,
    project: null,
    cwdMissing: false,
  };
}

test("every project gets a group in project order, even with no sessions", () => {
  const groups = groupSessionsByProject([project("a"), project("b"), project("c")], [session("s1", "b", 1)]);
  assert.deepEqual(groups.map((g) => g.project?.id), ["a", "b", "c"]);
  assert.deepEqual(groups.map((g) => g.sessions.map((s) => s.id)), [[], ["s1"], []]);
});

test("sessions within a group are most recently active first", () => {
  const groups = groupSessionsByProject([project("a")], [
    session("old", "a", 1),
    session("newest", "a", 3),
    session("mid", "a", 2),
  ]);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["newest", "mid", "old"]);
  const revived = { ...session("old", "a", 1), lastActiveAt: 10 };
  const active = groupSessionsByProject([project("a")], [revived, session("newest", "a", 3)]);
  assert.deepEqual(active[0].sessions.map((s) => s.id), ["old", "newest"]);
});

test("sessions with an unknown projectId go to a trailing null group", () => {
  const groups = groupSessionsByProject([project("b"), project("a")], [
    session("orphan-old", "gone", 1),
    session("kept", "a", 2),
    session("orphan-new", "", 3),
  ]);
  assert.deepEqual(groups.map((g) => g.project?.id ?? null), ["b", "a", null]);
  assert.deepEqual(groups.at(-1).sessions.map((s) => s.id), ["orphan-new", "orphan-old"]);
});

test("the null group is omitted when empty", () => {
  assert.deepEqual(groupSessionsByProject([project("a")], [session("s", "a", 1)]).map((g) => g.project?.id), ["a"]);
  assert.deepEqual(groupSessionsByProject([], []), []);
  const onlyOrphans = groupSessionsByProject([], [session("s", "gone", 1)]);
  assert.equal(onlyOrphans.length, 1);
  assert.equal(onlyOrphans[0].project, null);
});

test("does not mutate its inputs", () => {
  const sessions = [session("a1", "a", 1), session("a2", "a", 2)];
  const projects = [project("a")];
  groupSessionsByProject(projects, sessions);
  assert.deepEqual(sessions.map((s) => s.id), ["a1", "a2"]);
  assert.equal(projects.length, 1);
});

test("pinned sessions lead their group, each part most recently active first", () => {
  const groups = groupSessionsByProject([project("a")], [
    session("old-pinned", "a", 1),
    session("newest", "a", 4),
    session("new-pinned", "a", 3),
    session("mid", "a", 2),
    session("orphan-pinned", "gone", 1),
    session("orphan", "gone", 5),
  ], { "old-pinned": 100, "new-pinned": 50, "orphan-pinned": 10 });
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["new-pinned", "old-pinned", "newest", "mid"]);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ["orphan-pinned", "orphan"]);
});

test("orderProjectsByActivity puts the most recently worked in project first", () => {
  const projects = [project("a", 1), project("b", 2), project("c", 3)];
  const sessions = [session("s1", "a", 50), session("s2", "b", 10), session("s3", "a", 20)];
  assert.deepEqual(orderProjectsByActivity(projects, sessions).map((p) => p.id), ["a", "b", "c"]);
});

test("orderProjectsByActivity ranks a session-less project by its own createdAt", () => {
  // "fresh" was added moments ago and outranks a project last worked in long before it.
  const projects = [project("stale", 1), project("fresh", 100)];
  const sessions = [session("s1", "stale", 40)];
  assert.deepEqual(orderProjectsByActivity(projects, sessions).map((p) => p.id), ["fresh", "stale"]);
  // Once work happens in "stale" again it comes back to the top.
  assert.deepEqual(
    orderProjectsByActivity(projects, [...sessions, session("s2", "stale", 200)]).map((p) => p.id),
    ["stale", "fresh"],
  );
});

test("orderProjectsByActivity ranks a project by its newest session even when it was added later", () => {
  // "fresh" was added after "other" was last worked in, but owns only an older session. Ranking on
  // the newest of the two keeps it on top; falling back to the session alone would sink it.
  const projects = [project("fresh", 100), project("other", 1)];
  const sessions = [session("s1", "fresh", 40), session("s2", "other", 60)];
  assert.deepEqual(orderProjectsByActivity(projects, sessions).map((p) => p.id), ["fresh", "other"]);
});

test("orderProjectsByActivity breaks equal ranks on createdAt, newest first, and does not mutate its input", () => {
  // Both rank 10: "a" through its session, "b" through being added at the same moment.
  const projects = [project("a", 1), project("b", 10)];
  const frozen = [...projects];
  assert.deepEqual(
    orderProjectsByActivity(projects, [session("s1", "a", 10)]).map((p) => p.id),
    ["b", "a"],
  );
  assert.deepEqual(orderProjectsByActivity(projects, []).map((p) => p.id), ["b", "a"]);
  assert.deepEqual(projects, frozen);
});

test("capSessions keeps the first few unpinned sessions", () => {
  const rows = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((id, i) => session(id, "a", 100 - i));
  assert.deepEqual(capSessions(rows, {}, null).map((s) => s.id), ["s1", "s2", "s3", "s4", "s5"]);
  assert.deepEqual(capSessions(rows, {}, null, 2).map((s) => s.id), ["s1", "s2"]);
  // Nothing to hide: the list comes back whole.
  assert.deepEqual(capSessions(rows.slice(0, 3), {}, null).map((s) => s.id), ["s1", "s2", "s3"]);
});

test("capSessions always shows pinned sessions and caps only the unpinned tail", () => {
  const rows = ["p1", "p2", "p3", "p4", "p5", "p6", "s1", "s2"].map((id, i) => session(id, "a", 100 - i));
  const pins = Object.fromEntries(["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => [id, 1]));
  assert.deepEqual(
    capSessions(rows, pins, null, 1).map((s) => s.id),
    ["p1", "p2", "p3", "p4", "p5", "p6", "s1"],
  );
});

test("capSessions keeps the open session visible past the cap, in its sorted position", () => {
  const rows = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"].map((id, i) => session(id, "a", 100 - i));
  assert.deepEqual(capSessions(rows, {}, "s7").map((s) => s.id), ["s1", "s2", "s3", "s4", "s5", "s7"]);
  // An open session already within the cap does not buy an extra row.
  assert.deepEqual(capSessions(rows, {}, "s3").map((s) => s.id), ["s1", "s2", "s3", "s4", "s5"]);
});
