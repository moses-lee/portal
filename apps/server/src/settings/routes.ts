import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { parseLastUsedPatch } from "./last-used.ts";

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

  /** The agent and per-agent settings the user last picked (see last-used.ts); the start page starts from them. */
  app.get("/api/last-used", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    return { lastUsed: await ctx.lastUsed.read() };
  });

  /** The start page's picks: `{agentId?, settings?: {[agentId]: {modes, configOptions}}}`; a record replaces that agent's. */
  app.patch("/api/last-used", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const patch = parseLastUsedPatch(req.body, ctx.sessions.listAgents().map((agent) => agent.id));
    return { lastUsed: await ctx.lastUsed.patch(patch) };
  });
}
