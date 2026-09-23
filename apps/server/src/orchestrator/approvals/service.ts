/**
 * Approvals. STUB (phase 2 step 1): nothing is gated, as before. Replaced in step 5 by the gate
 * over destructive, writing, and outbound tools, scoped grants, the pending-approval flow for chat
 * turns and jobs, and the guard on server-side card actions.
 */
import type { ApprovalsService, OrchestratorHub } from "../hub.ts";

export type ApprovalsOptions = Record<string, never>;

export function createApprovalsService(_hub: OrchestratorHub, _options: ApprovalsOptions = {}): ApprovalsService {
  return {
    ready: Promise.resolve(),
    gate: (tools) => tools,
    pending: async () => [],
    hasPendingFor: async () => false,
    guardAction: async () => null,
  };
}
