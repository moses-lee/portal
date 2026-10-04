"use client";

import { Clock3, Moon, Sun } from "lucide-react";
import { ROOM_MODE_PREFERENCE, parseRoomMode } from "@/lib/room-scene";
import { usePreference } from "./usePreference";

const modes = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Clock3 },
] as const;

export default function RoomModeControl() {
  const [storedMode, setMode] = usePreference(ROOM_MODE_PREFERENCE, "system");
  const mode = parseRoomMode(storedMode);

  return (
    <div role="group" aria-label="Room mode" className="mx-1 grid grid-cols-3 gap-0.5 rounded-lg border border-border/70 bg-muted/30 p-0.5">
      {modes.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={mode === value}
          onClick={() => setMode(value)}
          className={`flex h-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${mode === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-card/50 hover:text-foreground"}`}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
