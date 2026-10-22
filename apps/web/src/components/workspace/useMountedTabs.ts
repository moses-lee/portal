"use client";

import { useEffect, useMemo, useState } from "react";
import type { Workspace } from "@portal/contracts/workspace";
import { tabLeaves } from "@portal/shared/workspace";
import { useDirtyPanes } from "../files/useDirtyPanes";
import { forgetClosedPanes } from "@/lib/files";
import { mountedTabIds, rememberFocused } from "@/lib/workspace";

/**
 * The mounting policy (decision 30): the focused tab plus the 3 most recently focused that still
 * exist stay mounted (their streams run); the rest unmount, except a tab holding a file pane with
 * unsaved edits (docs/FILES.md), which would lose them. The focus history is derived from the
 * focused tab during render (no effect, no extra pass). Answers the tab ids to mount, in strip order.
 */
export function useMountedTabs(workspace: Workspace, focusedTabId: string | null): string[] {
  const [recent, setRecent] = useState<string[]>([]);
  const dirty = useDirtyPanes();
  if (focusedTabId !== null && recent[0] !== focusedTabId) setRecent(rememberFocused(recent, focusedTabId));
  // Unsaved edits outlive a pane's unmount (a layout change remounts it); a closed pane's go.
  // After the panes' own effects, so one whose id was just replaced has moved its edits first.
  useEffect(() => {
    if (dirty.size) forgetClosedPanes(new Set(workspace.tabs.flatMap((tab) => tabLeaves(tab).map((pane) => pane.id))));
  }, [workspace, dirty]);
  return useMemo(() => {
    const mounted = new Set(mountedTabIds(workspace, focusedTabId, recent));
    if (dirty.size === 0) return [...mounted];
    return workspace.tabs.filter((tab) => mounted.has(tab.id) || tabLeaves(tab).some((pane) => dirty.has(pane.id))).map((tab) => tab.id);
  }, [workspace, focusedTabId, recent, dirty]);
}
