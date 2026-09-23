/**
 * Variables `next dev` sets on its own process. The server picks them up when it is started from a
 * shell that inherited them (a terminal inside a Portal whose web app runs under `next dev`), so
 * without this every child it spawns (agents, embedded terminals) would pass them on and, for
 * example, `next build` in such a shell would build development React and fail prerendering.
 */
export const NEXT_DEV_SERVER_VARS = ["NODE_ENV", "TURBOPACK", "NEXT_DEPLOYMENT_ID", "__NEXT_DEV_SERVER"] as const;

/** `base` without the variables the dev server set for itself; the shell gets the user's environment, not Next's. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of NEXT_DEV_SERVER_VARS) delete env[name];
  return env;
}
