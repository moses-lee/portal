import assert from "node:assert/strict";
import test from "node:test";
import { sessionStates } from "@portal/shared/session-state";
import {
  MAIL_CAP,
  QUEUE_DRAWN,
  ROBOT_CAP,
  NEEDLE_ANGLES,
  backgroundRuns,
  barometerLevel,
  describeObject,
  hearthLevel,
  jarState,
  lampState,
  mailLabel,
  liveSummary,
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
  const crowd = placeRobots([session("a", "working", 1), session("b", "approval", 2), session("c", "finished", 3), session("d", "hung", 4)]);
  assert.deepEqual(
    crowd.robots.map(({ id, state, place }) => ({ id, state, place })),
    [
      { id: "a", state: "working", place: "bench" },
      { id: "b", state: "approval", place: "door" },
      { id: "d", state: "hung", place: "bench" },
    ],
  );
  assert.equal(crowd.total, 3);
  assert.equal(crowd.queued, 0);
  // Bench slots are distinct, and a newcomer does not move anyone already at the bench.
  const slots = crowd.robots.filter((robot) => robot.place === "bench").map((robot) => robot.slot);
  assert.equal(new Set(slots).size, slots.length);
  const later = placeRobots([session("a", "working", 1), session("b", "approval", 2), session("d", "hung", 4), session("e", "working", 5)]);
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
  monitoring: null,
  now: 0,
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

const GIB = 2 ** 30;
const now = Date.UTC(2026, 9, 21, 12);

/** A stream `monitoring` summary: 16 GB of RAM, 460 GB of disk. */
const reading = (overrides = {}) => ({
  at: now,
  pressure: "normal",
  memory: { usedBytes: 11.25 * GIB, totalBytes: 16 * GIB },
  swap: { usedBytes: 2.5 * GIB, totalBytes: 4 * GIB },
  disk: { path: "/Users/moses/.portal", freeBytes: 120e9, totalBytes: 460e9, level: "normal" },
  largest: [
    { label: "monorepo-a", path: "/w/a", bytes: 88e9 },
    { label: "monorepo-b", path: "/w/b", bytes: 41.2e9 },
    { label: "Database", path: null, bytes: 3.4e9 },
    { label: "/Users/moses/.codex", path: "/Users/moses/.codex", bytes: 2.1e9 },
    { label: "Portal images", path: "/p/blobs", bytes: 60e6 },
    { label: "Portal logs", path: "/p/logs", bytes: 2e6 },
  ],
  surveyedAt: now - 4 * 60_000,
  ...overrides,
});

test("the barometer's needle reads the memory pressure, and rests without a reading", () => {
  assert.equal(barometerLevel(null), null);
  assert.equal(barometerLevel(reading()), "normal");
  assert.equal(barometerLevel(reading({ pressure: "warning" })), "warning");
  assert.equal(barometerLevel(reading({ pressure: "critical" })), "critical");
  // Fair on the right, Change at the top, Stormy on the left; at rest straight down, off the scale.
  assert.ok(NEEDLE_ANGLES.normal > 0 && NEEDLE_ANGLES.warning === 0 && NEEDLE_ANGLES.critical < 0);
  assert.equal(NEEDLE_ANGLES.rest, Math.PI);
});

test("the jar fills to the used share of the disk, its lid the disk level; empty with no reading or no disk", () => {
  assert.deepEqual(jarState(null), { fill: null, lid: null });
  assert.deepEqual(jarState(reading()), { fill: 0.74, lid: "normal" });
  assert.deepEqual(jarState(reading({ disk: { path: "/", freeBytes: 12e9, totalBytes: 460e9, level: "critical" } })), { fill: 0.97, lid: "critical" });
  assert.deepEqual(jarState(reading({ disk: null })), { fill: null, lid: null });
  // Out-of-range readings stay in the jar.
  assert.deepEqual(jarState(reading({ disk: { path: "/", freeBytes: 500e9, totalBytes: 460e9, level: "normal" } })), { fill: 0, lid: "normal" });
});

test("the barometer's card: memory, swap and pressure, or that there is no reading yet; a click opens Monitoring", () => {
  const card = describeObject({ kind: "barometer", id: "barometer" }, { ...quiet, monitoring: reading({ pressure: "warning" }), now });
  assert.equal(card.title, "Barometer");
  assert.deepEqual(card.lines, ["Memory: 11 GB used of 16 GB", "Swap: 2.5 GB used of 4 GB", "Pressure: warning"]);
  assert.equal(card.hint, "Click to open Monitoring");
  assert.equal(card.action, "Open Monitoring");
  const noSwap = describeObject({ kind: "barometer", id: "barometer" }, { ...quiet, monitoring: reading({ swap: { usedBytes: 0, totalBytes: 0 } }), now });
  assert.equal(noSwap.lines[1], "Swap: none in use");
  const resting = describeObject({ kind: "barometer", id: "barometer" }, { ...quiet, now });
  assert.match(resting.lines[0], /^No reading yet/);
  assert.equal(resting.hint, "Click to open Monitoring");
});

test("the jar's card: free and total, the five largest items, when they were measured", () => {
  const card = describeObject({ kind: "jar", id: "jar" }, { ...quiet, monitoring: reading(), now });
  assert.equal(card.title, "Jar");
  assert.deepEqual(card.lines, [
    "120 GB free of 460 GB (74% used)",
    "monorepo-a: 88 GB",
    "monorepo-b: 41 GB",
    "Database: 3.4 GB",
    "/Users/moses/.codex: 2.1 GB",
    "Portal images: 60 MB",
    "Sizes measured 4 min ago",
  ]);
  assert.equal(card.hint, "Click to open Monitoring");
  const low = describeObject({ kind: "jar", id: "jar" }, {
    ...quiet,
    monitoring: reading({ disk: { path: "/", freeBytes: 20e9, totalBytes: 460e9, level: "warning" }, largest: [], surveyedAt: null }),
    now,
  });
  assert.deepEqual(low.lines, ["20 GB free of 460 GB (96% used)", "Below the warning level", "Folder sizes not measured yet"]);
  const unread = describeObject({ kind: "jar", id: "jar" }, { ...quiet, monitoring: reading({ disk: null, surveyedAt: now - 10_000 }), now });
  assert.equal(unread.lines[0], "The disk holding Portal's home could not be read");
  assert.equal(unread.lines.at(-1), "Sizes measured just now");
  assert.match(describeObject({ kind: "jar", id: "jar" }, { ...quiet, now }).lines[0], /^No reading yet/);
});

test("the data-room summary reports the barometer's level and the jar's fill and lid", () => {
  assert.deepEqual(liveSummary({ ...quiet, monitoring: reading({ pressure: "critical" }) }).barometer, "critical");
  assert.deepEqual(liveSummary({ ...quiet, monitoring: reading() }).jar, { fill: 0.74, lid: "normal" });
  const resting = liveSummary(quiet);
  assert.equal(resting.barometer, null);
  assert.deepEqual(resting.jar, { fill: null, lid: null });
});
