"use client";

import { useSyncExternalStore } from "react";
import type { AgentActivity } from "@/lib/agent-activity";
import { usePreference } from "./usePreference";
import { ROOM_MODE_PREFERENCE, decorForSession, parseRoomMode, roomForLocalHour } from "@/lib/room-scene";

const currentRoom = () => roomForLocalHour(new Date().getHours());
const serverRoom = () => null;

/** Reschedule at each local clock boundary; visibility also catches suspended tabs and clock changes. */
function subscribeRoom(listener: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const update = () => {
    listener();
    const now = new Date();
    const next = new Date(now);
    if (now.getHours() >= 19) next.setDate(next.getDate() + 1);
    next.setHours(now.getHours() < 7 || now.getHours() >= 19 ? 7 : 19, 0, 0, 0);
    timer = setTimeout(update, Math.max(1000, next.getTime() - now.getTime() + 50));
  };
  const onVisibilityChange = () => {
    if (!document.hidden) {
      clearTimeout(timer);
      update();
    }
  };
  update();
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export default function RoomBackground({
  activity,
  sessionId = null,
}: {
  activity: AgentActivity;
  sessionId?: string | null;
}) {
  const localRoom = useSyncExternalStore(subscribeRoom, currentRoom, serverRoom);
  const [storedMode] = usePreference(ROOM_MODE_PREFERENCE, "system");
  const mode = parseRoomMode(storedMode);
  const scene = mode === "light" ? "garden" : mode === "dark" ? "study" : localRoom;

  return (
    <div
      className="room-scene"
      data-scene={scene ?? "pending"}
      data-decor={decorForSession(sessionId)}
      data-activity={activity}
      aria-hidden="true"
    />
  );
}
