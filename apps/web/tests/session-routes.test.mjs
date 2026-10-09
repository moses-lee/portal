import assert from "node:assert/strict";
import test from "node:test";
import {
  isPortalPath,
  isStartPath,
  isTerminalPath,
  panelSessionFromSearch,
  portalLocation,
  portalPath,
  portalPathKeepingPanel,
  sessionIdFromPath,
  sessionPath,
  startPath,
  terminalPath,
  withPanelSession,
} from "../src/lib/session-routes.ts";

test("session paths round-trip", () => {
  assert.equal(sessionIdFromPath("/"), null);
  assert.equal(sessionIdFromPath("/sessions"), null);
  assert.equal(sessionIdFromPath("/sessions/"), null);
  assert.equal(sessionIdFromPath("/sessions/abc/extra"), null);
  assert.equal(sessionIdFromPath("/sessions/abc"), "abc");
  assert.equal(sessionIdFromPath("/sessions/abc/"), "abc");
  assert.equal(sessionPath("a b/c"), "/sessions/a%20b%2Fc");
  assert.equal(sessionIdFromPath(sessionPath("a b/c")), "a b/c");
  assert.equal(sessionIdFromPath("/sessions/%E0%A4%A"), null);
});

test("the terminal page has its own path and is neither a session nor Portal", () => {
  assert.equal(terminalPath(), "/terminal");
  assert.equal(isTerminalPath("/terminal"), true);
  assert.equal(isTerminalPath("/terminal/"), true);
  assert.equal(isTerminalPath("/"), false);
  assert.equal(isTerminalPath("/terminals"), false);
  assert.equal(isTerminalPath("/terminal/extra"), false);
  assert.equal(isTerminalPath("/sessions/terminal"), false);
  assert.equal(sessionIdFromPath("/terminal"), null);
  assert.equal(isPortalPath("/terminal"), false);
});

test("the start page is /new; sessions, the terminal, and /new are the only paths that are not Portal's", () => {
  assert.equal(startPath(), "/new");
  assert.equal(isStartPath("/new"), true);
  assert.equal(isStartPath("/new/"), true);
  assert.equal(isStartPath("/news"), false);
  assert.equal(isStartPath("/new/extra"), false);
  assert.equal(isPortalPath("/new"), false);
  assert.equal(isPortalPath("/sessions/abc"), false);
  assert.equal(isPortalPath("/"), true);
  assert.equal(isPortalPath("/watches"), true);
  assert.equal(isPortalPath("/attention"), true);
  assert.equal(isPortalPath("/threads/t1"), true);
  assert.equal(isPortalPath("/memory/curation/run-1"), true);
  // Anything unknown is Portal's too, and lands on the main thread.
  assert.equal(isPortalPath("/whatever"), true);
  assert.deepEqual(portalLocation("/whatever"), { view: "chat", threadId: "main" });
});

test("Portal locations and paths round-trip, with the main thread at /", () => {
  assert.deepEqual(portalLocation("/"), { view: "chat", threadId: "main" });
  assert.equal(portalPath(), "/");
  assert.equal(portalPath("chat"), "/");
  assert.equal(portalPath({ view: "chat", threadId: "main" }), "/");
  assert.equal(portalPath({ view: "chat", threadId: "t 1" }), "/threads/t%201");
  assert.deepEqual(portalLocation("/threads/t%201"), { view: "chat", threadId: "t 1" });
  assert.deepEqual(portalLocation("/threads/t1/extra"), { view: "chat", threadId: "main" });
  // Watches were Goals until 2026-10-04; the old path is gone and lands on the main thread like any unknown one.
  assert.deepEqual(portalLocation("/goals"), { view: "chat", threadId: "main" });
  assert.equal(portalPath("watches"), "/watches");
  for (const view of ["attention", "watches", "activity", "system", "palace"]) {
    assert.equal(portalPath(view), `/${view}`);
    assert.deepEqual(portalLocation(`/${view}`), { view });
    assert.deepEqual(portalLocation(`/${view}/extra`), { view: "chat", threadId: "main" });
  }
  assert.equal(portalPath("memory"), "/memory");
  assert.deepEqual(portalLocation("/memory"), { view: "memory", entityId: null });
  assert.equal(portalPath({ view: "memory", entityId: "e/1" }), "/memory/e%2F1");
  assert.deepEqual(portalLocation("/memory/e%2F1"), { view: "memory", entityId: "e/1" });
  assert.equal(portalPath({ view: "memory", entityId: null, runId: null }), "/memory/curation");
  assert.deepEqual(portalLocation("/memory/curation"), { view: "memory", entityId: null, runId: null });
  assert.equal(portalPath({ view: "memory", entityId: null, runId: "r1" }), "/memory/curation/r1");
  assert.deepEqual(portalLocation("/memory/curation/r1"), { view: "memory", entityId: null, runId: "r1" });
});

