/**
 * Talk to Portal: the orchestrator runtime over the Postgres stores and the server's own services.
 * Creating it starts the scheduler and the job worker, so background work runs from boot whether
 * or not a browser ever opens the page.
 */
import type { AppContext } from "../context.ts";
import { createPgActivityStore } from "./activity/pg-store.ts";
import { liveDeps, liveSettingsStore } from "./deps.ts";
import { type OrchestratorRuntimeOptions, createOrchestratorRuntime } from "./runtime.ts";
import type { OrchestratorRuntime } from "./types.ts";
import { createPgOrchestratorStore } from "./pg-store.ts";

export type OrchestratorService = OrchestratorRuntime;

/** Replacements for the live pieces; tests pass a fake model (and fake deps) so no provider is ever called. */
export type OrchestratorOptions = Partial<OrchestratorRuntimeOptions>;

export function createOrchestratorService(
  ctx: Pick<AppContext, "db" | "sql" | "presence" | "sessions" | "projects" | "settings" | "terminals">,
  options: OrchestratorOptions = {},
): OrchestratorService {
  return createOrchestratorRuntime({
    store: createPgOrchestratorStore({ db: ctx.db }),
    activityStore: createPgActivityStore({ db: ctx.db }),
    settingsStore: liveSettingsStore(ctx),
    deps: liveDeps(ctx),
    presence: ctx.presence,
    db: ctx.db,
    sql: ctx.sql,
    ...options,
  });
}
