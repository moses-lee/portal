import assert from "node:assert/strict";
import test from "node:test";
import { sessionStates } from "@portal/shared/session-state";
import {
  MAIL_CAP,
  QUEUE_DRAWN,
  ROBOT_CAP,
  backgroundRuns,
  describeObject,
  hearthLevel,
  lampState,
  mailLabel,
  mailStack,
  placeRobots,
  robotLook,
  robotStateFor,
  robotsLabel,
} from "../src/room/live.ts";

const idle = { busy: false, awaitingPermission: false, link: { status: "live" }, liveness: "idle" };

/** A session's list entry in each of the shared session states. */
const inState = {
  approval: { ...idle, awaitingPermission: true },
  hung: { ...idle, busy: true, liveness: "hung" },
  offline: { ...idle, liveness: "dead" },
  connecting: { ...idle, link: { status: "connecting" } },
  working: { ...idle, busy: true, liveness: "busy" },
  background: { ...idle, liveness: "background" },
  finished: idle,
};

test("a robot stands for every session connecting, working, in the background, waiting on approval or hung, and no other", () => {
  // Every state the shared derivation knows is covered here.
  assert.deepEqual(Object.keys(inState).sort(), [...sessionStates].sort());
  assert.equal(robotStateFor(inState.approval), "approval");
  assert.equal(robotStateFor(inState.hung), "hung");
  assert.equal(robotStateFor(inState.connecting), "connecting");
  assert.equal(robotStateFor(inState.working), "working");
  assert.equal(robotStateFor(inState.background), "background");
  assert.equal(robotStateFor(inState.offline), null);
  assert.equal(robotStateFor(inState.finished), null);
  // A blocked liveness is an approval too; an offline link with an error is offline.
  assert.equal(robotStateFor({ ...idle, liveness: "blocked" }), "approval");
  assert.equal(robotStateFor({ ...idle, link: { status: "offline", error: "gone" } }), null);
  // An offline link without an error is a finished session (the agent is just not attached).
  assert.equal(robotStateFor({ ...idle, link: { status: "offline", error: null } }), null);
});

const session = (id, state, createdAt) => ({ id, title: `Session ${id}`, agentId: "claude", agentName: "Claude Code", createdAt, ...inState[state] });

test("approval robots stand by the door, the rest at the bench, and finished sessions have none", () => {
  const crowd = placeRobots([session("a", "working", 1), session("b", "approval", 2), session("c", "finished", 3), session("d", "hung", 4)], new Set(["d"]));
  assert.deepEqual(
    crowd.robots.map(({ id, state, place, tracked }) => ({ id, state, place, tracked })),
    [
      { id: "a", state: "working", place: "bench", tracked: false },
      { id: "b", state: "approval", place: "door", tracked: false },
      { id: "d", state: "hung", place: "bench", tracked: true },
    ],
  );
  assert.equal(crowd.total, 3);
  assert.equal(crowd.queued, 0);
  // Bench slots are distinct, and a newcomer does not move anyone already at the bench.
  const slots = crowd.robots.filter((robot) => robot.place === "bench").map((robot) => robot.slot);
  assert.equal(new Set(slots).size, slots.length);
  const later = placeRobots([session("a", "working", 1), session("b", "approval", 2), session("d", "hung", 4), session("e", "working", 5)], new Set(["d"]));
  for (const robot of crowd.robots) assert.equal(later.robots.find((each) => each.id === robot.id).slot, robot.slot);
});

test("past eight robots the rest queue by the door, the first few drawn, and the hover card gives the count", () => {
  const sessions = Array.from({ length: 14 }, (_, index) => session(`s${String(index).padStart(2, "0")}`, "working", index));
  const crowd = placeRobots(sessions);
  assert.equal(crowd.total, 14);
  assert.equal(crowd.queued, 14 - ROBOT_CAP);
  assert.equal(crowd.robots.filter((robot) => robot.place === "bench").length, ROBOT_CAP);
  assert.equal(crowd.robots.filter((robot) => robot.place === "queue").length, QUEUE_DRAWN);
  // Oldest first: the newest sessions are the ones waiting.
  assert.deepEqual(
    crowd.robots.filter((robot) => robot.place === "queue").map((robot) => robot.id),
    ["s08", "s09", "s10", "s11"],
  );
  assert.equal(robotsLabel(14), "8 sessions in the room, 6 more queued by the door");
  assert.equal(robotsLabel(8), "8 active sessions in the room");
  assert.equal(robotsLabel(1), "1 active session in the room");
  const card = describeObject({ kind: "robot", id: "s09" }, { ...quiet, crowd });
  assert.equal(card.title, "Session s09");
  assert.ok(card.lines.includes("Queued by the door: the room holds eight"));
  assert.ok(card.lines.includes("8 sessions in the room, 6 more queued by the door"));
  assert.equal(card.hint, "Click to open the session");
});

