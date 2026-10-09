import assert from "node:assert/strict";
import test from "node:test";
import { LOCATION_TTL_MS, RETRY_MS, WEATHER_TTL_MS, createRoomEnvironment, weatherUrl } from "../src/room/environment.ts";
import { answers, deferred, fakeClock, fakeFetch, fakeLog, until } from "./fixtures/room-fakes.mjs";

function setup({ location = null, roomOffline = false, handlers, timeZone = "America/Los_Angeles" } = {}) {
  const fake = fakeFetch(handlers);
  const clock = fakeClock();
  const log = fakeLog();
  const environment = createRoomEnvironment(
    { config: { location, roomOffline }, log },
    { fetch: fake.fetch, now: clock.now, timeZone: () => timeZone, refreshEveryMs: 0 },
  );
  return { environment, fake, clock, log };
}

test("PORTAL_LOCATION skips the IP lookup and asks Open-Meteo for those coordinates with the spec's query", async () => {
  const { environment, fake, clock } = setup({ location: { latitude: 40.5, longitude: -3.25 } });
  const before = environment.current();
  assert.equal(before.source, "config");
  assert.deepEqual([before.latitude, before.longitude, before.weather], [40.5, -3.25, null]);
  const env = await environment.refresh();
  assert.deepEqual(fake.calls.map(([name]) => name), ["weather"]);
  assert.equal(fake.calls[0][1], "https://api.open-meteo.com/v1/forecast?latitude=40.5&longitude=-3.25&current=temperature_2m,is_day,weather_code,cloud_cover,precipitation&timezone=auto");
  assert.equal(weatherUrl(40.5, -3.25), fake.calls[0][1]);
  assert.deepEqual(env, {
    latitude: 40.5, longitude: -3.25, timezone: "Europe/London", source: "config", fetchedAt: clock.t,
    weather: { code: 61, condition: "rain", isDay: true, cloudCover: 90, precipitation: 0.4, temperature: 14.2, fetchedAt: clock.t },
  });
});

test("without a configured location the public IP is looked up through ipify and geojs", async () => {
  const { environment, fake } = setup();
  const env = await environment.refresh();
  assert.deepEqual(fake.calls.map(([name]) => name), ["ipify", "geojs", "weather"]);
  assert.equal(fake.calls[0][1], "https://api.ipify.org?format=json");
  assert.equal(fake.calls[1][1], "https://get.geojs.io/v1/ip/geo.json");
  assert.equal(env.source, "ip");
  assert.deepEqual([env.latitude, env.longitude, env.timezone], [51.5085, -0.1257, "Europe/London"]);
  assert.match(fake.calls[2][1], /latitude=51\.5085&longitude=-0\.1257&/);
});

test("ipwho.is stands in when geojs fails, and ipify failing does not stop the lookup", async () => {
  const { environment, fake, log } = setup({ handlers: { ipify: new Error("offline"), geojs: { status: 503 } } });
  const env = await environment.refresh();
  assert.deepEqual(fake.calls.map(([name]) => name), ["ipify", "geojs", "ipwhois", "weather"]);
  assert.equal(fake.calls[2][1], "https://ipwho.is/");
  assert.equal(env.source, "ip");
  assert.deepEqual([env.latitude, env.longitude], [48.8566, 2.3522]);
  assert.deepEqual(log.warnings, []);
});

test("when every location lookup fails the server's time zone gives rough coordinates, with source none and no weather", async () => {
  const { environment, fake, log } = setup({ handlers: { ipify: new Error("down"), geojs: new Error("down"), ipwhois: { success: false, message: "quota" } } });
  const env = await environment.refresh();
  assert.equal(env.source, "none");
  assert.deepEqual([env.latitude, env.longitude, env.timezone], [34.05, -118.24, "America/Los_Angeles"]);
  assert.equal(env.weather, null);
  assert.equal(fake.count("weather"), 0, "a time zone's centre is too rough for the sky");
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /location/);
});

test("a provider failure keeps the last value and warns once per failure streak", async () => {
  const { environment, fake, clock, log } = setup();
  const first = await environment.refresh();
  assert.equal(first.weather.condition, "rain");

  fake.state.handlers.weather = { status: 500 };
  fake.state.handlers.geojs = new Error("geojs down");
  fake.state.handlers.ipwhois = new Error("ipwho down");
  fake.state.handlers.ipify = answers.ipify("198.51.100.1");
  clock.advance(LOCATION_TTL_MS);
  const failed = await environment.refresh();
  assert.equal(failed.source, "ip");
  assert.deepEqual([failed.latitude, failed.longitude], [first.latitude, first.longitude], "the last location stays");
  assert.deepEqual(failed.weather, first.weather, "the last weather stays");
  assert.equal(log.warnings.length, 2, "one for the location, one for the weather");

  await environment.refresh({ force: true });
  assert.equal(log.warnings.length, 2, "the same streak warns no more");

  fake.state.handlers.weather = answers.weather({ weather_code: 0 });
  fake.state.handlers.geojs = answers.geojs();
  const recovered = await environment.refresh({ force: true });
  assert.equal(recovered.weather.condition, "clear");
  fake.state.handlers.weather = new Error("again");
  await environment.refresh({ force: true });
  assert.equal(log.warnings.length, 3, "a new streak warns again");
});

