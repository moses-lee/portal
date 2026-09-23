import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";

/** `/api/projects/**`, `/api/fs/dirs`: ported from apps/web/src/app/api/{projects,fs}. */
export function registerProjectRoutes(_app: FastifyInstance, _ctx: AppContext): void {}
