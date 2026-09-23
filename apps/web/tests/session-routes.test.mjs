import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalPath, sessionIdFromPath, sessionPath, terminalPath } from "../src/lib/session-routes.ts";

test("session paths round-trip and everything else is the start page", () => {
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

test("the terminal page has its own path and is neither a session nor the start page", () => {
  assert.equal(terminalPath(), "/terminal");
  assert.equal(isTerminalPath("/terminal"), true);
  assert.equal(isTerminalPath("/terminal/"), true);
  assert.equal(isTerminalPath("/"), false);
  assert.equal(isTerminalPath("/terminals"), false);
  assert.equal(isTerminalPath("/terminal/extra"), false);
  assert.equal(isTerminalPath("/sessions/terminal"), false);
  assert.equal(sessionIdFromPath("/terminal"), null);
});
