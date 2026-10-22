import assert from "node:assert/strict";
import test from "node:test";
import {
  isPalaceLinkPath,
  isStartPath,
  isTerminalPath,
  portalLocation,
  portalPath,
  sessionIdFromPath,
  sessionPath,
  startPath,
  terminalPath,
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

test("terminal destinations are internal surface actions, not workspace URLs", () => {
  assert.equal(terminalPath(), "/terminal");
  assert.equal(isTerminalPath("/terminal"), true);
  assert.equal(isTerminalPath("/terminal/"), true);
  assert.equal(isTerminalPath("/"), false);
  assert.equal(isTerminalPath("/terminals"), false);
  assert.equal(isTerminalPath("/terminal/extra"), false);
  assert.equal(isTerminalPath("/sessions/terminal"), false);
  assert.equal(sessionIdFromPath("/terminal"), null);
});

test("home is the start page (docs/GLASS.md, Home)", () => {
  assert.equal(startPath(), "/new");
  assert.equal(isStartPath("/new"), true);
  assert.equal(isStartPath("/new/"), true);
  assert.equal(isStartPath("/"), true);
  assert.equal(isStartPath("/news"), false);
  assert.equal(isStartPath("/new/extra"), false);
  assert.equal(isStartPath("/watches"), false);
  // Unknown browser paths do not represent Portal pages. The internal decoder retains the legacy fallback for stored destinations.
  assert.equal(isStartPath("/whatever"), false);
  assert.deepEqual(portalLocation("/whatever"), { view: "chat" });
});

test("stored / and /palace links enter Palace mode; nothing else does", async () => {
  const { inAppLinkPath, isSurfaceLinkPath } = await import("../src/lib/session-routes.ts");
  for (const path of ["/", "/palace", "/palace/"]) {
    assert.equal(isPalaceLinkPath(path), true, path);
    assert.equal(isSurfaceLinkPath(path), true, path);
    assert.equal(inAppLinkPath(path, "https://portal.example"), path);
  }
  for (const path of ["/new", "/palace/extra", "/palaces", "/chat", "/watches", "/sessions/s1"]) assert.equal(isPalaceLinkPath(path), false, path);
  // The chat's destination is not `/`, which enters Palace mode.
  assert.equal(portalPath("chat"), "/chat");
  assert.notEqual(isPalaceLinkPath(portalPath()), true);
});

test("stored surface destinations round-trip", () => {
  assert.equal(portalPath(), "/chat");
  assert.equal(portalPath({ view: "chat" }), "/chat");
  assert.deepEqual(portalLocation("/chat"), { view: "chat" });
  // Watches were Goals until 2026-10-04; the old path is gone and lands on the chat like any unknown one.
  assert.deepEqual(portalLocation("/goals"), { view: "chat" });
  assert.equal(portalPath("watches"), "/watches");
  for (const view of ["attention", "watches", "activity", "system", "monitoring"]) {
    assert.equal(portalPath(view), `/${view}`);
    assert.deepEqual(portalLocation(`/${view}`), { view });
    assert.deepEqual(portalLocation(`/${view}/extra`), { view: "chat" });
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
  assert.equal(isWorkspacePath("/tabs/t1"), true);
  assert.equal(isWorkspacePath("/sessions/s1"), true);
  assert.equal(isWorkspacePath("/new"), true);
  assert.equal(isWorkspacePath("/terminal"), false);
  assert.equal(isWorkspacePath("/"), true);
  assert.equal(isResolverPath("/sessions/s1"), true);
  assert.equal(isResolverPath("/new"), true);
  assert.equal(isResolverPath("/"), true);
  assert.equal(isResolverPath("/tabs/t1"), false);
  // The route names the tab alone; the focused pane is the query's business, read by the view.
  assert.deepEqual(workspaceRoute("/tabs/t1"), { kind: "tab", tabId: "t1" });
  assert.deepEqual(workspaceRoute("/new"), { kind: "start" });
  assert.deepEqual(workspaceRoute("/sessions/s%201"), { kind: "session", sessionId: "s 1" });
  assert.deepEqual(workspaceRoute("/"), { kind: "start" });
  assert.equal(workspaceRoute("/palace"), null);
  assert.equal(workspaceRoute("/terminal"), null);
  assert.equal(workspaceRoute("/watches"), null);
});

test("links in Agent replies dispatch workspace and surface destinations locally", async () => {
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
  assert.equal(inAppLinkPath("/watches", origin), "/watches");
  assert.equal(inAppLinkPath("/", origin), "/");
  assert.equal(inAppLinkPath("mailto:x@y.z", origin), null);
  assert.equal(inAppLinkPath("not a url", origin), null);
  // No origin known yet (server rendering): paths still qualify, URLs do not.
  assert.equal(inAppLinkPath("/tabs/t1?pane=p1", null), "/tabs/t1?pane=p1");
  assert.equal(inAppLinkPath("https://portal.example/tabs/t1", null), null);
});
