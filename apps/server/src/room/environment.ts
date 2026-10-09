/**
 * The room's environment (docs/PALACE.md, Server): where the server is and the weather there.
 *
 * Location comes from `PORTAL_LOCATION` when set; otherwise from the server's own public IP
 * (ipify for the address, then geojs, with ipwho.is as the fallback), cached 24 hours. Clients on
 * the tailnet arrive from private addresses, so the browser's location is never asked for. Weather
 * comes from Open-Meteo (keyless), cached 20 minutes. A failed lookup keeps the last value and
 * warns once per failure streak. When nothing resolves, the server's own time zone gives rough
 * coordinates (source still "none"). `PORTAL_ROOM_OFFLINE=1` makes no outbound calls at all.
 *
 * Nothing is fetched at boot or on the request path: the first read starts the resolution in the
 * background and answers what is known; subscribers hear about every change once it lands. After
 * that a timer keeps the weather fresh so open tabs never poll.
 */
import type { RoomEnvironment, RoomWeather } from "@portal/contracts/room";
import { latitudeForTimeZone, weatherCondition } from "@portal/shared/room";
import type { ServerConfig } from "../config.ts";

export const LOCATION_TTL_MS = 24 * 60 * 60_000;
export const WEATHER_TTL_MS = 20 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** A read retries a lookup that failed (or is still missing) at most this often; `refresh` with `force` does not wait. */
export const RETRY_MS = 5 * 60_000;

const IPIFY_URL = "https://api.ipify.org?format=json";
const GEOJS_URL = "https://get.geojs.io/v1/ip/geo.json";
const IPWHOIS_URL = "https://ipwho.is/";

