/**
 * `/api/portal/approvals/**`: the pending requests the approvals dialog shows, the user's decision
 * (the only way anything is ever approved), and the grants list with revoke. Same-origin checked
 * like every Portal route; errors carry their HTTP status.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.ts";
import { rejectCrossOrigin } from "../../http/origin.ts";
import { httpError } from "../ops.ts";
import { type ApprovalsDomain, isApprovalScope, isApprovalStatus, isApprovalsDomain } from "./service.ts";

type IdParams = { Params: { id: string } };

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Same-origin check, then the approvals service; null when the request was already answered with a 403. */
  async function approvalsFor(req: FastifyRequest, reply: FastifyReply): Promise<ApprovalsDomain | null> {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    const service = ctx.orchestrator.hub.approvals;
    if (!isApprovalsDomain(service)) throw httpError("Approvals are not available.", 501);
    return service;
  }

  /** `GET /api/portal/approvals?status=<s>` — `{ approvals }`, newest first; pending unless `status` says otherwise. */
  app.get("/api/portal/approvals", async (req, reply) => {
    const approvals = await approvalsFor(req, reply);
    if (!approvals) return reply;
    const { status = "pending" } = req.query as { status?: unknown };
    if (!isApprovalStatus(status)) return reply.code(400).send({ error: "\"status\" must be one of pending, approved, denied, expired, cancelled." });
    return { approvals: await approvals.list({ status: [status] }) };
  });

  /** `POST /api/portal/approvals/:id/decide` — body `{ approve, scope? }` -> `{ approval }` (after the approved call ran). */
  app.post<IdParams>("/api/portal/approvals/:id/decide", async (req, reply) => {
    const approvals = await approvalsFor(req, reply);
    if (!approvals) return reply;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply.code(400).send({ error: "Expected a JSON object body." });
    const { approve, scope } = body as Record<string, unknown>;
    if (typeof approve !== "boolean") return reply.code(400).send({ error: "\"approve\" must be true or false." });
    if (scope !== undefined && !isApprovalScope(scope)) return reply.code(400).send({ error: "\"scope\" must be one of once, job, repo, always." });
    return { approval: await approvals.decide(req.params.id, { approve, scope }) };
  });

  /** `GET /api/portal/approvals/grants` — `{ grants }`: the active ones, newest first. */
  app.get("/api/portal/approvals/grants", async (req, reply) => {
    const approvals = await approvalsFor(req, reply);
    if (!approvals) return reply;
    return { grants: await approvals.grants() };
  });

  /** `DELETE /api/portal/approvals/grants/:id` — revoke; 204, or 404 for an unknown grant. */
  app.delete<IdParams>("/api/portal/approvals/grants/:id", async (req, reply) => {
    const approvals = await approvalsFor(req, reply);
    if (!approvals) return reply;
    await approvals.revokeGrant(req.params.id);
    return reply.code(204).send();
  });
}
