import { createProjectsStore } from "./projects-store";

// Keep the loaded project list alive across Next.js dev HMR, as acp.ts does for sessions.
const globalProjects = globalThis as unknown as {
  __portalProjects?: ReturnType<typeof createProjectsStore>;
};
export const projects = (globalProjects.__portalProjects ??= createProjectsStore());
