import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { checkSameOrigin, parseShellCommand } from "./shell-http.ts";
import type { ShellEvent } from "./shell-types.ts";
import type { createTerminalRegistry } from "./terminals-registry.ts";

const room = (terminalId: string) => `terminal:${terminalId}`;

export function attachTerminalServer(server: HttpServer, terminals: ReturnType<typeof createTerminalRegistry>) {
  const io = new Server(server, {
    path: "/api/shell/socket", transports: ["websocket"], serveClient: false,
    maxHttpBufferSize: 128 * 1024,
    allowRequest(req, callback) {
      const request = new Request("http://portal.invalid", {
        headers: { host: req.headers.host ?? "", origin: req.headers.origin ?? "" },
      });
      callback(null, checkSameOrigin(request) === null);
    },
  });
  // A middleware error is final for socket.io-client (no reconnect loop against a deleted tab).
  io.use((socket, next) => {
    const terminalId: unknown = socket.handshake.auth.terminalId;
    if (typeof terminalId === "string" && terminals.get(terminalId)) return next();
    const error = new Error("Unknown terminal.");
    (error as Error & { data?: unknown }).data = { code: "unknown_terminal" };
    next(error);
  });
  // Rooms exist only for lifecycle: deletion tells every viewer once, then drops them.
  terminals.onClose((entry) => {
    const closed: ShellEvent = { type: "closed", terminalId: entry.id };
    for (const id of io.sockets.adapter.rooms.get(room(entry.id)) ?? []) {
      io.sockets.sockets.get(id)?.emit("shell", closed, () => {});
    }
    io.in(room(entry.id)).disconnectSockets(true);
  });
  io.on("connection", (socket) => {
    const terminalId = String(socket.handshake.auth.terminalId);
    // The middleware ran earlier; the terminal may have been deleted in between.
    const entry = terminals.get(terminalId);
    if (!entry) {
      socket.emit("shell", { type: "closed", terminalId } satisfies ShellEvent, () => {});
      socket.disconnect(true);
      return;
    }
    socket.join(room(terminalId));
    let pendingBytes = 0;
    const send = (event: ShellEvent) => {
      // Bound slow-viewer buffering; reconnecting receives a fresh snapshot.
      const bytes = Buffer.byteLength(JSON.stringify(event));
      pendingBytes += bytes;
      if (pendingBytes > 4 * 1024 * 1024) { socket.conn.close(true); return; }
      socket.emit("shell", event, () => { pendingBytes -= bytes; });
    };
    const unsubscribe = entry.runtime.subscribe(send, socket.handshake.auth.output === true);
    socket.on("disconnect", unsubscribe);
    socket.on("command", (value: unknown, reply: (result: { error?: string }) => void) => {
      if (typeof reply !== "function") return;
      try {
        if (terminals.get(terminalId) !== entry) throw new Error("Terminal closed.");
        const command = parseShellCommand(value);
        if (command.action === "start") entry.runtime.start(command.id);
        else if (command.action === "input") entry.runtime.write(command.id, command.data);
        else entry.runtime.resize(command.id, command.cols, command.rows);
        reply({});
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "Shell unavailable." });
      }
    });
  });
  return io;
}
