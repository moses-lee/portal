/**
 * Wire types for the room behind Portal (docs/PALACE.md): the environment the server resolves
 * (location, weather), the census of what Portal did with the user, and the milestones reached.
 *
 * Only erasable TypeScript here (types and plain values), so Node can load it without a build step.
 *
 * HTTP surface:
 *   GET  /api/room               RoomState
 *   GET  /api/room/environment   RoomEnvironment
 *   POST /api/room/refresh       -> RoomState (origin-checked; forces the environment and census to refresh)
 * Live: the portal stream pushes `{ type: "room", state }` on connect and whenever the state changes.
 */

export type RoomWeather = {
  code: number;                 // WMO code from the provider
  condition: "clear" | "partly-cloudy" | "overcast" | "fog" | "drizzle" | "rain" | "heavy-rain" | "snow" | "thunderstorm";
  isDay: boolean;
  cloudCover: number;           // 0..100
  precipitation: number;        // mm in the last interval
  temperature: number;          // °C
  fetchedAt: number;
};
export type RoomEnvironment = {
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  source: "config" | "ip" | "none";
  weather: RoomWeather | null;  // null when unknown; the client shows clear
  fetchedAt: number;
};
export type RoomCensus = {
  sessionsEver: number;         // high-water
  memoryActive: number;
  memoryInbox: number;
  watches: { active: number; finished: number; fires: number; ever: number };
  grants: number;
  activityLastHour: number;
  since: number | null;         // epoch ms of the first session, stored once
};
export type RoomMilestone = { id: string; at: number; summary: string };
export type RoomState = { environment: RoomEnvironment; census: RoomCensus; milestones: RoomMilestone[]; layoutVersion: number };
