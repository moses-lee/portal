/** Transitional: the projects service as the module the Next.js app exposed. Delete once nothing imports it. */
import { context, whenContext } from "../context.ts";
import type { ProjectsService } from "../projects/service.ts";

const ready: Promise<void> = whenContext().then((ctx) => ctx.projects.ready);
export const projects: ProjectsService = new Proxy({} as ProjectsService, {
  get(_target, key: keyof ProjectsService) {
    if (key === "ready") return ready;
    return (...args: unknown[]) => (context().projects[key] as (...a: unknown[]) => unknown)(...args);
  },
});
