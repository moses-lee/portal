export type RoomDecor = "olive" | "clay" | "blue" | "ochre";
export type RoomMode = "light" | "dark" | "system";
export const ROOM_MODE_PREFERENCE = "portal.room.mode";

export function parseRoomMode(value: string): RoomMode {
  return value === "light" || value === "dark" ? value : "system";
}

const DECOR: readonly RoomDecor[] = ["olive", "clay", "blue", "ochre"];

/** The viewer's local clock chooses the room, with a hard switch at 7am and 7pm. */
export function roomForLocalHour(hour: number): "garden" | "study" {
  return hour >= 7 && hour < 19 ? "garden" : "study";
}

/** Keep each session's photographic framing stable when the time of day changes. */
export function decorForSession(sessionId: string | null): RoomDecor {
  if (!sessionId) return "olive";
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return DECOR[(hash >>> 0) % DECOR.length];
}