test("cache windows: weather 20 minutes, location 24 hours, and an unchanged IP skips the geolocation", async () => {
  const { environment, fake, clock } = setup();
  await environment.refresh();
  assert.deepEqual([fake.count("ipify"), fake.count("geojs"), fake.count("weather")], [1, 1, 1]);
  clock.advance(WEATHER_TTL_MS - 1);
  await environment.refresh();
  assert.deepEqual([fake.count("ipify"), fake.count("geojs"), fake.count("weather")], [1, 1, 1], "both fresh");
  clock.advance(1);
  await environment.refresh();
  assert.deepEqual([fake.count("ipify"), fake.count("geojs"), fake.count("weather")], [1, 1, 2], "weather stale, location fresh");
  clock.advance(LOCATION_TTL_MS);
  await environment.refresh();
  assert.deepEqual([fake.count("ipify"), fake.count("geojs"), fake.count("weather")], [2, 1, 3], "same IP: the location is renewed without geojs");
  fake.state.handlers.ipify = answers.ipify("198.51.100.1");
  fake.state.handlers.geojs = answers.geojs({ ip: "198.51.100.1", latitude: "35.68", longitude: "139.69", timezone: "Asia/Tokyo" });
  clock.advance(LOCATION_TTL_MS);
  const moved = await environment.refresh();
  assert.deepEqual([fake.count("ipify"), fake.count("geojs")], [3, 2]);
  assert.deepEqual([moved.latitude, moved.longitude], [35.68, 139.69]);
  await environment.refresh({ force: true });
  assert.deepEqual([fake.count("ipify"), fake.count("geojs"), fake.count("weather")], [4, 2, 5], "force skips both caches");
});

test("the first read answers at once with source none, resolves in the background, and pushes when it lands", async () => {
  const { environment, fake, clock } = setup();
  const gate = deferred();
  fake.state.gate = gate.promise;
  const pushed = [];
  environment.subscribe((env) => pushed.push(env));
  const first = environment.current();
  assert.equal(first.source, "none");
  assert.equal(first.weather, null);
  assert.deepEqual([first.latitude, first.longitude], [34.05, -118.24], "the time zone's guess meanwhile");
  assert.equal(fake.calls.length, 1, "the lookup started");
  environment.current();
  environment.current();
  assert.equal(fake.calls.length, 1, "one resolution in flight at a time");
  gate.resolve();
  await until(() => pushed.length === 1);
  assert.equal(pushed[0].source, "ip");
  assert.equal(pushed[0].weather.condition, "rain");
  assert.deepEqual(environment.current(), pushed[0]);
  assert.equal(fake.calls.length, 3, "a fresh read fetches nothing");

  // A resolution that changes nothing pushes nothing.
  clock.advance(WEATHER_TTL_MS);
  await environment.refresh();
  assert.equal(pushed.length, 2, "the weather's fetchedAt moved");
  await environment.refresh();
  assert.equal(pushed.length, 2);
});

test("concurrent refreshes share one in-flight resolution", async () => {
  const { environment, fake } = setup({ location: { latitude: 1, longitude: 2 } });
  const gate = deferred();
  fake.state.gate = gate.promise;
  const both = Promise.all([environment.refresh({ force: true }), environment.refresh({ force: true })]);
  gate.resolve();
  const [a, b] = await both;
  assert.equal(a, b);
  assert.equal(fake.count("weather"), 1);
});

test("a failed lookup is retried by reads only after the retry window", async () => {
  const { environment, fake, clock } = setup({ handlers: { ipify: new Error("down"), geojs: new Error("down"), ipwhois: new Error("down") } });
  await environment.refresh();
  const calls = fake.calls.length;
  environment.current();
  clock.advance(RETRY_MS - 1);
  environment.current();
  assert.equal(fake.calls.length, calls, "no hammering while the providers are down");
  clock.advance(1);
  environment.current();
  await until(() => fake.calls.length > calls);
});

test("PORTAL_ROOM_OFFLINE makes no outbound calls", async () => {
  const offline = setup({ roomOffline: true });
  assert.equal(offline.environment.current().source, "none");
  const env = await offline.environment.refresh({ force: true });
  assert.deepEqual([env.source, env.latitude, env.weather], ["none", 34.05, null]);
  const configured = setup({ roomOffline: true, location: { latitude: 10, longitude: 20 } });
  assert.deepEqual(await configured.environment.refresh({ force: true }), configured.environment.current());
  assert.equal(configured.environment.current().source, "config");
  assert.deepEqual([...offline.fake.calls, ...configured.fake.calls], []);
});

test("an unknown server time zone leaves the coordinates null", async () => {
  const { environment } = setup({ roomOffline: true, timeZone: "UTC" });
  const env = environment.current();
  assert.deepEqual([env.latitude, env.longitude, env.timezone, env.source], [null, null, "UTC", "none"]);
});
