/** Projects and removed projects. TODO(phase 1): Postgres store behind the same interface. */
import type { AppContext } from "../context.ts";
import { type ProjectsStore, createProjectsStore } from "../lib/projects-store.ts";

export type ProjectsService = ProjectsStore;

export function createProjectsService(_ctx: Pick<AppContext, "db" | "log">): ProjectsService {
  return createProjectsStore();
}
