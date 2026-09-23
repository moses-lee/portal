/**
 * Server-Sent Events over Fastify. The reply is hijacked so the handler owns the socket; frames are
 * written as they happen and a comment ping every 15 s keeps proxies from closing an idle stream.
 */
import type { Server } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SSE_PING_MS = 15_000;

export interface EventStream {
  /** False until the client went away or `close()` ran. */
  readonly closed: boolean;
  /** Writes one event; `data` is JSON-encoded. */
  send(data: unknown, opts?: { event?: string; id?: string | number }): void;
  /** Writes a raw, already-framed chunk. */
  write(frame: string): void;
  /** Ends the response and runs the cleanup callbacks once. */
  close(): void;
  /** Runs when the stream closes for any reason (client abort or `close()`); each callback runs once. */
  onClose(callback: () => void): void;
}

/**
 * Open streams per http server (one per app; tests build several in one process). A hijacked reply
 * counts as in flight, so `server.close()`, and with it every `onClose` hook, would wait for each
 * browser tab to go away; `closeEventStreams` ends them from the app's `preClose` hook instead.
 */
const openStreams = new WeakMap<Server, Set<EventStream>>();

/** Ends every stream still open on `server`, running each one's cleanup callbacks. */
export function closeEventStreams(server: Server): void {
  const streams = openStreams.get(server);
  if (!streams) return;
  for (const stream of [...streams]) stream.close();
}

export function openEventStream(req: FastifyRequest, reply: FastifyReply): EventStream {
  const res = reply.raw;
  const cleanups: (() => void)[] = [];
  let closed = false;
  const registry = openStreams.get(req.server.server) ?? new Set<EventStream>();
  openStreams.set(req.server.server, registry);
  reply.hijack();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    registry.delete(stream);
    req.raw.off("close", close);
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch {}
    }
    try { res.end(); } catch {}
  };
  const write = (frame: string) => {
    if (closed) return;
    try { res.write(frame); } catch { close(); }
  };
  const ping = setInterval(() => write(`: ping\n\n`), SSE_PING_MS);
  ping.unref?.();

  const stream: EventStream = {
    get closed() { return closed; },
    write,
    send(data, { event, id } = {}) {
      let frame = "";
      if (event) frame += `event: ${event}\n`;
      if (id !== undefined) frame += `id: ${id}\n`;
      write(`${frame}data: ${JSON.stringify(data)}\n\n`);
    },
    close,
    onClose(callback) {
      if (closed) callback();
      else cleanups.push(callback);
    },
  };
  registry.add(stream);
  req.raw.once("close", close);
  if (req.raw.destroyed) close();
  // The Next.js proxy holds the response headers until the first byte, so EventSource `open` would
  // otherwise wait for the first real event.
  write(": open\n\n");
  return stream;
}
