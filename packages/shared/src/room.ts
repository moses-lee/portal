/**
 * The room's pure logic (docs/PALACE.md), shared by the server (environment, census, milestones)
 * and the web (lighting, layout): weather codes, the sun's colour ramp, stable hashing and slots,
 * count buckets, the milestone table, and a time zone's rough location.
 */
import type { RoomCensus, RoomWeather } from "@portal/contracts/room";

/**
 * The room's layout generator version. Bump it with any change that would move an object (a new
 * milestone threshold, a slot capacity), so an update never silently rearranges the room.
 */
export const LAYOUT_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------------------------

/**
 * A WMO weather interpretation code (as Open-Meteo reports it) as the window shows it. Freezing
 * drizzle and rain count as drizzle and rain, showers by their strength; an unknown code is clear.
 */
export function weatherCondition(code: number): RoomWeather["condition"] {
  switch (code) {
    case 0:
      return "clear";
    case 1:
    case 2:
      return "partly-cloudy";
    case 3:
      return "overcast";
    case 45:
    case 48:
      return "fog";
    case 51:
    case 53:
    case 55:
    case 56:
    case 57:
      return "drizzle";
    case 61:
    case 63:
    case 66:
    case 80:
    case 81:
      return "rain";
    case 65:
    case 67:
    case 82:
      return "heavy-rain";
    case 71:
    case 73:
    case 75:
    case 77:
    case 85:
    case 86:
      return "snow";
    case 95:
    case 96:
    case 99:
      return "thunderstorm";
    default:
      return "clear";
  }
}

// ---------------------------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------------------------

export type SunRamp = {
  /** Colour temperature of the key light, in Kelvin. */
  kelvin: number;
  /** Key light intensity, 0..1 (the moon's when `moon`). */
  sun: number;
  /** Hemisphere sky and ground intensities, 0..1. */
  sky: number;
  ground: number;
  /** Below the horizon: the key light is the moon. */
  moon: boolean;
};

const HORIZON_KELVIN = 2200;
const HIGH_KELVIN = 5800;
const MOON_KELVIN = 7500;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The light for the sun at `altitude` (radians above the horizon, as suncalc reports it). Above the
 * horizon the colour warms from ~5800 K high to ~2200 K at the horizon; below it the key light is
 * the moon (dim and cool, blended in over civil twilight). Intensities never fall as the sun rises,
 * and neither does the colour temperature above the horizon.
 */
export function sunRamp(altitude: number): SunRamp {
  const degrees = (altitude * 180) / Math.PI;
  const day = lerp(HORIZON_KELVIN, HIGH_KELVIN, smoothstep(0, 40, degrees));
  return {
    kelvin: degrees >= 0 ? day : lerp(MOON_KELVIN, HORIZON_KELVIN, smoothstep(-6, 0, degrees)),
    sun: lerp(0.06, 1, smoothstep(-6, 30, degrees)),
    sky: lerp(0.12, 0.7, smoothstep(-12, 20, degrees)),
    ground: lerp(0.05, 0.35, smoothstep(-12, 20, degrees)),
    moon: degrees < 0,
  };
}

/** A colour temperature as linear-ish 0..1 RGB (Tanner Helland's fit; good from 1000 K to 40000 K). */
export function kelvinToRgb(kelvin: number): { r: number; g: number; b: number } {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const unit = (value: number) => Math.min(255, Math.max(0, value)) / 255;
  return { r: unit(r), g: unit(g), b: unit(b) };
}

// ---------------------------------------------------------------------------------------------
// Hashing and slots
// ---------------------------------------------------------------------------------------------

