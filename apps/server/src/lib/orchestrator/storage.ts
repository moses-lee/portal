/** Transitional: the orchestrator's file store. The orchestrator service replaces this with the Postgres store. */
import { createOrchestratorStore, defaultOrchestratorDir } from "./store.ts";
import type { OrchestratorStore } from "./types.ts";

let store: OrchestratorStore | undefined;

export function getOrchestratorStore(): OrchestratorStore {
  return (store ??= createOrchestratorStore({ dir: defaultOrchestratorDir() }));
}
