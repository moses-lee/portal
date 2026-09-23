/** Projects and removed projects, in Postgres behind an in-memory cache (see store.ts). */
import type { AppContext } from "../context.ts";
import { createPgProjectsStore } from "./pg-store.ts";
import type { ProjectsStore } from "./store.ts";

export type ProjectsService = ProjectsStore;

export function createProjectsService(ctx: Pick<AppContext, "db" | "log">): ProjectsService {
  const store = createPgProjectsStore({ db: ctx.db });
  store.ready.catch((err: unknown) => ctx.log.error({ err }, "Could not load projects"));
  return store;
}