/** cyrb53: a fast, well-spread 53-bit string hash; the same id always gives the same number. */
export function hashId(id: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** mulberry32: a seeded PRNG answering floats in [0, 1); the same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The slot for an item: `hash(itemId) mod capacity`, walking forward (and wrapping) past slots in
 * `taken`; -1 when every slot is taken. Items placed in the order they arrived (oldest first, each
 * seeing the slots of those before it) keep their slots as new ones arrive.
 */
export function slotFor(itemId: string, capacity: number, taken: ReadonlySet<number>): number {
  if (capacity <= 0) return -1;
  const home = hashId(itemId) % capacity;
  for (let step = 0; step < capacity; step++) {
    const slot = (home + step) % capacity;
    if (!taken.has(slot)) return slot;
  }
  return -1;
}

/** `slotFor` over items in arrival order (oldest first): each item's slot, -1 for those that did not fit. */
export function assignSlots(itemIds: readonly string[], capacity: number): number[] {
  const taken = new Set<number>();
  return itemIds.map((id) => {
    const slot = slotFor(id, capacity, taken);
    if (slot >= 0) taken.add(slot);
    return slot;
  });
}

/** A count as the room shows it: literal up to `cap`, the rest as a number on a pile. */
export function bucket(count: number, cap: number): { shown: number; extra: number } {
  const total = Math.max(0, Math.floor(count));
  const limit = Math.max(0, Math.floor(cap));
  return { shown: Math.min(total, limit), extra: Math.max(0, total - limit) };
}

// ---------------------------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------------------------

/** Which census value a milestone watches. */
export type MilestoneMetric = "sessions" | "memory" | "watches" | "fires" | "days";

export type MilestoneDefinition = {
  id: string;
  metric: MilestoneMetric;
  threshold: number;
  /** The Activity sentence; `{n}` is the threshold. */
  summary: string;
};

/** The room's expansions (docs/PALACE.md, Milestones), all additive. Changing one is a `LAYOUT_VERSION` bump. */
export const MILESTONES: readonly MilestoneDefinition[] = [
  { id: "tall-bookcase", metric: "sessions", threshold: 25, summary: "The small shelf became a tall bookcase at {n} sessions." },
  { id: "second-bookcase", metric: "sessions", threshold: 75, summary: "The room gained a second bookcase at {n} sessions." },
  { id: "rolling-ladder", metric: "sessions", threshold: 150, summary: "The room gained a rolling ladder at {n} sessions." },
  { id: "reading-nook", metric: "sessions", threshold: 300, summary: "The room gained a reading nook at {n} sessions." },
  { id: "bay-window", metric: "sessions", threshold: 600, summary: "The window became a bay window with a seat at {n} sessions." },
  { id: "wide-pinboard", metric: "memory", threshold: 50, summary: "The corkboard became a wide pinboard at {n} memory records." },
  { id: "wall-map", metric: "memory", threshold: 200, summary: "The room gained a map on the wall at {n} memory records." },
  { id: "window-box", metric: "watches", threshold: 10, summary: "The sill gained a window box at {n} watches." },
  { id: "wind-chime", metric: "fires", threshold: 100, summary: "The window gained a wind chime at {n} watch fires." },
  { id: "second-rug", metric: "days", threshold: 365, summary: "The room gained a second rug and a sleeping cat a year after the first session." },
];

const DAY_MS = 86_400_000;

/** The census value a metric reads; `days` counts whole days since the first session (0 before one). */
export function milestoneValue(census: RoomCensus, metric: MilestoneMetric, now: number = Date.now()): number {
  switch (metric) {
    case "sessions":
      return census.sessionsEver;
    case "memory":
      return census.memoryActive;
    case "watches":
      return census.watches.ever;
    case "fires":
      return census.watches.fires;
    case "days":
      return census.since === null ? 0 : Math.max(0, Math.floor((now - census.since) / DAY_MS));
  }
}

/** A milestone's Activity sentence. */
export function milestoneSummary(milestone: MilestoneDefinition): string {
  return milestone.summary.replace("{n}", String(milestone.threshold));
}

/** Every milestone the census has reached, in table order, with the value that reached it. */
export function milestonesReached(census: RoomCensus, now: number = Date.now()): { id: string; value: number; summary: string }[] {
  const reached: { id: string; value: number; summary: string }[] = [];
  for (const milestone of MILESTONES) {
    const value = milestoneValue(census, milestone.metric, now);
    if (value >= milestone.threshold) reached.push({ id: milestone.id, value, summary: milestoneSummary(milestone) });
  }
  return reached;
}

// ---------------------------------------------------------------------------------------------
// Location from a time zone
// ---------------------------------------------------------------------------------------------

export type ZoneLocation = { latitude: number; longitude: number };

/** Representative coordinates (the zone's namesake city) for common IANA zones. */
const ZONES: Record<string, [number, number]> = {
  "America/New_York": [40.71, -74.01],
  "America/Detroit": [42.33, -83.05],
  "America/Toronto": [43.65, -79.38],
  "America/Montreal": [45.5, -73.57],
  "America/Halifax": [44.65, -63.57],
  "America/St_Johns": [47.56, -52.71],
  "America/Chicago": [41.88, -87.63],
  "America/Winnipeg": [49.9, -97.14],
  "America/Mexico_City": [19.43, -99.13],
  "America/Denver": [39.74, -104.99],
  "America/Phoenix": [33.45, -112.07],
  "America/Edmonton": [53.55, -113.49],
  "America/Los_Angeles": [34.05, -118.24],
  "America/Vancouver": [49.28, -123.12],
  "America/Anchorage": [61.22, -149.9],
  "America/Bogota": [4.71, -74.07],
  "America/Lima": [-12.05, -77.04],
  "America/Caracas": [10.48, -66.9],
  "America/Santiago": [-33.45, -70.67],
  "America/Sao_Paulo": [-23.55, -46.63],
  "America/Argentina/Buenos_Aires": [-34.6, -58.38],
  "America/Buenos_Aires": [-34.6, -58.38],
  "Pacific/Honolulu": [21.31, -157.86],
  "Pacific/Auckland": [-36.85, 174.76],
  "Pacific/Fiji": [-18.14, 178.44],
  "Europe/London": [51.51, -0.13],
  "Europe/Dublin": [53.35, -6.26],
  "Europe/Lisbon": [38.72, -9.14],
  "Europe/Madrid": [40.42, -3.7],
  "Europe/Paris": [48.86, 2.35],
  "Europe/Brussels": [50.85, 4.35],
  "Europe/Amsterdam": [52.37, 4.9],
  "Europe/Berlin": [52.52, 13.4],
  "Europe/Zurich": [47.38, 8.54],
  "Europe/Rome": [41.9, 12.5],
  "Europe/Vienna": [48.21, 16.37],
  "Europe/Prague": [50.08, 14.44],
  "Europe/Warsaw": [52.23, 21.01],
  "Europe/Copenhagen": [55.68, 12.57],
  "Europe/Oslo": [59.91, 10.75],
  "Europe/Stockholm": [59.33, 18.07],
  "Europe/Helsinki": [60.17, 24.94],
  "Europe/Athens": [37.98, 23.73],
  "Europe/Istanbul": [41.01, 28.98],
  "Europe/Kiev": [50.45, 30.52],
  "Europe/Kyiv": [50.45, 30.52],
  "Europe/Moscow": [55.76, 37.62],
  "Africa/Cairo": [30.04, 31.24],
  "Africa/Lagos": [6.52, 3.38],
  "Africa/Nairobi": [-1.29, 36.82],
  "Africa/Johannesburg": [-26.2, 28.05],
  "Africa/Casablanca": [33.57, -7.59],
  "Asia/Dubai": [25.2, 55.27],
  "Asia/Tehran": [35.69, 51.39],
  "Asia/Karachi": [24.86, 67.01],
  "Asia/Kolkata": [22.57, 88.36],
  "Asia/Calcutta": [22.57, 88.36],
  "Asia/Dhaka": [23.81, 90.41],
  "Asia/Bangkok": [13.76, 100.5],
  "Asia/Jakarta": [-6.21, 106.85],
  "Asia/Ho_Chi_Minh": [10.82, 106.63],
  "Asia/Singapore": [1.35, 103.82],
  "Asia/Kuala_Lumpur": [3.14, 101.69],
  "Asia/Manila": [14.6, 120.98],
  "Asia/Hong_Kong": [22.32, 114.17],
  "Asia/Shanghai": [31.23, 121.47],
  "Asia/Taipei": [25.03, 121.57],
  "Asia/Seoul": [37.57, 126.98],
  "Asia/Tokyo": [35.68, 139.69],
  "Asia/Jerusalem": [31.77, 35.21],
  "Asia/Riyadh": [24.71, 46.68],
  "Australia/Perth": [-31.95, 115.86],
  "Australia/Adelaide": [-34.93, 138.6],
  "Australia/Darwin": [-12.46, 130.84],
  "Australia/Brisbane": [-27.47, 153.03],
  "Australia/Sydney": [-33.87, 151.21],
  "Australia/Melbourne": [-37.81, 144.96],
  "Atlantic/Reykjavik": [64.15, -21.94],
};

/** A rough centre for each region when the zone itself is not in the table. */
const REGIONS: Record<string, [number, number]> = {
  Africa: [5, 20],
  America: [35, -90],
  Antarctica: [-75, 0],
  Arctic: [78, 16],
  Asia: [30, 100],
  Atlantic: [30, -30],
  Australia: [-27, 135],
  Europe: [50, 10],
  Indian: [-10, 75],
  Pacific: [-10, -160],
};

/**
 * Where a time zone roughly is: the table's city, else its region's rough centre, else null (UTC,
 * `Etc/*`, an empty or unknown name). The room's zero-network fallback when no location resolves.
 */
export function latitudeForTimeZone(zone: string | null | undefined): ZoneLocation | null {
  if (!zone) return null;
  const known = ZONES[zone] ?? REGIONS[zone.split("/")[0]];
  return known ? { latitude: known[0], longitude: known[1] } : null;
}
