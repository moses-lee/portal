/**
 * Builds the Fastify instance without listening, so tests can drive it with `app.inject()` and the
 * entry point can attach transports (Socket.IO) to `app.server` before `listen`.
 */
import Fastify, { type FastifyInstance } from "fastify";

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp({ logger = false }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({ ok: true, service: "portal-server" }));

  return app;
}
