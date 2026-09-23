/**
 * Server configuration from the environment. Everything has a development default so `pnpm dev`
 * works with no setup beyond `pnpm db:up`.
 */
import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  /** Port the HTTP API listens on. Next.js proxies `/api/*` here. */
  port: number;
  /** Interface to bind. Loopback by default: the browser reaches the API through the Next.js proxy. */
  host: string;
  /** Postgres connection string. */
  databaseUrl: string;
  /** Portal's private directory (`server.key`, the legacy JSON stores). */
  portalHome: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORTAL_SERVER_PORT ?? 3100);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORTAL_SERVER_PORT must be a port number, got ${JSON.stringify(env.PORTAL_SERVER_PORT)}`);
  }
  return {
    port,
    host: env.PORTAL_SERVER_HOST ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal",
    portalHome: env.PORTAL_HOME || path.join(os.homedir(), ".portal"),
  };
}
