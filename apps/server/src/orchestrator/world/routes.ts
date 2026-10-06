/**
 * `/api/portal/world/**`: the world as the UI's System view shows it, each answer `{ world,
 * rendered, tokens }` with the rendering the prompt would carry. Same-origin checked like every
 * Portal route.
 */
import type { WorldResponse, WorldState } from "@portal/contracts/world";
import type { Workspace } from "@portal/contracts/workspace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../context.ts";
import { rejectCrossOrigin } from "../../http/origin.ts";
import type { WorldService } from "../hub.ts";
import { estimateTokens } from "./render.ts";
import type { WorldDomainService } from "./service.ts";

type World = WorldService & Partial<Pick<WorldDomainService, "ensureBuilt">>;

/** The rendering the prompt would carry, Workspace tabs section included (the workspace is read beside the world, not part of it). */
function answer(world: World, state: WorldState, workspace: Workspace | null): WorldResponse {
  const rendered = world.render(state, { workspace });
  return { world: state, rendered, tokens: estimateTokens(rendered) };
}

export function registerWorldRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function worldFor(req: FastifyRequest, reply: FastifyReply): Promise<World | null> {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    return ctx.orchestrator.hub.world as World;
  }
  const workspace = () => ctx.orchestrator.hub.workspace.read().catch(() => null);

  /** `GET /api/portal/world` — the latest world; the first request builds one when none exists. */
  app.get("/api/portal/world", async (req, reply) => {
    const world = await worldFor(req, reply);
    if (!world) return reply;
    const state = world.ensureBuilt ? await world.ensureBuilt() : ((await world.current()) ?? (await world.refresh("first request")));
    return answer(world, state, await workspace());
  });

  /** `POST /api/portal/world/refresh` — rebuild now, GitHub included. */
  app.post("/api/portal/world/refresh", async (req, reply) => {
    const world = await worldFor(req, reply);
    if (!world) return reply;
    return answer(world, await world.refresh("manual"), await workspace());
  });
}
