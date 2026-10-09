import assert from "node:assert/strict";
import test from "node:test";
import {
  LAYOUT_VERSION,
  MILESTONES,
  assignSlots,
  bucket,
  hashId,
  kelvinToRgb,
  latitudeForTimeZone,
  milestonesReached,
  mulberry32,
  slotFor,
  sunRamp,
  weatherCondition,
} from "../src/room.ts";

const rad = (degrees) => (degrees * Math.PI) / 180;

test("weatherCondition maps WMO codes onto the window's conditions; unknown codes are clear", () => {
  const cases = {
    0: "clear", 1: "partly-cloudy", 2: "partly-cloudy", 3: "overcast", 45: "fog", 48: "fog",
    51: "drizzle", 55: "drizzle", 57: "drizzle", 61: "rain", 63: "rain", 80: "rain", 65: "heavy-rain", 67: "heavy-rain", 82: "heavy-rain",
    71: "snow", 75: "snow", 77: "snow", 86: "snow", 95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm", 42: "clear", [-1]: "clear",
  };
  for (const [code, condition] of Object.entries(cases)) assert.equal(weatherCondition(Number(code)), condition, `code ${code}`);
});

test("sunRamp: intensities never fall as the sun rises, the colour warms toward the horizon, and night is the moon", () => {
  let previous = null;
  for (let degrees = -30; degrees <= 90; degrees += 0.5) {
    const ramp = sunRamp(rad(degrees));
    if (previous) {
      for (const key of ["sun", "sky", "ground"]) assert.ok(ramp[key] >= previous.ramp[key] - 1e-12, `${key} at ${degrees}°`);
      if (degrees > 0) assert.ok(ramp.kelvin >= previous.ramp.kelvin - 1e-9, `kelvin at ${degrees}°`);
    }
    for (const key of ["sun", "sky", "ground"]) assert.ok(ramp[key] >= 0 && ramp[key] <= 1);
    previous = { ramp };
  }
  assert.ok(Math.abs(sunRamp(0).kelvin - 2200) < 1, "about 2200 K at the horizon");
  assert.ok(Math.abs(sunRamp(rad(60)).kelvin - 5800) < 1, "about 5800 K high");
  const night = sunRamp(rad(-20));
  assert.equal(night.moon, true);
  assert.equal(sunRamp(rad(10)).moon, false);
  assert.ok(night.sun < 0.1, "the moon is dim");
  assert.ok(night.kelvin > 5800, "the moon is cool");
});

test("kelvinToRgb follows the Tanner Helland ramp in 0..1", () => {
  const warm = kelvinToRgb(2200);
  const white = kelvinToRgb(6600);
  const cool = kelvinToRgb(10000);
  assert.equal(warm.r, 1);
  assert.ok(warm.b < warm.g && warm.g < warm.r, "warm light is orange");
  for (const value of Object.values(white)) assert.ok(value > 0.95, "6600 K is near white");
  assert.equal(cool.b, 1);
  assert.ok(cool.r < 1, "cool light is blue");
  assert.equal(kelvinToRgb(1500).b, 0, "below 1900 K there is no blue");
});

test("hashId and mulberry32 are deterministic and spread", () => {
  assert.equal(hashId("session-1"), hashId("session-1"));
  assert.notEqual(hashId("session-1"), hashId("session-2"));
  assert.notEqual(hashId("a", 1), hashId("a", 2));
  assert.ok(Number.isSafeInteger(hashId("anything")) && hashId("anything") >= 0);
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seq = Array.from({ length: 20 }, () => a());
  assert.deepEqual(Array.from({ length: 20 }, () => b()), seq);
  assert.ok(seq.every((value) => value >= 0 && value < 1));
  assert.notDeepEqual(Array.from({ length: 20 }, mulberry32(43)), seq);
  const buckets = new Array(10).fill(0);
  const rng = mulberry32(7);
  for (let i = 0; i < 10_000; i++) buckets[Math.floor(rng() * 10)] += 1;
  assert.ok(buckets.every((count) => count > 800 && count < 1200), "roughly uniform");
});

test("slotFor walks past taken slots, wraps, and answers -1 when full", () => {
  const capacity = 5;
  const home = hashId("x") % capacity;
  assert.equal(slotFor("x", capacity, new Set()), home);
  assert.equal(slotFor("x", capacity, new Set([home])), (home + 1) % capacity);
  assert.equal(slotFor("x", capacity, new Set([home, (home + 1) % capacity])), (home + 2) % capacity);
  assert.equal(slotFor("x", capacity, new Set([0, 1, 2, 3, 4])), -1);
  assert.equal(slotFor("x", 0, new Set()), -1);
});

