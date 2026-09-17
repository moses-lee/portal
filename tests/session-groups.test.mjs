import assert from "node:assert/strict";
import test from "node:test";
import { groupSessionsByProject } from "../src/lib/session-groups.ts";

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