export function weatherUrl(latitude: number, longitude: number): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,is_day,weather_code,cloud_cover,precipitation&timezone=auto`;
}

export type RoomEnvironmentOptions = {
  /** Replaces the global `fetch` (tests). */
  fetch?: typeof fetch;
  now?: () => number;
  /** The server's IANA time zone, for the zero-network fallback. */
  timeZone?: () => string | null;
  /** How often the background refresh runs once something has read the environment; 0 turns it off. */
  refreshEveryMs?: number;
};

export interface RoomEnvironmentService {
  /** What is known now, without waiting; starts a background refresh when the location or weather is stale. */
  current(): RoomEnvironment;
  /** Resolve now and answer the result; `force` skips both caches. Concurrent calls share one resolution. */
  refresh(options?: { force?: boolean }): Promise<RoomEnvironment>;
  /** Called with the new environment whenever it changes; answers the unsubscribe function. */
  subscribe(listener: (environment: RoomEnvironment) => void): () => void;
  dispose(): void;
}

type Location = { latitude: number; longitude: number; timezone: string | null; ip: string | null; at: number };

function serverTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function finite(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Everything but the top-level `fetchedAt`, so a resolution that changed nothing pushes nothing. */
function fingerprint(environment: RoomEnvironment): string {
  const { fetchedAt: _fetchedAt, ...rest } = environment;
  return JSON.stringify(rest);
}

export function createRoomEnvironment(
  { config, log }: { config: Pick<ServerConfig, "location" | "roomOffline">; log: { warn(message: string): void } },
  { fetch: fetchImpl = globalThis.fetch, now = Date.now, timeZone = serverTimeZone, refreshEveryMs = WEATHER_TTL_MS }: RoomEnvironmentOptions = {},
): RoomEnvironmentService {
  const listeners = new Set<(environment: RoomEnvironment) => void>();
  const configured = config.location;
  let location: Location | null = null;
  let weather: RoomWeather | null = null;
  /** Open-Meteo's answer for the zone at the coordinates (`timezone=auto`), the best zone we get. */
  let weatherZone: string | null = null;
  let resolvedAt = now();
  /** When the last resolution started; null before the first. */
  let attemptedAt: number | null = null;
  let inflight: Promise<RoomEnvironment> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  // One warning per failure streak; a success ends the streak.
  let locationFailing = false;
  let weatherFailing = false;

  function snapshot(): RoomEnvironment {
    const zone = weatherZone ?? location?.timezone ?? timeZone();
    if (configured) return { ...configured, timezone: zone, source: "config", weather, fetchedAt: resolvedAt };
    if (location) return { latitude: location.latitude, longitude: location.longitude, timezone: zone, source: "ip", weather, fetchedAt: resolvedAt };
    const guess = latitudeForTimeZone(zone);
    return { latitude: guess?.latitude ?? null, longitude: guess?.longitude ?? null, timezone: zone, source: "none", weather, fetchedAt: resolvedAt };
  }

  async function getJson(url: string): Promise<Record<string, unknown>> {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
    return record(await response.json());
  }

  function geoFrom(body: Record<string, unknown>, ip: string | null): Location | null {
    const latitude = finite(body.latitude);
    const longitude = finite(body.longitude);
    if (latitude === null || longitude === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    // geojs names the zone `timezone`; ipwho.is nests it as `timezone.id`.
    const zone = text(body.timezone) ?? text(record(body.timezone).id);
    return { latitude, longitude, timezone: zone, ip: text(body.ip) ?? ip, at: now() };
  }

  /** The public IP's location, or the reason none came back. */
  async function lookUpLocation(): Promise<Location> {
    let ip: string | null = null;
    try {
      ip = text((await getJson(IPIFY_URL)).ip);
    } catch {
      // The geolocation services see the address themselves; ipify only saves a lookup when it is unchanged.
    }
    if (ip && location && location.ip === ip) return { ...location, at: now() };
    const failures: string[] = [];
    for (const url of [GEOJS_URL, IPWHOIS_URL]) {
      try {
        const body = await getJson(url);
        if (body.success === false) throw new Error(`${new URL(url).host}: ${text(body.message) ?? "lookup failed"}`);
        const found = geoFrom(body, ip);
        if (found) return found;
        throw new Error(`${new URL(url).host} answered no coordinates`);
      } catch (err) {
        failures.push(errorText(err));
      }
    }
    throw new Error(failures.join("; "));
  }

  async function lookUpWeather(latitude: number, longitude: number): Promise<{ weather: RoomWeather; zone: string | null }> {
    const body = await getJson(weatherUrl(latitude, longitude));
    const current = record(body.current);
    const code = finite(current.weather_code);
    if (code === null) throw new Error("Open-Meteo answered no current weather");
    return {
      weather: {
        code,
        condition: weatherCondition(code),
        isDay: finite(current.is_day) === 1,
        cloudCover: finite(current.cloud_cover) ?? 0,
        precipitation: finite(current.precipitation) ?? 0,
        temperature: finite(current.temperature_2m) ?? 0,
        fetchedAt: now(),
      },
      zone: text(body.timezone),
    };
  }

  async function resolve(force: boolean): Promise<RoomEnvironment> {
    attemptedAt = now();
    const before = fingerprint(snapshot());
    if (!configured && (force || !location || now() - location.at >= LOCATION_TTL_MS)) {
      try {
        location = await lookUpLocation();
        locationFailing = false;
      } catch (err) {
        if (!locationFailing) log.warn(`Room: could not look up the server's location (${errorText(err)}); keeping the last one.`);
        locationFailing = true;
      }
    }
    // Weather only for a real location: a time zone's rough centre is too far off to show its sky.
    const at = configured ?? location;
    if (at && (force || !weather || now() - weather.fetchedAt >= WEATHER_TTL_MS)) {
      try {
        const answer = await lookUpWeather(at.latitude, at.longitude);
        weather = answer.weather;
        weatherZone = answer.zone ?? weatherZone;
        weatherFailing = false;
      } catch (err) {
        if (!weatherFailing) log.warn(`Room: could not fetch the weather (${errorText(err)}); keeping the last report.`);
        weatherFailing = true;
      }
    }
    resolvedAt = now();
    const environment = snapshot();
    if (!disposed && fingerprint(environment) !== before) {
      for (const listener of listeners) {
        try {
          listener(environment);
        } catch (err) {
          console.error("Room environment listener failed:", err);
        }
      }
    }
    return environment;
  }

  function refresh({ force = false }: { force?: boolean } = {}): Promise<RoomEnvironment> {
    if (config.roomOffline || disposed) return Promise.resolve(snapshot());
    startTimer();
    // One resolution at a time: a caller arriving mid-flight gets that one's answer.
    if (!inflight) {
      inflight = resolve(force).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function startTimer() {
    if (timer || refreshEveryMs <= 0) return;
    timer = setInterval(() => void refresh().catch(() => {}), refreshEveryMs);
    timer.unref();
  }

  function stale(): boolean {
    const t = now();
    if (attemptedAt !== null && t - attemptedAt < RETRY_MS) return false;
    if (!configured && (!location || t - location.at >= LOCATION_TTL_MS)) return true;
    return !weather || t - weather.fetchedAt >= WEATHER_TTL_MS;
  }

  return {
    current() {
      if (!config.roomOffline && !inflight && stale()) void refresh().catch(() => {});
      return snapshot();
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}
