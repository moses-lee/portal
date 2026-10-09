/**
 * The room's sun clock (docs/PALACE.md, Lighting): where the sun and moon are for a place and a
 * moment, whether the room reads as day or night, which way the light falls in room space, and the
 * sky's two colours (the dome in the scene, the CSS gradient when there is no WebGL). The client
 * clock is trusted; the server only supplies the coordinates. No React, no DOM: the node test
 * runner loads this file directly.
 */
import SunCalc from "suncalc";
import type { RoomEnvironment, RoomWeather } from "@portal/contracts/room";
import { latitudeForTimeZone } from "@portal/shared/room";

export type RoomCondition = RoomWeather["condition"];

export type RoomCoordinates = {
  latitude: number;
  longitude: number;
  /** `environment`: the server's; `zone`: the browser's time zone; `default`: neither was known. */
  source: "environment" | "zone" | "default";
};

/** Greenwich, when neither the server nor the time zone says where the room is. */
const DEFAULT_COORDINATES = { latitude: 51.48, longitude: 0 };

/** Where the room is: the server's coordinates, else the browser zone's rough location, else Greenwich. */
export function roomCoordinates(
  location: Pick<RoomEnvironment, "latitude" | "longitude"> | null,
  timeZone: string | null,
): RoomCoordinates {
  if (location && location.latitude !== null && location.longitude !== null) {
    return { latitude: location.latitude, longitude: location.longitude, source: "environment" };
  }
  const zone = latitudeForTimeZone(timeZone);
  return zone ? { ...zone, source: "zone" } : { ...DEFAULT_COORDINATES, source: "default" };
}

export type SunClock = {
  /** Epoch ms the positions are for. */
  at: number;
  /** Radians; altitude above the horizon, azimuth from south towards west (suncalc 1.9). */
  sun: { altitude: number; azimuth: number };
  /** As the sun, plus the lit fraction (0..1) and the phase (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter). */
  moon: { altitude: number; azimuth: number; fraction: number; phase: number };
};

/** The sun and moon over `coordinates` at `at`. */
export function sunClock(at: number, coordinates: { latitude: number; longitude: number }): SunClock {
  const date = new Date(at);
  const sun = SunCalc.getPosition(date, coordinates.latitude, coordinates.longitude);
  const moon = SunCalc.getMoonPosition(date, coordinates.latitude, coordinates.longitude);
  const light = SunCalc.getMoonIllumination(date);
  return {
    at,
    sun: { altitude: sun.altitude, azimuth: sun.azimuth },
    moon: { altitude: moon.altitude, azimuth: moon.azimuth, fraction: light.fraction, phase: light.phase },
  };
}

/** Sunrise and sunset as suncalc defines them: the sun's upper limb on the horizon, with refraction. */
export const HORIZON_ALTITUDE = (-0.833 * Math.PI) / 180;

/** What `data-scene` says: day from sunrise to sunset, night otherwise. */
export function sceneForAltitude(altitude: number): "day" | "night" {
  return altitude > HORIZON_ALTITUDE ? "day" : "night";
}

/** The start of the next minute after `now`: the sun clock ticks on minute boundaries. */
export function nextMinute(now: number): number {
  return Math.floor(now / 60_000) * 60_000 + 60_000;
}

/**
 * The unit vector from the room towards a body at `altitude` and `azimuth` (suncalc's radians), in
 * room space: the window in the back wall faces south (-z), +x is west, +y up.
 */
export function directionFrom(altitude: number, azimuth: number): [number, number, number] {
  const flat = Math.cos(altitude);
  return [Math.sin(azimuth) * flat, Math.sin(altitude), -Math.cos(azimuth) * flat];
}

// ---------------------------------------------------------------------------------------------
// Sky colours
// ---------------------------------------------------------------------------------------------

type Rgb = [number, number, number];

/** Zenith and horizon colours at sun altitudes (degrees), interpolated between neighbours. */
const SKY_STOPS: readonly { degrees: number; zenith: Rgb; horizon: Rgb }[] = [
  { degrees: -18, zenith: [7, 10, 22], horizon: [20, 26, 48] },
  { degrees: -8, zenith: [18, 24, 56], horizon: [62, 54, 88] },
  { degrees: -2, zenith: [44, 56, 104], horizon: [196, 122, 104] },
  { degrees: 4, zenith: [78, 110, 168], horizon: [240, 176, 122] },
  { degrees: 14, zenith: [84, 136, 204], horizon: [196, 214, 226] },
  { degrees: 35, zenith: [84, 138, 210], horizon: [178, 208, 234] },
];

/** How far each condition greys the sky (0 keeps it, 1 is fully grey). */
const GREY: Record<RoomCondition, number> = {
  clear: 0,
  "partly-cloudy": 0.2,
  overcast: 0.7,
  fog: 0.8,
  drizzle: 0.55,
  rain: 0.65,
  "heavy-rain": 0.75,
  snow: 0.6,
  thunderstorm: 0.8,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function grey(colour: Rgb, amount: number): Rgb {
  const luma = 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
  return mix(colour, [luma, luma, luma * 1.02], amount);
}

function hex(colour: Rgb): string {
  return `#${colour.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

/** The sky's zenith and horizon colours (`#rrggbb`) for the sun at `altitude` (radians) under `condition`. */
export function skyColours(altitude: number, condition: RoomCondition = "clear"): { zenith: string; horizon: string } {
  const degrees = (altitude * 180) / Math.PI;
  let zenith = SKY_STOPS[0].zenith;
  let horizon = SKY_STOPS[0].horizon;
  if (degrees >= SKY_STOPS[SKY_STOPS.length - 1].degrees) {
    zenith = SKY_STOPS[SKY_STOPS.length - 1].zenith;
    horizon = SKY_STOPS[SKY_STOPS.length - 1].horizon;
  } else {
    for (let index = 1; index < SKY_STOPS.length; index++) {
      const low = SKY_STOPS[index - 1];
      const high = SKY_STOPS[index];
      if (degrees < high.degrees) {
        const t = clamp01((degrees - low.degrees) / (high.degrees - low.degrees));
        zenith = mix(low.zenith, high.zenith, t);
        horizon = mix(low.horizon, high.horizon, t);
        break;
      }
    }
  }
  const amount = GREY[condition] ?? 0;
  return { zenith: hex(grey(zenith, amount)), horizon: hex(grey(horizon, amount)) };
}

/**
 * How much of the sun's direct light a condition lets through (1 on a clear day): grey skies leave
 * little more than a trace of the window's patch of sun on the floor.
 */
export function sunThrough(condition: RoomCondition): number {
  return Math.max(0.05, 1 - 1.25 * (GREY[condition] ?? 0));
}
