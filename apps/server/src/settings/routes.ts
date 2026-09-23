import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";

/**
 * `/api/settings`, as the web app's Next.js route served it. Store errors (`SettingsError` carries
 * its status) reach the global handler as `{ error }`, as the web route's `fail()` answered.
 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The web route guarded GET too; kept so another site cannot even probe which keys are stored.
  app.get("/api/settings", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    return { settings: await ctx.settings.read() };
  });

  app.patch("/api/settings", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body: unknown = req.body;
    if (body === undefined) return reply.code(400).send({ error: "Expected a JSON body." });
    return { settings: await ctx.settings.patch(body) };
  });
}
