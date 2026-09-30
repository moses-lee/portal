/**
 * `/api/portal/tracked/**`: the tracked sessions the right sidebar lists, and the user's track and
 * untrack (recorded as `trackedBy: "user"` and logged). Same-origin checked like every Portal route.
 * The list also reaches the page live, as `{ type: "tracked", sessions }` on `/api/portal/stream`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.ts";
import { rejectCrossOrigin } from "../../http/origin.ts";
import type { TrackedService } from "./service.ts";

type SessionParams = { Params: { sessionId: string } };

export function registerTrackedRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Same-origin check, then the tracked sessions service; null when the request was already answered with a 403. */
  async function trackedFor(req: FastifyRequest, reply: FastifyReply): Promise<TrackedService | null> {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    return ctx.orchestrator.hub.tracked;
  }

  /** `GET /api/portal/tracked` — `{ sessions }`, oldest first. */
  app.get("/api/portal/tracked", async (req, reply) => {
    const tracked = await trackedFor(req, reply);
    if (!tracked) return reply;
    return { sessions: await tracked.list() };
  });

  /** `PUT /api/portal/tracked/:sessionId` — track (idempotent) -> `{ session }`; 404 when the session does not exist. */
  app.put<SessionParams>("/api/portal/tracked/:sessionId", async (req, reply) => {
    const tracked = await trackedFor(req, reply);
    if (!tracked) return reply;
    const result = await tracked.track(req.params.sessionId, "user");
    if (!result) return reply.code(404).send({ error: "Unknown session." });
    return { session: result.session };
  });

  /** `DELETE /api/portal/tracked/:sessionId` — untrack; 204 whether or not it was tracked. */
  app.delete<SessionParams>("/api/portal/tracked/:sessionId", async (req, reply) => {
    const tracked = await trackedFor(req, reply);
    if (!tracked) return reply;
    await tracked.untrack(req.params.sessionId, "user");
    return reply.code(204).send();
  });
}
