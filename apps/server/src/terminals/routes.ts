import { stat } from "node:fs/promises";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type { Server as SocketServer } from "socket.io";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { displayPath } from "../lib/git-info.ts";
import { info } from "./registry.ts";
import { attachTerminalServer } from "./socket.ts";

type IdParams = { Params: { id: string } };

/** `/api/terminals/**`, `/api/sessions/:id/terminals`, and the Socket.IO server at `/api/shell/socket`. */
export function registerTerminalRoutes(app: FastifyInstance, ctx: AppContext): void {
  // `app.server` exists before `listen`; attaching on ready keeps `buildApp` side-effect free until
  // the app boots. `app.inject()` never touches the http server, so tests that skip `listen` are unaffected.
  let io: SocketServer | null = null;
  app.addHook("onReady", async () => {
    io = attachTerminalServer(app.server, ctx.terminals);
  });
  // Upgraded WebSockets keep `server.close()` waiting, so they go before Fastify closes the server
  // (and before `app.ts` disposes the registry in its onClose hook). Not `io.close()`: that closes
  // the http server itself and waits on every other open connection from inside this hook.
  app.addHook("preClose", async () => {
    io?.disconnectSockets(true);
    io?.engine.close();
    io = null;
  });

  // Standalone terminals: shells owned by no session, started in the host user's home directory.
  app.get("/api/terminals", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    return { terminals: ctx.terminals.listStandalone().map(info) };
  });

  app.post("/api/terminals", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const cwd = os.homedir();
    try {
      await stat(cwd);
    } catch {
      return reply.code(409).send({ error: `Home directory is missing: ${displayPath(cwd)}` });
    }
    return reply.code(201).send(info(ctx.terminals.create({ sessionId: null, cwd })));
  });

  app.delete<IdParams>("/api/terminals/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    if (!ctx.terminals.close(req.params.id)) return reply.code(404).send({ error: "Unknown terminal." });
    return reply.code(204).send();
  });

  app.get<IdParams>("/api/sessions/:id/terminals", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.sessions.ready;
    if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
    return { terminals: ctx.terminals.listBySession(req.params.id).map(info) };
  });

  app.post<IdParams>("/api/sessions/:id/terminals", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const { id } = req.params;
    await ctx.sessions.ready;
    const session = ctx.sessions.getSession(id);
    if (!session) return reply.code(404).send({ error: "Unknown session." });
    try {
      await stat(session.cwd);
    } catch {
      return reply.code(409).send({ error: `Working directory is missing: ${displayPath(session.cwd)}` });
    }
    return reply.code(201).send(info(ctx.terminals.create({ sessionId: id, cwd: session.cwd })));
  });
}
