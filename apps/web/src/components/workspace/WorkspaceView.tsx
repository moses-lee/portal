"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs } from "radix-ui";
import type { PaneNode, Tab } from "@portal/contracts/workspace";
import { tabPanes } from "@portal/shared/workspace";
import RoomBackground from "../RoomBackground";
import SessionPane, { type InitialSend, type StartPaneProps } from "../SessionPane";
import { useSessions } from "../SessionsProvider";
import { useMediaQuery } from "../useMediaQuery";
import { NO_FOCUS, useWorkspace, type WorkspaceFocus } from "../WorkspaceProvider";
import MobileWorkspace from "./MobileWorkspace";
import SplitTree from "./SplitTree";
import TabStrip from "./TabStrip";
import { useWorkspaceActions } from "./useWorkspaceActions";
import type { AgentActivity } from "@/lib/agent-activity";
import { navigateTo } from "@/lib/navigation";
import { isResolverPath, startPath, tabPath, type WorkspaceRoute } from "@/lib/session-routes";
import { sessionState } from "@/lib/session-state";
import { canSplitPane, locationPath, mountedTabIds, paneTitle, rememberFocused, resolveFocus, resolveRoute, tabTitle } from "@/lib/workspace";
import { focusScope, MOBILE_QUERY, NARROW_QUERY, switcherPanes, tabRendersSplit, viewportKind, type PaneRef } from "@/lib/workspace-mobile";

export type WorkspaceViewProps = {
  /** The tab in the URL, or a resolver path (`/new`, `/sessions/<id>`) while it resolves. */
  route: WorkspaceRoute;
  /** The start page's props, shared by every start-page pane. */
  start: StartPaneProps;
  onOpenSidebar: (opener: HTMLElement) => void;
  showGithub: boolean;
  onToggleGithub: (opener: HTMLElement) => void;
  initialSend: InitialSend;
  onInitialSendHandled: (sessionId: string) => void;
  onSessionDeleted: (sessionId: string) => void;
};

/**
 * The workspace (docs/WORKSPACE.md, "The workspace view"): the tab strip, then the focused tab's
 * layout, with the 3 most recently focused tabs kept mounted but hidden so their streams run. Focus
 * is the URL: this reads `/tabs/<tabId>?pane=<paneId>` (hence `useSearchParams`; the shell wraps it
 * in Suspense for the prerendered `/new`) and reports it to the provider for the sidebar, the GitHub
 * inspector and the title. The resolvers (`/sessions/<id>`, `/new`) are settled here once the
 * workspace has loaded. An empty workspace is the start page without a strip; creating a session
 * there opens the first tab. The viewport decides the shape (`viewportKind`): below 768 px the flat
 * pane list (`MobileWorkspace`) replaces the strip and the trees; up to 1100 px the strip stays and
 * tabs of 3 or 4 panes show one pane with the switcher (decisions 18 and 20). The pane rendering is
 * shared by all three.
 */
