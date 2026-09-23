import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";

/** `/api/agents`, `/api/sessions/**`: ported from apps/web/src/app/api/{agents,sessions}. */
export function registerSessionRoutes(_app: FastifyInstance, _ctx: AppContext): void {}
