import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";
import { attachTerminalServer } from "../src/lib/shell-server.ts";
import { createTerminalRegistry } from "../src/lib/terminals-registry.ts";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for shell event");
    await delay(10);
  }
}

function setup(t) {
  const terminals = createTerminalRegistry();
  const dirs = [];
  const clients = [];
  const server = createServer();
  const transport = attachTerminalServer(server, terminals);
  const ready = once(server, "listening").then(() => `http://127.0.0.1:${server.address().port}`);
  server.listen(0, "127.0.0.1");
  t.after(async () => {
    for (const client of clients) client.socket.disconnect();
    terminals.disposeAll();
    await new Promise((resolve) => transport.close(resolve));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  function terminal(sessionId = "session-1") {
    const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-socket-")));
    dirs.push(cwd);
    return terminals.create({
      sessionId, cwd, shell: "/bin/bash",
      args: ["--noprofile", "--rcfile", fileURLToPath(new URL("./fixtures/shell.bashrc", import.meta.url)), "-i"],
    });
  }
  async function connect(terminalId, { output = true, origin } = {}) {
    const url = await ready;
    const socket = io(url, {
      path: "/api/shell/socket", transports: ["websocket"], forceNew: true, auth: { terminalId, output },
      extraHeaders: { origin: origin ?? url }, reconnectionDelay: 20, reconnectionDelayMax: 50,
    });
    const events = [];
    socket.on("shell", (event, acknowledge) => { events.push(event); acknowledge(); });
    const client = {
      socket, events,
      output: () => events.filter((event) => event.type === "output").map((event) => event.data).join(""),
      command: (command) => socket.timeout(2000).emitWithAck("command", command),
    };
    clients.push(client);
    return client;
  }
  return { terminals, transport, terminal, connect };
}

test("WebSocket clients share one PTY beyond HTTP connection limits and reconnect to its screen", native, async (t) => {
  const { transport, terminal, connect } = setup(t);
  const entry = terminal();
  const shell = entry.runtime;

  const rejected = await connect(entry.id, { origin: "http://untrusted.example" });
  await once(rejected.socket, "connect_error");
  rejected.socket.disconnect();
  assert.equal(shell.getState().status, "idle");

  const viewers = await Promise.all(Array.from({ length: 7 }, () => connect(entry.id)));
  const metadata = await connect(entry.id, { output: false });
  await until(() => viewers.every((viewer) => viewer.events.length) && metadata.events.length);
  assert.ok(viewers.every(({ socket }) => socket.io.engine.transport.name === "websocket"));
  const startResults = await Promise.all(viewers.map((viewer) => viewer.command({ action: "start", id: null })));
  assert.ok(startResults.every((result) => !result.error));
  const id = shell.getState().id;
  await until(() => viewers.every((viewer) => viewer.output().includes("PORTAL_TEST>")));
  assert.ok(viewers.every(({ events }) => events.some((event) => event.type === "snapshot" && event.state.id === id)));
  const writer = viewers[0];
  assert.deepEqual(await writer.command({ action: "input", id, data: "printf 'socket-shared\\n'\r" }), {});
  await until(() => viewers.every((viewer) => viewer.output().includes("socket-shared")));
  assert.ok(metadata.events.every((event) => event.type === "state"));
  const invalid = await writer.command({ action: "input", id: "stale", data: "bad\r" });
  assert.match(invalid.error, /no longer running/);
  const oversized = await writer.command({ action: "input", id, data: "a".repeat(17000) });
  assert.match(oversized.error, /Invalid shell command/);

  const connectionId = writer.socket.id;
  transport.sockets.sockets.get(connectionId).conn.close();
  await until(() => writer.socket.connected && writer.socket.id !== connectionId);
  await until(() => writer.events.some((event) => event.type === "snapshot" && event.data.includes("socket-shared")));
  assert.equal(shell.getState().id, id);
});

test("each socket is scoped to its terminal, unknown terminals are refused, and closing tells viewers", native, async (t) => {
  const { terminals, terminal, connect } = setup(t);
  const a = terminal();
  const b = terminal();
  const cwdA = a.runtime.getState().cwd;
  const cwdB = b.runtime.getState().cwd;

  const unknown = await connect("nope");
  const [error] = await once(unknown.socket, "connect_error");
  assert.equal(error.data.code, "unknown_terminal");
  assert.equal(unknown.socket.active, false, "a middleware error must not trigger reconnect attempts");

  const viewersA = await Promise.all([connect(a.id), connect(a.id)]);
  const viewersB = await Promise.all([connect(b.id), connect(b.id)]);
  const all = [...viewersA, ...viewersB];
  await until(() => all.every((viewer) => viewer.events.length));
  assert.deepEqual(await viewersA[0].command({ action: "start", id: null }), {});
  assert.deepEqual(await viewersB[0].command({ action: "start", id: null }), {});
  const idA = a.runtime.getState().id;
  const idB = b.runtime.getState().id;
  assert.notEqual(idA, idB);
  await until(() => all.every((viewer) => viewer.output().includes("PORTAL_TEST>")));
  assert.deepEqual(await viewersA[1].command({ action: "input", id: idA, data: "printf 'A:%s\\n' \"$PWD\"\r" }), {});
  assert.deepEqual(await viewersB[1].command({ action: "input", id: idB, data: "printf 'B:%s\\n' \"$PWD\"\r" }), {});
  await until(() => viewersA.every((viewer) => viewer.output().includes(`A:${cwdA}`)));
  await until(() => viewersB.every((viewer) => viewer.output().includes(`B:${cwdB}`)));
  assert.ok(viewersA.every((viewer) => !viewer.output().includes("B:")));
  assert.ok(viewersB.every((viewer) => !viewer.output().includes("A:")));
  assert.ok(viewersA.every(({ events }) => events.filter((event) => event.type === "output").every((event) => event.id === idA)));
  const wrongTerminal = await viewersA[0].command({ action: "input", id: idB, data: "echo cross\r" });
  assert.match(wrongTerminal.error, /no longer running/);

  assert.equal(terminals.close(a.id), true);
  await until(() => viewersA.every(({ events }) => events.some((event) => event.type === "closed" && event.terminalId === a.id)));
  await until(() => viewersA.every(({ socket }) => !socket.connected));
  await delay(100);
  assert.ok(viewersA.every(({ socket }) => socket.active === false), "server-side disconnect must not reconnect");
  assert.ok(viewersB.every(({ socket }) => socket.connected));
  assert.ok(viewersB.every(({ events }) => !events.some((event) => event.type === "closed")));
  assert.deepEqual(await viewersB[0].command({ action: "input", id: idB, data: "printf 'still-%s\\n' streaming\r" }), {});
  await until(() => viewersB.every((viewer) => viewer.output().includes("still-streaming")));

  const late = await connect(a.id);
  const [lateError] = await once(late.socket, "connect_error");
  assert.equal(lateError.data.code, "unknown_terminal");
});
