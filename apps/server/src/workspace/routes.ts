/**
 * `/api/workspace/**`: the tab strip every device shows (docs/WORKSPACE.md). The page reads it once
 * and then follows `{ type: "workspace", workspace }` on `/api/portal/stream`; every edit is one
 * operation posted here, applied by the shared reducer on the server as it was applied
 * optimistically in the browser. Same-origin checked like every mutating route; both routes act
 * as the user.
 *
 *   GET  /api/workspace       -> { workspace }
 *   POST /api/workspace/ops   body: one WorkspaceOp -> { workspace, location? }
 *                                400 for a malformed op, 404 for an unknown session, tab, or pane,
 *                                409 when the reducer refuses (a cap reached, a session listed twice,
 *                                a Portal rename over the user's); errors are `{ error }`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseWorkspaceOp } from "@portal/shared/workspace";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { type WorkspaceService, workspaceErrorStatus } from "./service.ts";

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Same-origin check, then the workspace service; null when the request was already answered with a 403. */
  async function workspaceFor(req: FastifyRequest, reply: FastifyReply): Promise<WorkspaceService | null> {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    return ctx.orchestrator.hub.workspace;
  }

  app.get("/api/workspace", async (req, reply) => {
    const workspace = await workspaceFor(req, reply);
    if (!workspace) return reply;
    return { workspace: await workspace.read() };
  });

  app.post("/api/workspace/ops", async (req, reply) => {
    const workspace = await workspaceFor(req, reply);
    if (!workspace) return reply;
    try {
      const op = parseWorkspaceOp(req.body);
      const result = await workspace.apply(op, "user");
      return { workspace: result.workspace, ...(result.location ? { location: result.location } : {}) };
    } catch (err) {
      const status = workspaceErrorStatus(err);
      if (status === null) throw err;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
