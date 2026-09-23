/**
 * Variables `next dev` sets on its own process. Portal's server runs Next in-process, so without
 * this every child it spawns (agents, embedded terminals) would inherit them and, for example,
 * `next build` in such a shell would build development React and fail prerendering.
 */
export const NEXT_DEV_SERVER_VARS = ["NODE_ENV", "TURBOPACK", "NEXT_DEPLOYMENT_ID", "__NEXT_DEV_SERVER"] as const;

/** `base` without the variables the dev server set for itself; the shell gets the user's environment, not Next's. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of NEXT_DEV_SERVER_VARS) delete env[name];
  return env;
}
