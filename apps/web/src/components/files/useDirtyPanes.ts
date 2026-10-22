"use client";

import { useSyncExternalStore } from "react";
import { dirtyPaneIds, subscribeDirty } from "@/lib/files";

const NONE: ReadonlySet<string> = new Set();

/** The panes of this device holding unsaved file edits (docs/FILES.md); empty on the server. */
export function useDirtyPanes(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDirty, dirtyPaneIds, () => NONE);
}
