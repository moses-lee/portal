import assert from "node:assert/strict";
import test from "node:test";
import { directionFrom, nextMinute, roomCoordinates, sceneForAltitude, skyColours, sunClock, sunThrough } from "../src/room/sun.ts";

const DEGREE = Math.PI / 180;
const newYork = { latitude: 40.71, longitude: -74.01 };

test("the scene is day from sunrise to sunset by the sun's altitude, not the clock", () => {
  assert.equal(sceneForAltitude(30 * DEGREE), "day");
  assert.equal(sceneForAltitude(0), "day");
  assert.equal(sceneForAltitude(-0.5 * DEGREE), "day");
  assert.equal(sceneForAltitude(-1 * DEGREE), "night");
  assert.equal(sceneForAltitude(-30 * DEGREE), "night");
  // Noon and 11pm in New York (EDT) on 2026-10-04.
  assert.equal(sceneForAltitude(sunClock(Date.UTC(2026, 9, 4, 16), newYork).sun.altitude), "day");
  assert.equal(sceneForAltitude(sunClock(Date.UTC(2026, 9, 5, 3), newYork).sun.altitude), "night");
  // The same instant is night on the other side of the world.
  assert.equal(sceneForAltitude(sunClock(Date.UTC(2026, 9, 4, 16), { latitude: 35.68, longitude: 139.69 }).sun.altitude), "night");
});

test("the sun clock reports suncalc's radians, the moon's phase, and the instant", () => {
  const at = Date.UTC(2026, 5, 21, 17);
  const clock = sunClock(at, newYork);
  assert.equal(clock.at, at);
  // Near the summer solstice at local solar noon the sun is ~73° up and close to due south.
  assert.ok(Math.abs(clock.sun.altitude / DEGREE - 72.7) < 1.5, `altitude ${clock.sun.altitude / DEGREE}`);
  assert.ok(Math.abs(clock.sun.azimuth) < 0.2, `azimuth ${clock.sun.azimuth}`);
  assert.ok(clock.moon.phase >= 0 && clock.moon.phase < 1);
  assert.ok(clock.moon.fraction >= 0 && clock.moon.fraction <= 1);
});

test("coordinates come from the environment, else the browser's zone, else Greenwich", () => {
  assert.deepEqual(roomCoordinates({ latitude: 1, longitude: 2 }, "Asia/Tokyo"), { latitude: 1, longitude: 2, source: "environment" });
  assert.deepEqual(roomCoordinates({ latitude: null, longitude: null }, "Asia/Tokyo"), { latitude: 35.68, longitude: 139.69, source: "zone" });
  assert.deepEqual(roomCoordinates(null, "Europe/London"), { latitude: 51.51, longitude: -0.13, source: "zone" });
  assert.equal(roomCoordinates(null, "UTC").source, "default");
  assert.equal(roomCoordinates(null, null).source, "default");
});

test("the clock ticks on minute boundaries", () => {
  assert.equal(nextMinute(Date.UTC(2026, 0, 1, 10, 0, 0)), Date.UTC(2026, 0, 1, 10, 1, 0));
  assert.equal(nextMinute(Date.UTC(2026, 0, 1, 10, 0, 59, 999)), Date.UTC(2026, 0, 1, 10, 1, 0));
});

test("light directions put the south-facing window at -z and west at +x", () => {
  const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${actual} vs ${expected}`));
  close(directionFrom(0, 0), [0, 0, -1]);
  close(directionFrom(0, Math.PI / 2), [1, 0, 0]);
  close(directionFrom(Math.PI / 2, 0), [0, 1, 0]);
});

test("the sky darkens through dusk and greys on bad weather", () => {
  const luma = (hex) => {
    const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const chroma = (hex) => {
    const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
    return Math.max(...channels) - Math.min(...channels);
  };
  let previous = Infinity;
  for (const degrees of [40, 20, 5, 0, -4, -10, -20]) {
    const { zenith } = skyColours(degrees * DEGREE);
    assert.match(zenith, /^#[0-9a-f]{6}$/);
    assert.ok(luma(zenith) <= previous, `zenith brightens at ${degrees}°`);
    previous = luma(zenith);
  }
  assert.deepEqual(skyColours(30 * DEGREE), skyColours(30 * DEGREE, "clear"));
  assert.ok(chroma(skyColours(30 * DEGREE, "overcast").zenith) < chroma(skyColours(30 * DEGREE, "clear").zenith));
  assert.equal(sunThrough("clear"), 1);
  assert.ok(sunThrough("thunderstorm") < sunThrough("partly-cloudy"));
});
