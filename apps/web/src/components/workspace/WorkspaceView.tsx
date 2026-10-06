"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs } from "radix-ui";
import type { PaneNode, Tab } from "@portal/contracts/workspace";
import { tabPanes } from "@portal/shared/workspace";
import { MAX_PANES_PER_TAB } from "@portal/shared/workspace";
import RoomBackground from "../RoomBackground";
import SessionPane, { type InitialSend, type StartPaneProps } from "../SessionPane";
import { useSessions } from "../SessionsProvider";
import { NO_FOCUS, useWorkspace, type WorkspaceFocus } from "../WorkspaceProvider";
import SplitTree from "./SplitTree";
import TabStrip from "./TabStrip";
import { useWorkspaceActions } from "./useWorkspaceActions";
import type { AgentActivity } from "@/lib/agent-activity";
import { navigateTo } from "@/lib/navigation";
import { startPath, tabPath, type WorkspaceRoute } from "@/lib/session-routes";
import { sessionState } from "@/lib/session-state";
import { locationPath, mountedTabIds, rememberFocused, resolveFocus, resolveRoute, tabTitle } from "@/lib/workspace";

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
 * there opens the first tab. Below 768 px the flat pane list (`MobileWorkspace`, step 7) will take
 * over from the strip and tree; the pane rendering below is shared with it.
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
  const { workspace, loaded, apply, error, dismissError, setFocus, unread, keyOf } = useWorkspace();
  const { sessions } = useSessions();
  const actions = useWorkspaceActions();
  const routeTabId = route.kind === "tab" ? route.tabId : null;
  const { tab, pane } = useMemo(() => resolveFocus(workspace, routeTabId, paneParam), [workspace, routeTabId, paneParam]);
  const focusedTabId = tab?.id ?? null;
  const focusedPaneId = pane?.id ?? null;
  const focusedSessionId = pane?.sessionId ?? (route.kind === "session" ? route.sessionId : null);

  // What this device is looking at, for the shell around the view.
  useEffect(() => {
    const focus: WorkspaceFocus = { tabId: focusedTabId, paneId: focusedPaneId, sessionId: focusedSessionId, tab, pane };
    setFocus(focus);
  }, [setFocus, focusedTabId, focusedPaneId, focusedSessionId, tab, pane]);
  useEffect(() => () => setFocus(NO_FOCUS), [setFocus]);

  /** The pane last focused in each tab, so switching back lands where the user was (memory only). */
  const lastPane = useRef(new Map<string, string>());
  useEffect(() => {
    if (tab && pane && tabPanes(tab).length > 1) lastPane.current.set(tab.id, pane.id);
  }, [tab, pane]);
  const pathOfTab = useCallback(
    (tabId: string) => {
      const target = workspace.tabs.find((t) => t.id === tabId);
      return target && tabPanes(target).length > 1 ? tabPath(tabId, lastPane.current.get(tabId) ?? null) : tabPath(tabId);
    },
    [workspace],
  );

  // Mounting policy (decision 30).
  const [recent, setRecent] = useState<string[]>([]);
  // The focus history is derived from the focused tab during render (no effect, no extra pass).
  if (focusedTabId !== null && recent[0] !== focusedTabId) setRecent(rememberFocused(recent, focusedTabId));
  const mounted = useMemo(() => mountedTabIds(workspace, focusedTabId, recent), [workspace, focusedTabId, recent]);

  // The resolvers (decision 7 and 9): once the workspace is known, `/sessions/<id>` focuses the
  // session's pane or opens it in a new tab, `/new` a start page. One try per path: a refused open
  // is reported, not retried on every workspace change.
  const resolving = useRef(false);
  const failedRoute = useRef<string | null>(null);
  const routeKey = route.kind === "session" ? `session:${route.sessionId}` : route.kind === "start" ? "start" : null;
  useEffect(() => {
    if (!loaded || route.kind === "tab" || resolving.current || failedRoute.current === routeKey) return;
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
  }, [loaded, route, routeKey, workspace, apply]);
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
  const stateOf = useCallback(
    (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      return session ? sessionState(session) : null;
    },
    [sessions],
  );

  const focusPane = useCallback(
    (tabId: string, paneId: string) => navigateTo(tabPath(tabId, paneId), { replace: true }),
    [],
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
          canSplit: count < MAX_PANES_PER_TAB,
          onSplitRight: () => void actions.splitPane(t.id, p.id, "right"),
          onSplitDown: () => void actions.splitPane(t.id, p.id, "bottom"),
          onMoveToTab: count > 1 ? () => void actions.moveToOwnTab(p) : null,
          onClose: () => void actions.closePane(p.id),
        }}
      />
    );
  };

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
                <SplitTree
                  root={t.root}
                  focusedPaneId={t.id === focusedTabId ? focusedPaneId : null}
                  renderPane={(p, first) => renderPane(t, p, first)}
                  onFocusPane={(paneId) => focusPane(t.id, paneId)}
                  onResize={resize}
                  keyOf={keyOf}
                />
              </Tabs.Content>
            ))}
        </Tabs.Root>
      )}
    </main>
  );
}
