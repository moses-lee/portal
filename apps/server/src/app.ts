/**
 * Builds the Fastify instance without listening, so tests can drive it with `app.inject()` and the
 * entry point can attach transports (Socket.IO) to `app.server` before `listen`. Services are
 * created here in dependency order and disposed in reverse when the app closes.
 */
import compress from "@fastify/compress";
import Fastify, { type FastifyInstance } from "fastify";
import { type ServerConfig, loadConfig } from "./config.ts";
import { type AppContext, setContext } from "./context.ts";
import { type Db, connect } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { errorMessage, errorStatus } from "./http/errors.ts";
import { importLegacyAtBoot } from "./import/boot.ts";
import { presence } from "./lib/presence.ts";
import { type OrchestratorOptions, createOrchestratorService } from "./orchestrator/service.ts";
import { registerOrchestratorRoutes } from "./orchestrator/routes.ts";
import { createProjectsService } from "./projects/service.ts";
import { registerProjectRoutes } from "./projects/routes.ts";
import { type SessionsOptions, createSessionsService } from "./sessions/service.ts";
import { registerSessionRoutes } from "./sessions/routes.ts";
import { createSettingsService } from "./settings/service.ts";
import { registerSettingsRoutes } from "./settings/routes.ts";
import { createTerminalsService } from "./terminals/service.ts";
import { registerTerminalRoutes } from "./terminals/routes.ts";

export interface AppOptions {
  config?: ServerConfig;
  /** An open database (tests pass a throwaway one). When omitted the app connects and migrates itself. */
  database?: { db: Db; sql: AppContext["sql"]; close?: () => Promise<void> };
  logger?: boolean;
  /** Skip the orchestrator (its scheduler and model calls) — for tests of the other routes. An object swaps in fakes (model, deps, timers). */
  orchestrator?: boolean | OrchestratorOptions;
  /** Sessions overrides (tests swap in a fake ACP agent). */
  sessions?: SessionsOptions;
}

export async function buildApp({ config = loadConfig(), database, logger = false, orchestrator = true, sessions }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(compress, { global: true, threshold: 1024, encodings: ["gzip"] });

  let owned: ReturnType<typeof connect> | null = null;
  if (!database) {
    owned = connect(config.databaseUrl);
    await runMigrations(owned.db);
    database = owned;
  }

  // Before any service loads its cache from the tables the import fills.
  await importLegacyAtBoot({ home: config.portalHome, db: database.db, log: app.log });

  const ctx = { config, db: database.db, sql: database.sql, log: app.log, presence } as AppContext;
  ctx.sessions = createSessionsService(ctx, sessions);
  ctx.projects = createProjectsService(ctx);
  ctx.settings = createSettingsService(ctx);
  // A missing or broken server key fails the boot here rather than the first settings request.
  await ctx.settings.ready;
  ctx.terminals = createTerminalsService(ctx);
  setContext(ctx);
  if (orchestrator) ctx.orchestrator = createOrchestratorService(ctx, typeof orchestrator === "object" ? orchestrator : {});

  app.setErrorHandler((err, _req, reply) => {
    const status = errorStatus(err) ?? (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    void reply.code(status).send({ error: errorMessage(err) });
  });

  app.get("/api/health", async () => ({ ok: true, service: "portal-server" }));
  registerSessionRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerTerminalRoutes(app, ctx);
  if (orchestrator) registerOrchestratorRoutes(app, ctx);

  app.addHook("onClose", async () => {
    // Stop the scheduler and any running turn before the sessions it may be driving go away.
    if (orchestrator) await ctx.orchestrator.dispose().catch(() => {});
    await ctx.sessions.dispose().catch(() => {});
    ctx.terminals.disposeAll();
    await owned?.close();
  });

  return app;
}
