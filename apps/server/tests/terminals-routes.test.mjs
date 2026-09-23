import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { io } from "socket.io-client";
import { buildApp } from "../src/app.ts";
import { createTerminalRegistry } from "../src/terminals/registry.ts";
import { registerTerminalRoutes } from "../src/terminals/routes.ts";
import { temporaryDatabase } from "./helpers/db.mjs";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
const sameOrigin = { origin: "http://localhost:3000", host: "localhost:3000" };

async function until(predicate, description) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(20);
  }
}

/** Points `os.homedir()` (where standalone terminals start) and the login shell at a scratch setup. */
function scratchHome(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-terminals-home-")));
  const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  process.env.HOME = home;
  process.env.SHELL = "/bin/sh";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("standalone terminals: create, list, delete, and 403/404s", async (t) => {
  const home = scratchHome(t);
  const app = await buildApp({ database: await temporaryDatabase(t), orchestrator: false });
  t.after(() => app.close());

  const empty = await app.inject({ method: "GET", url: "/api/terminals" });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { terminals: [] });

  const created = await app.inject({ method: "POST", url: "/api/terminals", headers: sameOrigin });
  assert.equal(created.statusCode, 201);
  const terminal = created.json();
  assert.equal(typeof terminal.id, "string");
  assert.equal(terminal.sessionId, null);
  assert.equal(typeof terminal.createdAt, "number");
  assert.equal(terminal.state.status, "idle");
  assert.equal(terminal.state.cwd, home);

  const listed = await app.inject({ method: "GET", url: "/api/terminals" });
  assert.deepEqual(listed.json().terminals.map((entry) => entry.id), [terminal.id]);

  const crossOrigin = { origin: "http://evil.example", host: "localhost:3000" };
  assert.equal((await app.inject({ method: "POST", url: "/api/terminals", headers: crossOrigin })).statusCode, 403);
  const crossSite = await app.inject({ method: "DELETE", url: `/api/terminals/${terminal.id}`, headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.statusCode, 403);
  assert.deepEqual(crossSite.json(), { error: "Cross-site requests are not allowed." });
  assert.equal((await app.inject({ method: "GET", url: "/api/terminals", headers: crossOrigin })).statusCode, 403);

  const deleted = await app.inject({ method: "DELETE", url: `/api/terminals/${terminal.id}`, headers: sameOrigin });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  const again = await app.inject({ method: "DELETE", url: `/api/terminals/${terminal.id}`, headers: sameOrigin });
  assert.equal(again.statusCode, 404);
  assert.deepEqual(again.json(), { error: "Unknown terminal." });
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/terminals" })).json(), { terminals: [] });

  // Unknown sessions go through the real sessions service.
  for (const method of ["GET", "POST"]) {
    const response = await app.inject({ method, url: "/api/sessions/nope/terminals", headers: sameOrigin });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "Unknown session." });
  }
});

test("standalone POST answers 409 when the home directory is gone", async (t) => {
  const home = scratchHome(t);
  const app = await buildApp({ database: await temporaryDatabase(t), orchestrator: false });
  t.after(() => app.close());
  rmSync(home, { recursive: true, force: true });
  const response = await app.inject({ method: "POST", url: "/api/terminals", headers: sameOrigin });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /^Home directory is missing: /);
});

test("session terminals are listed per session and start in the session's directory", async (t) => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-session-terminals-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const sessions = new Map([["s1", { id: "s1", cwd }], ["gone", { id: "gone", cwd: path.join(cwd, "missing") }]]);
  const terminals = createTerminalRegistry();
  const app = Fastify();
  // Only the members the routes use; the real sessions service is exercised in the test above.
  registerTerminalRoutes(app, { terminals, sessions: { ready: Promise.resolve(), getSession: (id) => sessions.get(id) } });
  t.after(async () => { await app.close(); terminals.disposeAll(); });

  const created = await app.inject({ method: "POST", url: "/api/sessions/s1/terminals", headers: sameOrigin });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().sessionId, "s1");
  assert.equal(created.json().state.cwd, cwd);
  const listed = await app.inject({ method: "GET", url: "/api/sessions/s1/terminals" });
  assert.deepEqual(listed.json().terminals.map((entry) => entry.id), [created.json().id]);
  assert.deepEqual(terminals.listStandalone(), [], "session terminals are not standalone");

  const missing = await app.inject({ method: "POST", url: "/api/sessions/gone/terminals", headers: sameOrigin });
  assert.equal(missing.statusCode, 409);
  assert.match(missing.json().error, /^Working directory is missing: /);
  const rejected = await app.inject({ method: "POST", url: "/api/sessions/s1/terminals", headers: { origin: "http://evil.example", host: "localhost:3000" } });
  assert.equal(rejected.statusCode, 403);
});

test("Socket.IO on the listening app: snapshot, input, output, and close", native, async (t) => {
  scratchHome(t);
  const app = await buildApp({ database: await temporaryDatabase(t), orchestrator: false });
  const clients = [];
  let closed = false;
  t.after(async () => {
    for (const socket of clients) socket.disconnect();
    if (!closed) await app.close();
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const post = async (url) => (await fetch(`${address}${url}`, { method: "POST", headers: { origin: address } })).json();

  function connect(terminalId, headers = { origin: address }) {
    const socket = io(address, {
      path: "/api/shell/socket", transports: ["websocket"], forceNew: true, reconnection: false,
      auth: { terminalId, output: true }, extraHeaders: headers,
    });
    clients.push(socket);
    const events = [];
    socket.on("shell", (event, acknowledge) => { events.push(event); acknowledge(); });
    const output = () => events.filter((event) => event.type === "output").map((event) => event.data).join("");
    return { socket, events, output, command: (command) => socket.timeout(5000).emitWithAck("command", command) };
  }

  const terminal = await post("/api/terminals");

  const foreign = connect(terminal.id, { origin: "http://evil.example" });
  await once(foreign.socket, "connect_error");

  // What the browser sends through the Next.js rewrite: its own origin, forwarded as the host.
  const viewer = connect(terminal.id, { origin: "http://mini:3000", "x-forwarded-host": "mini:3000" });
  await until(() => viewer.events.length > 0, "the first event");
  assert.equal(viewer.events[0].type, "snapshot");
  assert.equal(viewer.events[0].state.status, "idle");

  assert.deepEqual(await viewer.command({ action: "start", id: null }), {});
  const id = viewer.events.findLast((event) => event.type === "snapshot").state.id;
  assert.equal(typeof id, "string");
  assert.deepEqual(await viewer.command({ action: "input", id, data: "printf 'socket-%s\\n' e2e\r" }), {});
  await until(() => viewer.output().includes("socket-e2e"), "shell output");

  const deleted = await fetch(`${address}/api/terminals/${terminal.id}`, { method: "DELETE", headers: { origin: address } });
  assert.equal(deleted.status, 204);
  await until(() => viewer.events.some((event) => event.type === "closed" && event.terminalId === terminal.id), "closed event");
  await until(() => !viewer.socket.connected, "server-side disconnect");

  // A viewer still attached must not hold up shutdown.
  const second = await post("/api/terminals");
  const lingering = connect(second.id);
  await until(() => lingering.socket.connected, "second viewer");
  const started = Date.now();
  await app.close();
  closed = true;
  assert.ok(Date.now() - started < 3000, "app.close() waits on no WebSocket");
  await until(() => !lingering.socket.connected, "disconnect on shutdown");
});
