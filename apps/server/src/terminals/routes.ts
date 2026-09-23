import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";

/** `/api/terminals/**`, `/api/sessions/:id/terminals`, and the Socket.IO server: ported from apps/web. */
export function registerTerminalRoutes(_app: FastifyInstance, _ctx: AppContext): void {}
