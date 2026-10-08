/** `GET /api/search?q=`: message hits and PR-associated sessions (docs/SEARCH.md). */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { query } from "../http/query.ts";
import { createSearchService } from "./service.ts";

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext) {
  const search = createSearchService({
    db: ctx.db,
    // Both load their lists at boot; a search that early waits for them rather than finding nothing.
    sessions: async () => {
      await ctx.sessions.ready;
      return ctx.sessions.listSessions();
    },
    projects: async () => {
      await ctx.projects.ready;
      return ctx.projects.list();
    },
  });

  // Read-only, so no same-origin guard, like the other GETs. `q` past `QUERY_MAX` is cut, not refused.
  app.get("/api/search", async (req) => search.search(query(req, "q") ?? ""));
}
