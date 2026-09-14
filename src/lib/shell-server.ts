import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { checkShellOrigin, parseShellCommand } from "./shell-http.ts";
import type { createShellRuntime } from "./shell-runtime.ts";
import type { ShellEvent } from "./shell-types.ts";

export function attachShellServer(server: HttpServer, shell: ReturnType<typeof createShellRuntime>) {
  const io = new Server(server, {
    path: "/api/shell/socket", transports: ["websocket"], serveClient: false,
    maxHttpBufferSize: 128 * 1024,
    allowRequest(req, callback) {
      const request = new Request("http://portal.invalid", {
        headers: { host: req.headers.host ?? "", origin: req.headers.origin ?? "" },
      });
      callback(null, checkShellOrigin(request) === null);
    },
  });
  io.on("connection", (socket) => {
    let pendingBytes = 0;
    const send = (event: ShellEvent) => {
      // Bound slow-viewer buffering; reconnecting receives a fresh snapshot.
      const bytes = Buffer.byteLength(JSON.stringify(event));
      pendingBytes += bytes;
      if (pendingBytes > 4 * 1024 * 1024) { socket.conn.close(true); return; }
      socket.emit("shell", event, () => { pendingBytes -= bytes; });
    };
    const unsubscribe = shell.subscribe(send, socket.handshake.auth.output === true);
    socket.on("disconnect", unsubscribe);
    socket.on("command", (value: unknown, reply: (result: { error?: string }) => void) => {
      if (typeof reply !== "function") return;
      try {
        const command = parseShellCommand(value);
        if (command.action === "start") shell.start(command.id);
        else if (command.action === "input") shell.write(command.id, command.data);
        else shell.resize(command.id, command.cols, command.rows);
        reply({});
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "Shell unavailable." });
      }
    });
  });
  return io;
}
