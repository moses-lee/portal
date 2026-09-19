import { createOrchestratorStore, defaultOrchestratorDir } from "./store.ts";
import type { OrchestratorStore } from "./types.ts";

// Keep one store (its loaded state and write queues) alive across Next.js dev HMR, as settings-storage.ts does.
const globalOrchestrator = globalThis as unknown as {
  __portalOrchestratorStore?: OrchestratorStore;
};

export function getOrchestratorStore(): OrchestratorStore {
  return (globalOrchestrator.__portalOrchestratorStore ??= createOrchestratorStore({ dir: defaultOrchestratorDir() }));
}
