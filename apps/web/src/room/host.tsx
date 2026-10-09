"use client";

import { createContext, useContext } from "react";
import type { ProjectSummary } from "@/lib/types";

/**
 * What the room needs from the app shell that the room cannot load itself: the project list (the
 * books' spine colours, the pinned projects' frames) and how a frame opens its project (the start
 * page with that project picked, as the sidebar's and search's project entries do). `Chat` provides
 * it around the pages that mount the room.
 */
export type RoomHost = {
  projects: readonly ProjectSummary[];
  openProject: (projectId: string) => void;
};

const NONE: RoomHost = { projects: [], openProject: () => {} };
const RoomHostContext = createContext<RoomHost>(NONE);

export const RoomHostProvider = RoomHostContext.Provider;

export function useRoomHost(): RoomHost {
  return useContext(RoomHostContext);
}