test("a robot's looks come from its session id alone", () => {
  assert.deepEqual(robotLook("s1"), robotLook("s1"));
  const heads = new Set(Array.from({ length: 40 }, (_, index) => robotLook(`session-${index}`).head));
  assert.deepEqual([...heads].sort(), [0, 1, 2]);
});

const quiet = {
  crowd: { robots: [], total: 0, queued: 0 },
  needsYou: 0,
  approvals: 0,
  activityLastHour: 0,
  runs: [],
  busy: false,
  lamp: "dim",
  weather: null,
};

test("the mail tray stacks up to twelve envelopes, sealed ones for approvals, then a pile with a number", () => {
  assert.deepEqual(mailStack(3, 2), { sealed: 2, open: 3, pile: 0 });
  assert.deepEqual(mailStack(10, 5), { sealed: 5, open: 7, pile: 3 });
  assert.deepEqual(mailStack(0, 20), { sealed: MAIL_CAP, open: 0, pile: 8 });
  assert.deepEqual(mailLabel(1, 0), ["1 item needs you", "0 approvals wait (sealed)"]);
  assert.deepEqual(mailLabel(15, 2), ["15 items need you", "2 approvals wait (sealed)", "12 in the tray and a pile of 5 more"]);
  const card = describeObject({ kind: "mail", id: "mail" }, { ...quiet, needsYou: 15, approvals: 2 });
  assert.equal(card.title, "Mail tray");
  assert.equal(card.hint, "Click to open Needs you");
  assert.equal(card.action, "Open Needs you");
});

test("the hearth is cold under 3 entries an hour, embers to 20, a fire past that", () => {
  assert.equal(hearthLevel(0), "cold");
  assert.equal(hearthLevel(2), "cold");
  assert.equal(hearthLevel(3), "embers");
  assert.equal(hearthLevel(20), "embers");
  assert.equal(hearthLevel(21), "fire");
  assert.deepEqual(describeObject({ kind: "hearth", id: "hearth" }, { ...quiet, activityLastHour: 1 }).lines, ["1 entry", "Cold (under 3)"]);
});

test("the lamp is on during a turn, dim when idle, and off at night only after an idle hour", () => {
  const now = Date.UTC(2026, 9, 9, 23);
  assert.equal(lampState({ busy: true, night: true, idleSince: now - 3 * 3600_000, now }), "on");
  assert.equal(lampState({ busy: false, night: false, idleSince: now - 3 * 3600_000, now }), "dim");
  assert.equal(lampState({ busy: false, night: true, idleSince: now - 59 * 60_000, now }), "dim");
  assert.equal(lampState({ busy: false, night: true, idleSince: now - 60 * 60_000, now }), "off");
});

test("the kettle steams for background job runs, not chat turns", () => {
  const runs = [
    { id: "r1", kind: "chat", summary: null },
    { id: "r2", kind: "consolidate", summary: null },
  ];
  assert.deepEqual(backgroundRuns(runs).map((run) => run.id), ["r2"]);
  assert.deepEqual(backgroundRuns([runs[0]]), []);
  const card = describeObject({ kind: "kettle", id: "kettle" }, { ...quiet, runs });
  assert.deepEqual(card.lines, ["Steaming: 1 job running", "memory curation"]);
  assert.equal(card.hint, "Click to open the jobs");
});

test("the window's card is the weather and its source, with nowhere to go", () => {
  const weather = { code: 61, condition: "rain", isDay: true, cloudCover: 90, precipitation: 1, temperature: 12.6, fetchedAt: 0 };
  const card = describeObject({ kind: "window", id: "window" }, { ...quiet, weather });
  assert.deepEqual(card.lines, ["Rain, 13°C", "Day"]);
  assert.equal(card.hint, null);
  assert.equal(card.action, null);
  assert.equal(card.credit, true);
});
