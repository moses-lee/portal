"use client";

import { useMemo } from "react";
import type { LayoutPreset, PaneNode, SplitEdge, Tab, WorkspaceLocation } from "@portal/contracts/workspace";
import { locateSession } from "@portal/shared/workspace";
import { useWorkspace } from "../WorkspaceProvider";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { currentPath, navigateTo, replacePath } from "@/lib/navigation";
import { startPath, tabPath } from "@/lib/session-routes";
import { arrangeOp, locationPath, neighbourTab, startPaneIn, staysInTab } from "@/lib/workspace";

/**
 * What the shell, the sidebar, the tab strip and the pane menus do to the workspace (decision 8:
 * every way of opening a session does the same thing). Each action applies its op through the
 * provider (optimistic, errors shown by the view) and moves this device's focus (the URL) where
 * the result is. History: a pane change inside the focused tab replaces the entry, a move to
 * another tab (or a new one) pushes one (`staysInTab`). Rejections are swallowed: the provider's
 * `error` reports them. The callbacks are stable (they always read the latest workspace and
 * focus), so memoised rows can hold them.
 */
export function useWorkspaceActions() {
  const { workspace, apply, focus } = useWorkspace();

  /** Focus the session's pane when it is open (replace within the focused tab, else push), else open it in a new tab. */
  const openSession = useStableCallback(
    async (sessionId: string): Promise<WorkspaceLocation | null> => {
      const located = locateSession(workspace, sessionId);
      if (located) {
        navigateTo(locationPath(workspace, located), { replace: staysInTab(focus.tabId, located) });
        return located;
      }
      try {
        const { workspace: next, location } = await apply({ op: "open", sessionId });
        if (location) navigateTo(locationPath(next, location));
        return location;
      } catch {
        return null;
      }
    },
  );

  /**
   * A start page, by the one rule of every "new session" entry point (`resolveRoute`): a start-page
   * pane in the focused tab is reused (focused, replace), else a new start-page tab opens (push).
   * Answers where it is, so a caller can address that pane (a drafted prompt).
   */
  const openStartTab = useStableCallback(async (): Promise<WorkspaceLocation | null> => {
    const reuse = focus.tab ? startPaneIn(focus.tab) : null;
    if (reuse) {
      navigateTo(locationPath(workspace, reuse), { replace: true });
      return reuse;
    }
    try {
      const { workspace: next, location } = await apply({ op: "open", sessionId: null });
      if (location) navigateTo(locationPath(next, location));
      return location;
    } catch {
      // Reported by the provider.
      return null;
    }
  });

  /** Split the focused pane to the right with the session (an open session is focused instead, the reducer's rule); no focus: a new tab. */
  const openBeside = useStableCallback(
    async (sessionId: string) => {
      const { tab, pane } = focus;
      if (!tab || !pane) return void (await openSession(sessionId));
      try {
        const { workspace: next, location } = await apply({ op: "open", sessionId, target: { tabId: tab.id, paneId: pane.id, edge: "right" } });
        if (location) navigateTo(locationPath(next, location), { replace: staysInTab(tab.id, location) });
      } catch {
        // Reported by the provider.
      }
    },
  );

  /** The session in a tab of its own at the end of the strip, moved there if it is open elsewhere (push). */
  const moveToNewTab = useStableCallback(
    async (sessionId: string) => {
      try {
        const { workspace: next, location } = await apply({ op: "arrange", preset: "single", sessionIds: [sessionId] });
        if (location) navigateTo(locationPath(next, location));
      } catch {
        // Reported by the provider.
      }
    },
  );

  /** A start-page pane on `edge` of the pane, focused (replace). */
  const splitPane = useStableCallback(
    async (tabId: string, paneId: string, edge: SplitEdge) => {
      try {
        const { workspace: next, location } = await apply({ op: "open", sessionId: null, target: { tabId, paneId, edge } });
        if (location) navigateTo(locationPath(next, location), { replace: true });
      } catch {
        // Reported by the provider.
      }
    },
  );

  /** The pane's session (or a fresh start page) in a tab of its own; the pane closes. */
  const moveToOwnTab = useStableCallback(
    async (pane: PaneNode) => {
      if (pane.sessionId !== null) return moveToNewTab(pane.sessionId);
      try {
        await apply({ op: "close_pane", paneId: pane.id });
        const { workspace: next, location } = await apply({ op: "open", sessionId: null });
        if (location) navigateTo(locationPath(next, location));
      } catch {
        // Reported by the provider.
      }
    },
  );

  const closePane = useStableCallback(
    async (paneId: string) => {
      try {
        await apply({ op: "close_pane", paneId });
      } catch {
        // Reported by the provider.
      }
    },
  );

  /**
   * Close the tab. When it is the focused one, its neighbour (right, else left; else the start page
   * of an empty workspace) takes over before the op applies, so the view never sees the URL name a
   * tab the optimistic workspace lacks (it would jump to the first tab for a round trip); a refusal
   * puts the URL back with the tab.
   */
  const closeTab = useStableCallback(
    async (tabId: string) => {
      const focused = focus.tabId === tabId;
      const before = focused ? currentPath() : null;
      if (focused) {
        const neighbour = neighbourTab(workspace.tabs, tabId);
        navigateTo(neighbour ? tabPath(neighbour.id) : startPath(), { replace: true });
      }
      try {
        await apply({ op: "close_tab", tabId });
      } catch {
        if (before !== null) replacePath(before);
      }
    },
  );

  /** Close every other tab, this one focused first so no closing tab is the URL's. */
  const closeOtherTabs = useStableCallback(
    async (tabId: string) => {
      if (focus.tabId !== tabId) navigateTo(tabPath(tabId), { replace: true });
      for (const tab of workspace.tabs) {
        if (tab.id === tabId) continue;
        try {
          await apply({ op: "close_tab", tabId: tab.id });
        } catch {
          return;
        }
      }
    },
  );

  const renameTab = useStableCallback(
    async (tabId: string, title: string | null) => {
      try {
        await apply({ op: "rename_tab", tabId, title, source: "user" });
      } catch {
        // Reported by the provider.
      }
    },
  );

  /** Rebuild the tab as the preset with its sessions in order (extra sessions move to tabs of their own). */
  const arrangeTab = useStableCallback(
    async (tab: Tab, preset: LayoutPreset) => {
      try {
        const { workspace: next, location } = await apply(arrangeOp(tab, preset));
        if (location && focus.tabId === tab.id) navigateTo(locationPath(next, location), { replace: true });
      } catch {
        // Reported by the provider.
      }
    },
  );

  return useMemo(
    () => ({ openSession, openStartTab, openBeside, moveToNewTab, splitPane, moveToOwnTab, closePane, closeTab, closeOtherTabs, renameTab, arrangeTab }),
    [openSession, openStartTab, openBeside, moveToNewTab, splitPane, moveToOwnTab, closePane, closeTab, closeOtherTabs, renameTab, arrangeTab],
  );
}

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;
