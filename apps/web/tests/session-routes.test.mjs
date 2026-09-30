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
  assert.equal(isPortalPath("/goals"), true);
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
  for (const view of ["goals", "activity", "system"]) {
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
  assert.equal(withPanelSession("/goals", "a b/c"), "/goals?session=a+b%2Fc");
  assert.equal(withPanelSession("/goals", null), "/goals");
  assert.equal(panelSessionFromSearch(withPanelSession("/", "a b/c").slice(1)), "a b/c");

  // Without a query the locations are as before; with one they carry the session.
  assert.deepEqual(portalLocation("/goals", ""), { view: "goals" });
  assert.deepEqual(portalLocation("/goals", "?session=s1"), { view: "goals", session: "s1" });
  assert.deepEqual(portalLocation("/threads/t1", "?session=s1"), { view: "chat", threadId: "t1", session: "s1" });
  assert.equal(portalPath({ view: "chat", threadId: "main", session: "s1" }), "/?session=s1");
  assert.equal(portalPath({ view: "memory", entityId: "e1", session: "s1" }), "/memory/e1?session=s1");
  assert.equal(portalPath({ view: "goals", session: null }), "/goals");
  const location = portalLocation("/memory/curation/r1", "?session=s1");
  assert.equal(portalPath(location), "/memory/curation/r1?session=s1");

  // Switching views keeps the panel's session unless the target sets its own.
  assert.equal(portalPathKeepingPanel("goals", "?session=s1"), "/goals?session=s1");
  assert.equal(portalPathKeepingPanel("chat", "?session=s1"), "/?session=s1");
  assert.equal(portalPathKeepingPanel("memory", ""), "/memory");
  assert.equal(portalPathKeepingPanel({ view: "chat", threadId: "t1" }, "?session=s1"), "/threads/t1?session=s1");
  assert.equal(portalPathKeepingPanel({ view: "goals", session: "s2" }, "?session=s1"), "/goals?session=s2");
  assert.equal(portalPathKeepingPanel({ view: "goals", session: null }, "?session=s1"), "/goals");
});