test("slots are stable over 200 seeds: arrivals never move anyone, and a removal moves only items that walked past it", () => {
  for (let seed = 0; seed < 200; seed++) {
    const rng = mulberry32(seed);
    const capacity = 4 + Math.floor(rng() * 30);
    const count = Math.floor(rng() * (capacity + 4));
    const ids = Array.from({ length: count }, (_, i) => `item-${seed}-${i}-${Math.floor(rng() * 1e9)}`);
    const slots = assignSlots(ids, capacity);
    assert.equal(new Set(slots.filter((slot) => slot >= 0)).size, slots.filter((slot) => slot >= 0).length, "no two items share a slot");
    assert.equal(slots.filter((slot) => slot >= 0).length, Math.min(count, capacity));

    // Adding one item never moves another.
    const added = assignSlots([...ids, `new-${seed}`], capacity);
    assert.deepEqual(added.slice(0, count), slots, `seed ${seed}: an arrival moved an item`);

    if (count === 0) continue;
    // Removing one: everyone before it stays, and so does everyone after it who sits in its own home slot.
    const removed = Math.floor(rng() * count);
    const after = assignSlots(ids.filter((_, i) => i !== removed), capacity);
    const kept = slots.filter((_, i) => i !== removed);
    for (let i = 0; i < kept.length; i++) {
      const original = i < removed ? i : i + 1;
      const atHome = slots[original] === hashId(ids[original]) % capacity;
      if (i < removed || atHome) assert.equal(after[i], kept[i], `seed ${seed}: removing ${removed} moved ${original}`);
    }
    // Removing the newest never moves anyone.
    assert.deepEqual(assignSlots(ids.slice(0, -1), capacity), slots.slice(0, -1));
  }
});

test("bucket shows up to the cap and counts the rest", () => {
  assert.deepEqual(bucket(0, 6), { shown: 0, extra: 0 });
  assert.deepEqual(bucket(4, 6), { shown: 4, extra: 0 });
  assert.deepEqual(bucket(6, 6), { shown: 6, extra: 0 });
  assert.deepEqual(bucket(20, 6), { shown: 6, extra: 14 });
  assert.deepEqual(bucket(-3, 6), { shown: 0, extra: 0 });
  assert.deepEqual(bucket(7.9, 0), { shown: 0, extra: 7 });
});

const census = (patch = {}) => ({
  sessionsEver: 0, memoryActive: 0, memoryInbox: 0, watches: { active: 0, finished: 0, fires: 0, ever: 0 }, grants: 0, activityLastHour: 0, since: null,
  ...patch,
});

test("MILESTONES is the spec's table with unique ids", () => {
  assert.equal(LAYOUT_VERSION, 1);
  assert.equal(MILESTONES.length, 10);
  assert.equal(new Set(MILESTONES.map((m) => m.id)).size, 10);
  assert.deepEqual(MILESTONES.map((m) => [m.metric, m.threshold]), [
    ["sessions", 25], ["sessions", 75], ["sessions", 150], ["sessions", 300], ["sessions", 600],
    ["memory", 50], ["memory", 200], ["watches", 10], ["fires", 100], ["days", 365],
  ]);
});

test("milestonesReached reads each threshold from its census value", () => {
  const now = Date.UTC(2026, 9, 8);
  assert.deepEqual(milestonesReached(census(), now), []);
  assert.deepEqual(milestonesReached(census({ sessionsEver: 24 }), now), []);
  const reached = milestonesReached(census({ sessionsEver: 150, memoryActive: 50, watches: { active: 1, finished: 9, fires: 99, ever: 10 } }), now);
  assert.deepEqual(reached.map((m) => m.id), ["tall-bookcase", "second-bookcase", "rolling-ladder", "wide-pinboard", "window-box"]);
  assert.deepEqual(reached[2], { id: "rolling-ladder", value: 150, summary: "The room gained a rolling ladder at 150 sessions." });
  assert.equal(reached[4].value, 10);
  assert.deepEqual(milestonesReached(census({ watches: { active: 0, finished: 0, fires: 100, ever: 1 } }), now).map((m) => m.id), ["wind-chime"]);
  const day = 86_400_000;
  assert.deepEqual(milestonesReached(census({ since: now - 364 * day }), now), []);
  assert.deepEqual(milestonesReached(census({ since: now - 365 * day }), now).map((m) => [m.id, m.value]), [["second-rug", 365]]);
});

test("latitudeForTimeZone knows common zones, falls back to the region, and is null for UTC and unknowns", () => {
  assert.deepEqual(latitudeForTimeZone("America/Los_Angeles"), { latitude: 34.05, longitude: -118.24 });
  assert.deepEqual(latitudeForTimeZone("Europe/London"), { latitude: 51.51, longitude: -0.13 });
  assert.ok(latitudeForTimeZone("Australia/Sydney").latitude < 0, "southern hemisphere");
  assert.deepEqual(latitudeForTimeZone("Europe/Tallinn"), { latitude: 50, longitude: 10 }, "region fallback");
  assert.deepEqual(latitudeForTimeZone("America/Indiana/Knox"), { latitude: 35, longitude: -90 });
  for (const zone of ["UTC", "Etc/GMT+3", "Mars/Olympus", "", null, undefined]) assert.equal(latitudeForTimeZone(zone), null, String(zone));
});
