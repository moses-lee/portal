"use client";

import { useMemo, useState } from "react";
import type { Workspace } from "@portal/contracts/workspace";
import { mountedTabIds, rememberFocused } from "@/lib/workspace";

/**
 * The mounting policy (decision 30): the focused tab plus the 3 most recently focused that still
 * exist stay mounted (their streams run); the rest unmount. The focus history is derived from the
 * focused tab during render (no effect, no extra pass). Answers the tab ids to mount, in strip order.
 */
export function useMountedTabs(workspace: Workspace, focusedTabId: string | null): string[] {
  const [recent, setRecent] = useState<string[]>([]);
  if (focusedTabId !== null && recent[0] !== focusedTabId) setRecent(rememberFocused(recent, focusedTabId));
  return useMemo(() => mountedTabIds(workspace, focusedTabId, recent), [workspace, focusedTabId, recent]);
}