test("the tracked panel's session rides along as ?session= on any Portal path", () => {
  assert.equal(panelSessionFromSearch(""), null);
  assert.equal(panelSessionFromSearch("?session="), null);
  assert.equal(panelSessionFromSearch("?session=a%20b"), "a b");
  assert.equal(panelSessionFromSearch("session=s1&x=1"), "s1");
  assert.equal(withPanelSession("/watches", "a b/c"), "/watches?session=a+b%2Fc");
  assert.equal(withPanelSession("/watches", null), "/watches");
  assert.equal(panelSessionFromSearch(withPanelSession("/", "a b/c").slice(1)), "a b/c");

  // Without a query the locations are as before; with one they carry the session.
  assert.deepEqual(portalLocation("/watches", ""), { view: "watches" });
  assert.deepEqual(portalLocation("/watches", "?session=s1"), { view: "watches", session: "s1" });
  assert.deepEqual(portalLocation("/threads/t1", "?session=s1"), { view: "chat", threadId: "t1", session: "s1" });
  assert.equal(portalPath({ view: "chat", threadId: "main", session: "s1" }), "/?session=s1");
  assert.equal(portalPath({ view: "memory", entityId: "e1", session: "s1" }), "/memory/e1?session=s1");
  assert.equal(portalPath({ view: "watches", session: null }), "/watches");
  const location = portalLocation("/memory/curation/r1", "?session=s1");
  assert.equal(portalPath(location), "/memory/curation/r1?session=s1");

  // Switching views keeps the panel's session unless the target sets its own.
  assert.equal(portalPathKeepingPanel("watches", "?session=s1"), "/watches?session=s1");
  assert.equal(portalPathKeepingPanel("chat", "?session=s1"), "/?session=s1");
  assert.equal(portalPathKeepingPanel("memory", ""), "/memory");
  assert.equal(portalPathKeepingPanel({ view: "chat", threadId: "t1" }, "?session=s1"), "/threads/t1?session=s1");
  assert.equal(portalPathKeepingPanel({ view: "watches", session: "s2" }, "?session=s1"), "/watches?session=s2");
  assert.equal(portalPathKeepingPanel({ view: "watches", session: null }, "?session=s1"), "/watches");
});

test("tab paths carry the tab id and, in a split, the focused pane; /new and /sessions are resolvers, not Portal", async () => {
  const { isResolverPath, isTabPath, isWorkspacePath, tabFromPath, tabPath, workspaceRoute } = await import("../src/lib/session-routes.ts");
  assert.equal(tabPath("t1"), "/tabs/t1");
  assert.equal(tabPath("t 1", "p/1"), "/tabs/t%201?pane=p%2F1");
  assert.equal(tabPath("t1", null), "/tabs/t1");
  assert.deepEqual(tabFromPath("/tabs/t%201", "?pane=p%2F1"), { tabId: "t 1", paneId: "p/1" });
  assert.deepEqual(tabFromPath("/tabs/t1/", "pane=p1"), { tabId: "t1", paneId: "p1" });
  assert.deepEqual(tabFromPath("/tabs/t1", ""), { tabId: "t1", paneId: null });
  assert.deepEqual(tabFromPath("/tabs/t1", "?pane="), { tabId: "t1", paneId: null });
  assert.equal(tabFromPath("/tabs", ""), null);
  assert.equal(tabFromPath("/tabs/t1/extra", ""), null);
  assert.equal(tabFromPath("/tabs/%E0%A4%A", ""), null);
  assert.equal(isTabPath("/tabs/t1"), true);
  assert.equal(isTabPath("/tabsx/t1"), false);
  assert.equal(isPortalPath("/tabs/t1"), false);
  assert.equal(isWorkspacePath("/tabs/t1"), true);
  assert.equal(isWorkspacePath("/sessions/s1"), true);
  assert.equal(isWorkspacePath("/new"), true);
  assert.equal(isWorkspacePath("/terminal"), false);
  assert.equal(isWorkspacePath("/"), false);
  assert.equal(isResolverPath("/sessions/s1"), true);
  assert.equal(isResolverPath("/new"), true);
  assert.equal(isResolverPath("/tabs/t1"), false);
  // The route names the tab alone; the focused pane is the query's business, read by the view.
  assert.deepEqual(workspaceRoute("/tabs/t1"), { kind: "tab", tabId: "t1" });
  assert.deepEqual(workspaceRoute("/new"), { kind: "start" });
  assert.deepEqual(workspaceRoute("/sessions/s%201"), { kind: "session", sessionId: "s 1" });
  assert.equal(workspaceRoute("/"), null);
  assert.equal(workspaceRoute("/terminal"), null);
  assert.equal(workspaceRoute("/watches"), null);
});

test("links in Portal replies to tabs and sessions are in-app paths; everything else is not", async () => {
  const { inAppLinkPath } = await import("../src/lib/session-routes.ts");
  const origin = "https://portal.example";
  assert.equal(inAppLinkPath("/tabs/t1", origin), "/tabs/t1");
  assert.equal(inAppLinkPath("/tabs/t1?pane=p1", origin), "/tabs/t1?pane=p1");
  assert.equal(inAppLinkPath("/tabs/t1?pane=p1#x", origin), "/tabs/t1?pane=p1");
  assert.equal(inAppLinkPath("/sessions/s1", origin), "/sessions/s1");
  assert.equal(inAppLinkPath("/sessions/s1?foo=1", origin), "/sessions/s1");
  assert.equal(inAppLinkPath("https://portal.example/tabs/t1?pane=p1", origin), "/tabs/t1?pane=p1");
  assert.equal(inAppLinkPath("https://portal.example/sessions/s1", origin), "/sessions/s1");
  assert.equal(inAppLinkPath("https://elsewhere.example/tabs/t1", origin), null);
  assert.equal(inAppLinkPath("https://github.com/x/y/pull/1", origin), null);
  assert.equal(inAppLinkPath("/watches", origin), null);
  assert.equal(inAppLinkPath("/", origin), null);
  assert.equal(inAppLinkPath("mailto:x@y.z", origin), null);
  assert.equal(inAppLinkPath("not a url", origin), null);
  // No origin known yet (server rendering): paths still qualify, URLs do not.
  assert.equal(inAppLinkPath("/tabs/t1?pane=p1", null), "/tabs/t1?pane=p1");
  assert.equal(inAppLinkPath("https://portal.example/tabs/t1", null), null);
});
