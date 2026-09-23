/**
 * Builds the Fastify instance without listening, so tests can drive it with `app.inject()` and the
 * entry point can attach transports (Socket.IO) to `app.server` before `listen`. Services are
 * created here in dependency order and disposed in reverse when the app closes.
 */
import compress from "@fastify/compress";
import Fastify, { type FastifyInstance } from "fastify";
import { type ServerConfig, loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { type Db, connect } from "./db/client.ts";
import { type InstanceLock, acquireInstanceLock } from "./db/instance-lock.ts";
import { runMigrations } from "./db/migrate.ts";
import { errorMessage, errorStatus } from "./http/errors.ts";
import { closeEventStreams } from "./http/sse.ts";
import { importLegacyAtBoot } from "./import/boot.ts";
import { createPresence } from "./lib/presence.ts";
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
  /**
   * Refuse to boot while another app holds the database (see `db/instance-lock.ts`). Only honoured
   * with an injected `database`: tests that build several apps over one database turn it off.
   */
  singleInstance?: boolean;
}

/** Each app's context, for tests that reach past the routes (swap a service, spy on a dispose). */
const contexts = new WeakMap<FastifyInstance, AppContext>();

export function appContext(app: FastifyInstance): AppContext {
  const ctx = contexts.get(app);
  if (!ctx) throw new Error("Not an app built by buildApp.");
  return ctx;
}

export async function buildApp({ config = loadConfig(), database, logger = false, orchestrator = true, sessions, singleInstance = true }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(compress, { global: true, threshold: 1024, encodings: ["gzip"] });

  let owned: ReturnType<typeof connect> | null = null;
  let lock: InstanceLock | null = null;
  const ctx = { config, log: app.log, presence: createPresence() } as AppContext;
  try {
    if (!database) database = owned = connect(config.databaseUrl);
    // Before migrations, the import, or any service touching sessions: a second server must fail
    // here without writing anything the live one owns.
    if (singleInstance || owned) lock = await acquireInstanceLock(database.sql);
    if (owned) await runMigrations(owned.db);

    // Before any service loads its cache from the tables the import fills.
    await importLegacyAtBoot({ home: config.portalHome, db: database.db, log: app.log });

    ctx.db = database.db;
    ctx.sql = database.sql;
    ctx.sessions = createSessionsService(ctx, sessions);
    ctx.projects = createProjectsService(ctx);
    ctx.settings = createSettingsService(ctx);
    // A missing or broken server key fails the boot here rather than the first settings request.
    await ctx.settings.ready;
  } catch (err) {
    // A failed boot hands the database back, so the next attempt (or another app) can take it.
    await ctx.sessions?.dispose().catch(() => {});
    await lock?.release();
    await owned?.close();
    throw err;
  }
  contexts.set(app, ctx);
  ctx.terminals = createTerminalsService(ctx);
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

  // `preClose`, not `onClose`: Fastify runs `onClose` only once `server.close()` has seen every
  // in-flight request finish, and each open tab holds an event stream (a hijacked, never-ending
  // request), so disposal there would wait on the browsers. Runs after the terminals' own
  // `preClose` (registered above), which drops the WebSockets.
  app.addHook("preClose", async () => {
    const failed = (what: string) => (err: unknown) => app.log.error({ err }, `Could not stop ${what}`);
    // Stop the scheduler and any running turn before the sessions it may be driving go away.
    if (orchestrator) await ctx.orchestrator.dispose().catch(failed("the orchestrator"));
    closeEventStreams(app.server);
    // Stops the agent processes and flushes pending event writes, while the pool is still open.
    await ctx.sessions.dispose().catch(failed("the sessions"));
    ctx.terminals.disposeAll();
  });
  app.addHook("onClose", async () => {
    await lock?.release();
    await owned?.close();
  });

  return app;
}
