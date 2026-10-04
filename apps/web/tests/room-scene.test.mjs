import assert from "node:assert/strict";
import test from "node:test";
import { decorForSession, parseRoomMode, roomForLocalHour } from "../src/lib/room-scene.ts";

test("the local room changes at 7am and 7pm", () => {
  assert.equal(roomForLocalHour(6), "study");
  assert.equal(roomForLocalHour(7), "garden");
  assert.equal(roomForLocalHour(18), "garden");
  assert.equal(roomForLocalHour(19), "study");
});

test("room mode accepts explicit choices and falls back to the clock", () => {
  assert.equal(parseRoomMode("light"), "light");
  assert.equal(parseRoomMode("dark"), "dark");
  assert.equal(parseRoomMode("system"), "system");
  assert.equal(parseRoomMode("unknown"), "system");
});

test("session decor is deterministic and independent of time of day", () => {
  const first = decorForSession("session-7");
  assert.equal(decorForSession("session-7"), first);
  assert.notEqual(decorForSession("session-8"), first);
  assert.equal(decorForSession(null), "olive");
});
