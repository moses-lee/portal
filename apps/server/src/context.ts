/**
 * Everything a request handler or a background service may need, built once at boot in `app.ts`.
 * Services are created in dependency order and attached here, so a service that needs another one
 * reads it from the context at call time rather than at construction time.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Sql } from "postgres";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { presence as Presence } from "./lib/presence.ts";
import type { OrchestratorService } from "./orchestrator/service.ts";
import type { ProjectsService } from "./projects/service.ts";
import type { SessionsService } from "./sessions/service.ts";
import type { SettingsService } from "./settings/service.ts";
import type { TerminalsService } from "./terminals/service.ts";

export interface AppContext {
  config: ServerConfig;
  db: Db;
  sql: Sql;
  log: FastifyBaseLogger;
  /** How many browsers hold a long-lived event stream open; the orchestrator's scheduler reads it. */
  presence: typeof Presence;
  sessions: SessionsService;
  projects: ProjectsService;
  settings: SettingsService;
  terminals: TerminalsService;
  orchestrator: OrchestratorService;
}

/**
 * The live context, for the few legacy modules that still reach for process-wide singletons
 * (see `src/lib/acp.ts`, `src/lib/projects.ts`, ...). New code takes the context as a parameter.
 */
let current: AppContext | null = null;
const waiters: ((ctx: AppContext) => void)[] = [];

export function setContext(ctx: AppContext): void {
  current = ctx;
  for (const resolve of waiters.splice(0)) resolve(ctx);
}

export function context(): AppContext {
  if (!current) throw new Error("The server context is not set up yet.");
  return current;
}

export function whenContext(): Promise<AppContext> {
  return current ? Promise.resolve(current) : new Promise((resolve) => waiters.push(resolve));
}
