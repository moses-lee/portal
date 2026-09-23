/** Talk to Portal. TODO(phase 1): Postgres store, deps from the context instead of module singletons. */
import type { AppContext } from "../context.ts";
import { getOrchestrator } from "../lib/orchestrator/runtime.ts";
import type { OrchestratorRuntime } from "../lib/orchestrator/types.ts";

export type OrchestratorService = OrchestratorRuntime;

export function createOrchestratorService(_ctx: Pick<AppContext, "db" | "log">): OrchestratorService {
  return getOrchestrator();
}
