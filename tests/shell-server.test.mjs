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
import { createShellRuntime } from "../src/lib/shell-runtime.ts";
import { attachShellServer } from "../src/lib/shell-server.ts";

const native = { skip: !["darwin", "linux"].includes(process.platform) };
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for shell event");
    await delay(10);
  }
}

test("WebSocket clients share one PTY beyond HTTP connection limits and reconnect to its screen", native, async (t) => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "portal-socket-")));
  const shell = createShellRuntime({
    cwd, shell: "/bin/bash", args: ["--noprofile", "--rcfile", fileURLToPath(new URL("./fixtures/shell.bashrc", import.meta.url)), "-i"],
  });
  const server = createServer();
  const transport = attachShellServer(server, shell);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.disconnect();
    shell.dispose();
    await new Promise((resolve) => transport.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
  });

  function connect(output = true, origin = url) {
    const socket = io(url, {
      path: "/api/shell/socket", transports: ["websocket"], auth: { output }, extraHeaders: { origin },
      reconnectionDelay: 20, reconnectionDelayMax: 50,
    });
    const events = [];
    socket.on("shell", (event, acknowledge) => { events.push(event); acknowledge(); });
    const client = { socket, events };
    clients.push(client);
    return client;
  }

  const rejected = connect(true, "http://untrusted.example");
  await once(rejected.socket, "connect_error");
  rejected.socket.disconnect();
  assert.equal(shell.getState().status, "idle");

  const viewers = Array.from({ length: 7 }, () => connect());
  const metadata = connect(false);
  await until(() => viewers.every((viewer) => viewer.events.length) && metadata.events.length);
  assert.ok(viewers.every(({ socket }) => socket.io.engine.transport.name === "websocket"));
  const startResults = await Promise.all(viewers.map(({ socket }) => socket.timeout(2000).emitWithAck("command", { action: "start", id: null })));
  assert.ok(startResults.every((result) => !result.error));
  const id = shell.getState().id;
  await until(() => viewers.every(({ events }) => events.some((event) => event.type === "output" && event.data.includes("PORTAL_TEST>"))));
  assert.ok(viewers.every(({ events }) => events.some((event) => event.type === "snapshot" && event.state.id === id)));
  const writer = viewers[0];
  assert.deepEqual(await writer.socket.timeout(2000).emitWithAck("command", { action: "input", id, data: "printf 'socket-shared\\n'\r" }), {});
  await until(() => viewers.every(({ events }) => events.some((event) => event.type === "output" && event.data.includes("socket-shared"))));
  assert.ok(metadata.events.every((event) => event.type === "state"));
  const invalid = await writer.socket.timeout(2000).emitWithAck("command", { action: "input", id: "stale", data: "bad\r" });
  assert.match(invalid.error, /no longer running/);
  const oversized = await writer.socket.timeout(2000).emitWithAck("command", { action: "input", id, data: "a".repeat(17000) });
  assert.match(oversized.error, /Invalid shell command/);

  const connectionId = writer.socket.id;
  transport.sockets.sockets.get(connectionId).conn.close();
  await until(() => writer.socket.connected && writer.socket.id !== connectionId);
  await until(() => writer.events.some((event) => event.type === "snapshot" && event.data.includes("socket-shared")));
  assert.equal(shell.getState().id, id);
});
