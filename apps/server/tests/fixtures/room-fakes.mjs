/** A fake `fetch` for the room's providers (ipify, geojs, ipwho.is, Open-Meteo), and a settable clock. */
export const LONDON = { latitude: 51.51, longitude: -0.13 };

export const answers = {
  ipify: (ip = "203.0.113.7") => ({ ip }),
  geojs: (overrides = {}) => ({ ip: "203.0.113.7", latitude: "51.5085", longitude: "-0.1257", timezone: "Europe/London", ...overrides }),
  ipwhois: (overrides = {}) => ({ success: true, ip: "203.0.113.7", latitude: 48.8566, longitude: 2.3522, timezone: { id: "Europe/Paris" }, ...overrides }),
  weather: (current = {}, timezone = "Europe/London") => ({
    timezone,
    current: { time: "2026-10-08T12:00", temperature_2m: 14.2, is_day: 1, weather_code: 61, cloud_cover: 90, precipitation: 0.4, ...current },
  }),
};

function provider(url) {
  const { host } = new URL(url);
  if (host === "api.ipify.org") return "ipify";
  if (host === "get.geojs.io") return "geojs";
  if (host === "ipwho.is") return "ipwhois";
  if (host === "api.open-meteo.com") return "weather";
  throw new Error(`unexpected fetch to ${url}`);
}

/**
 * `handlers[provider]` is a body, a function `(url) => body`, an Error (the fetch rejects), or
 * `{ status }` (an HTTP error). `gate`, when set, is awaited before each answer (to hold a lookup
 * in flight). Every call is recorded as `[provider, url]`.
 */
export function fakeFetch(handlers = {}) {
  const calls = [];
  const state = { handlers: { ipify: answers.ipify(), geojs: answers.geojs(), ipwhois: answers.ipwhois(), weather: answers.weather(), ...handlers }, gate: null };
  async function fetch(url) {
    const name = provider(String(url));
    calls.push([name, String(url)]);
    if (state.gate) await state.gate;
    let answer = state.handlers[name];
    if (typeof answer === "function") answer = answer(String(url));
    if (answer instanceof Error) throw answer;
    if (answer && typeof answer.status === "number") return new Response("nope", { status: answer.status });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }
  return { fetch, calls, state, count: (name) => calls.filter(([n]) => n === name).length };
}

export function fakeClock(start = 1_700_000_000_000) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  return clock;
}

export function fakeLog() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export async function until(predicate, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never held");
}
