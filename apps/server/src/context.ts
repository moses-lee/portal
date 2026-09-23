/**
 * Everything a request handler or a background service may need, built once at boot in `app.ts`.
 * Services are created in dependency order and attached here, so a service that needs another one
 * reads it from the context at call time rather than at construction time.
 */
import type { FastifyBaseLogger } from "fastify";
import type { Sql } from "postgres";
import type { ServerConfig } from "./config.ts";
import type { Db } from "./db/client.ts";
import type { Presence } from "./lib/presence.ts";
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
  presence: Presence;
  sessions: SessionsService;
  projects: ProjectsService;
  settings: SettingsService;
  terminals: TerminalsService;
  orchestrator: OrchestratorService;
}
