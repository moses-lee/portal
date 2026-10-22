/**
 * `/api/workspace/**`: the tab strip every device shows (docs/WORKSPACE.md). The page reads it once
 * and then follows `{ type: "workspace", workspace }` on `/api/portal/stream`; every edit is one
 * operation posted here, applied by the shared reducer on the server as it was applied
 * optimistically in the browser. Same-origin checked like every mutating route; both routes act
 * as the user: a `rename_tab`'s `source` and an `arrange`'s `titleSource` are stamped `user` whatever
 * the body said.
 *
 *   GET  /api/workspace       -> { workspace }
 *   POST /api/workspace/focus body: { deviceId, sessionId: string | null, visible } -> { ok: true }
 *                                what one device shows, sent on every change and every 30 s; a watch
 *                                does not report a session event while a device shows that session
 *   POST /api/workspace/ops   body: one WorkspaceOp -> { workspace, location? }
 *                                400 for a malformed op, 404 for an unknown session, tab, or pane,
 *                                409 when the reducer refuses (a cap reached, a session listed twice,
 *                                a Portal rename over the user's); errors are `{ error }`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkspaceOp } from "@portal/contracts/workspace";
import { parseWorkspaceOp } from "@portal/shared/workspace";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { errorMessage } from "../orchestrator/tools/context.ts";
import { type WorkspaceService, workspaceErrorStatus } from "./service.ts";

/** The op as the user: whatever the body claimed, a rename and an arrange's title are the user's (the orchestrator's tools say `portal` through the service, not here). */
function asUser(op: WorkspaceOp): WorkspaceOp {
  if (op.op === "rename_tab") return { ...op, source: "user" };
  if (op.op === "arrange" && op.title !== undefined) return { ...op, titleSource: "user" };
  return op;
}

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

  app.post("/api/workspace/focus", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body = (req.body ?? {}) as { deviceId?: unknown; sessionId?: unknown; visible?: unknown };
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 100) return reply.code(400).send({ error: "deviceId must be a non-empty string of at most 100 characters." });
    if (body.sessionId !== null && typeof body.sessionId !== "string") return reply.code(400).send({ error: "sessionId must be a string or null." });
    if (typeof body.visible !== "boolean") return reply.code(400).send({ error: "visible must be a boolean." });
    ctx.presence.focus(deviceId, { sessionId: body.sessionId || null, visible: body.visible });
    return { ok: true };
  });

  app.post("/api/workspace/ops", async (req, reply) => {
    const workspace = await workspaceFor(req, reply);
    if (!workspace) return reply;
    try {
      const op = asUser(parseWorkspaceOp(req.body));
      const result = await workspace.apply(op, "user");
      return { workspace: result.workspace, ...(result.location ? { location: result.location } : {}) };
    } catch (err) {
      const status = workspaceErrorStatus(err);
      if (status === null) throw err;
      return reply.code(status).send({ error: errorMessage(err) });
    }
  });
}
