/**
 * Talk to Portal: the orchestrator runtime over the Postgres store and the server's own services.
 * Creating it starts the scheduler, so ticks run from boot whether or not a browser ever opens the
 * page.
 */
import type { AppContext } from "../context.ts";
import { liveDeps, liveSettingsStore } from "../lib/orchestrator/deps.ts";
import { type OrchestratorRuntimeOptions, createOrchestratorRuntime } from "../lib/orchestrator/runtime.ts";
import type { OrchestratorRuntime } from "../lib/orchestrator/types.ts";
import { createPgOrchestratorStore } from "./pg-store.ts";

export type OrchestratorService = OrchestratorRuntime;

/** Replacements for the live pieces; tests pass a fake model (and fake deps) so no provider is ever called. */
export type OrchestratorOptions = Partial<OrchestratorRuntimeOptions>;

export function createOrchestratorService(
  ctx: Pick<AppContext, "db" | "presence" | "sessions" | "projects" | "settings">,
  options: OrchestratorOptions = {},
): OrchestratorService {
  return createOrchestratorRuntime({
    store: createPgOrchestratorStore({ db: ctx.db }),
    settingsStore: liveSettingsStore(ctx),
    deps: liveDeps(ctx),
    presence: ctx.presence,
    ...options,
  });
}