export default function WorkspaceView({
  route,
  start,
  onOpenSidebar,
  showGithub,
  onToggleGithub,
  initialSend,
  onInitialSendHandled,
  onSessionDeleted,
}: WorkspaceViewProps) {
  const searchParams = useSearchParams();
  const paneParam = searchParams.get("pane");
  const { workspace, loaded, pending, apply, error, dismissError, setFocus, unread, unreadPanes, keyOf } = useWorkspace();
  const { sessions } = useSessions();
  const actions = useWorkspaceActions();
  // The viewport class, the same breakpoints the shell uses for the sidebar (768) and `ResponsiveDialog`.
  const mobile = useMediaQuery(MOBILE_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const kind = viewportKind(mobile, narrow);
  const routeTabId = route.kind === "tab" ? route.tabId : null;
  const { tab, pane } = useMemo(() => resolveFocus(workspace, routeTabId, paneParam), [workspace, routeTabId, paneParam]);
  const focusedTabId = tab?.id ?? null;
  const focusedPaneId = pane?.id ?? null;
  const focusedSessionId = pane?.sessionId ?? (route.kind === "session" ? route.sessionId : null);
  /** Whether the device shows the whole tab or only the focused pane (unread treats the rest as hidden). */
  const scope = focusScope(tab, kind);

  // What this device is looking at, for the shell around the view.
  useEffect(() => {
    const focus: WorkspaceFocus = { tabId: focusedTabId, paneId: focusedPaneId, sessionId: focusedSessionId, tab, pane, scope };
    setFocus(focus);
  }, [setFocus, focusedTabId, focusedPaneId, focusedSessionId, tab, pane, scope]);
  useEffect(() => () => setFocus(NO_FOCUS), [setFocus]);

  /** The pane last focused in each tab, so switching back lands where the user was (memory only; a hidden tablet tab shows it too). */
  const [lastPane, setLastPane] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Derived from the focus during render (no effect, no extra pass), like the focus history below.
  if (tab && pane && tabPanes(tab).length > 1 && lastPane.get(tab.id) !== pane.id) setLastPane(new Map(lastPane).set(tab.id, pane.id));
  const pathOfTab = useCallback(
    (tabId: string) => {
      const target = workspace.tabs.find((t) => t.id === tabId);
      return target && tabPanes(target).length > 1 ? tabPath(tabId, lastPane.get(tabId) ?? null) : tabPath(tabId);
    },
    [workspace, lastPane],
  );

  // Mounting policy (decision 30).
  const [recent, setRecent] = useState<string[]>([]);
  // The focus history is derived from the focused tab during render (no effect, no extra pass).
  if (focusedTabId !== null && recent[0] !== focusedTabId) setRecent(rememberFocused(recent, focusedTabId));
  const mounted = useMemo(() => mountedTabIds(workspace, focusedTabId, recent), [workspace, focusedTabId, recent]);

  // The resolvers (decision 7 and 9): once the workspace is known, `/sessions/<id>` focuses the
  // session's pane or opens it in a new tab, `/new` a start page. One try per path: a refused open
  // is reported, not retried on every workspace change. Not while an op of this device is in
  // flight: the bare start page creating a session shows the guessed workspace (a tab, no start
  // pane) before the caller moves the URL to it, and resolving that would open a second start page.
  const resolving = useRef(false);
  const failedRoute = useRef<string | null>(null);
  const routeKey = route.kind === "session" ? `session:${route.sessionId}` : route.kind === "start" ? "start" : null;
  useEffect(() => {
    if (!loaded || pending || route.kind === "tab" || resolving.current || failedRoute.current === routeKey) return;
    // The URL is read live: the op that just settled navigated in the same tick, and this render
    // still carries the resolver path the next one will not.
    if (!isResolverPath(window.location.pathname)) return;
    const resolution = resolveRoute(workspace, route);
    if (resolution.kind === "stay") return;
    if (resolution.kind === "focus") {
      navigateTo(locationPath(workspace, resolution.location), { replace: true });
      return;
    }
    resolving.current = true;
    apply(resolution.op)
      .then(({ workspace: next, location }) => {
        if (location) navigateTo(locationPath(next, location), { replace: true });
      })
      .catch(() => {
        failedRoute.current = routeKey;
      })
      .finally(() => {
        resolving.current = false;
      });
  }, [loaded, pending, route, routeKey, workspace, apply]);
  useEffect(() => {
    failedRoute.current = null;
  }, [routeKey]);

  // A tab the URL names that is gone (closed here or elsewhere): the first tab, else the start page.
  useEffect(() => {
    if (!loaded || route.kind !== "tab" || tab) return;
    const first = workspace.tabs[0];
    navigateTo(first ? pathOfTab(first.id) : startPath(), { replace: true });
  }, [loaded, route, tab, workspace, pathOfTab]);

  // The room scene follows the focused pane's agent (decision 3: one scene, lifted out of the panes).
  const [activities, setActivities] = useState<ReadonlyMap<string, AgentActivity>>(() => new Map());
  const reportActivity = useCallback((paneId: string | null, activity: AgentActivity) => {
    const key = paneId ?? "start";
    setActivities((prev) => (prev.get(key) === activity ? prev : new Map(prev).set(key, activity)));
  }, []);
  const roomActivity = activities.get(focusedPaneId ?? "start") ?? "idle";

  const titleOf = useCallback((t: Tab) => tabTitle(t, sessions), [sessions]);
  const paneTitleOf = useCallback((p: PaneNode) => paneTitle(p, sessions), [sessions]);
  const sessionOf = useCallback((sessionId: string) => sessions.find((s) => s.id === sessionId), [sessions]);
  const stateOf = useCallback(
    (sessionId: string) => {
      const session = sessionOf(sessionId);
      return session ? sessionState(session) : null;
    },
    [sessionOf],
  );

  const focusPane = useCallback(
    (tabId: string, paneId: string) => navigateTo(tabPath(tabId, paneId), { replace: true }),
    [],
  );
  /** The switcher's move (the bar, the sheet): within the tab it replaces the entry, like a focus change; to another tab it pushes, like the strip. */
  const showPane = useCallback(
    (tabId: string, paneId: string) => navigateTo(locationPath(workspace, { tabId, paneId }), { replace: tabId === focusedTabId }),
    [workspace, focusedTabId],
  );
  const resize = useCallback(
    (splitId: string, sizes: number[]) => {
      apply({ op: "resize", splitId, sizes }).catch(() => {});
    },
    [apply],
  );

  /** One pane's content: the session pane with its menu wired to this tab. */
  const renderPane = (t: Tab, p: PaneNode, first: boolean): ReactNode => {
    const count = tabPanes(t).length;
    return (
      <SessionPane
        key={keyOf(p.id)}
        sessionId={p.sessionId}
        paneId={p.id}
        start={start}
        showSidebarToggle={first}
        onOpenSidebar={onOpenSidebar}
        showGithub={showGithub}
        onToggleGithub={onToggleGithub}
        initialSend={initialSend}
        onInitialSendHandled={onInitialSendHandled}
        onNew={actions.openStartTab}
        onSessionDeleted={onSessionDeleted}
        onActivity={reportActivity}
        pane={{
          // What the reducer would refuse (the pane cap, the depth cap) is disabled, not offered.
          canSplitRight: canSplitPane(workspace, t.id, p.id, "right"),
          canSplitDown: canSplitPane(workspace, t.id, p.id, "bottom"),
          onSplitRight: () => void actions.splitPane(t.id, p.id, "right"),
          onSplitDown: () => void actions.splitPane(t.id, p.id, "bottom"),
          onMoveToTab: count > 1 ? () => void actions.moveToOwnTab(p) : null,
          onClose: () => void actions.closePane(p.id),
        }}
      />
    );
  };

  /** The pane's content for the switcher, which hands back the tab by id. */
  const renderPaneIn = (tabId: string, p: PaneNode): ReactNode => {
    const t = workspace.tabs.find((candidate) => candidate.id === tabId);
    return t ? renderPane(t, p, true) : null;
  };
  /** The switcher's list for this viewport: every pane on a phone, the focused tab's on a tablet when it is too big for a split, else none. */
  const switcher = useMemo(() => switcherPanes(workspace, tab, kind), [workspace, tab, kind]);
  const focusedRef = useMemo<PaneRef | null>(() => (tab && pane ? { tabId: tab.id, pane } : null), [tab, pane]);

  /** No tabs: the bare start page (also before the workspace has loaded, when `/new` is the path, so it shows at once). */
  const empty = workspace.tabs.length === 0 && (loaded || route.kind === "start");

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <RoomBackground activity={roomActivity} sessionId={focusedSessionId} />
      {error && (
        <p role="alert" className="flex items-center gap-3 border-b border-white/5 px-5 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={dismissError} className="shrink-0 rounded px-1 text-muted-foreground hover:text-foreground">
            Dismiss
          </button>
        </p>
      )}
      {empty ? (
        // Decision 9: no strip; the first session created here opens the first tab.
        <SessionPane
          key="start"
          sessionId={null}
          paneId={null}
          start={start}
          onOpenSidebar={onOpenSidebar}
          showGithub={showGithub}
          onToggleGithub={onToggleGithub}
          initialSend={initialSend}
          onInitialSendHandled={onInitialSendHandled}
          onNew={actions.openStartTab}
          onSessionDeleted={onSessionDeleted}
          onActivity={reportActivity}
        />
      ) : kind === "mobile" && switcher ? (
        // Decision 18: the flat list, one pane at a time; no strip, no splits.
        <MobileWorkspace
          panes={switcher}
          focused={focusedRef}
          renderPane={renderPaneIn}
          titleOf={paneTitleOf}
          stateOf={stateOf}
          sessionOf={sessionOf}
          unreadPanes={unreadPanes}
          onFocus={showPane}
          onClosePane={(paneId) => void actions.closePane(paneId)}
          onNewSession={() => void actions.openStartTab()}
        />
      ) : (
        <Tabs.Root
          value={focusedTabId ?? ""}
          onValueChange={(tabId) => navigateTo(pathOfTab(tabId))}
          activationMode="manual"
          className="flex min-h-0 flex-1 flex-col"
        >
          {workspace.tabs.length > 0 && (
            <TabStrip
              tabs={workspace.tabs}
              focusedTabId={focusedTabId}
              unread={unread}
              titleOf={titleOf}
              stateOf={stateOf}
              onNewTab={() => void actions.openStartTab()}
              onClose={(tabId) => void actions.closeTab(tabId)}
              onCloseOthers={(tabId) => void actions.closeOtherTabs(tabId)}
              onRename={(tabId, title) => void actions.renameTab(tabId, title)}
              onArrange={(t, preset) => void actions.arrangeTab(t, preset)}
            />
          )}
          {workspace.tabs
            .filter((t) => mounted.includes(t.id))
            .map((t) => (
              // Hidden tabs stay mounted (their streams run); `hidden` keeps them out of layout and the accessibility tree.
              <Tabs.Content
                key={keyOf(t.id)}
                value={t.id}
                forceMount
                hidden={t.id !== focusedTabId}
                tabIndex={-1}
                className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
              >
                {tabRendersSplit(t, kind) ? (
                  <SplitTree
                    root={t.root}
                    focusedPaneId={t.id === focusedTabId ? focusedPaneId : null}
                    renderPane={(p, first) => renderPane(t, p, first)}
                    onFocusPane={(paneId) => focusPane(t.id, paneId)}
                    onResize={resize}
                    keyOf={keyOf}
                  />
                ) : (
                  // Decision 20: a tablet shows one pane of a 3- or 4-pane tab, with the switcher scoped to the tab.
                  <MobileWorkspace
                    panes={tabPanes(t).map((p) => ({ tabId: t.id, pane: p }))}
                    focused={t.id === focusedTabId ? focusedRef : paneRefIn(t, lastPane.get(t.id) ?? null)}
                    renderPane={renderPaneIn}
                    titleOf={paneTitleOf}
                    stateOf={stateOf}
                    sessionOf={sessionOf}
                    unreadPanes={unreadPanes}
                    onFocus={showPane}
                    onClosePane={(paneId) => void actions.closePane(paneId)}
                    onNewSession={() => void actions.openStartTab()}
                    sheetDescription="The panes of this tab, in order."
                  />
                )}
              </Tabs.Content>
            ))}
        </Tabs.Root>
      )}
    </main>
  );
}

/** The tab's pane named by `paneId`, else its first, as a switcher entry (a hidden tablet tab shows where the user left it). */
function paneRefIn(tab: Tab, paneId: string | null): PaneRef | null {
  const panes = tabPanes(tab);
  const pane = panes.find((p) => p.id === paneId) ?? panes[0];
  return pane ? { tabId: tab.id, pane } : null;
}
