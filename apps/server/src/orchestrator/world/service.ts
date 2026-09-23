/**
 * World state. STUB (phase 2 step 1): nothing is built yet, so prompts carry no world section.
 * Replaced in step 3 by the builder over projects, repos, worktrees, sessions, terminals and PRs,
 * the token-budgeted renderer, `world_snapshots`, and the resolve tools.
 */
import type { OrchestratorHub, WorldService } from "../hub.ts";

export type WorldOptions = Record<string, never>;

export function createWorldService(_hub: OrchestratorHub, _options: WorldOptions = {}): WorldService {
  return {
    ready: Promise.resolve(),
    current: async () => null,
    refresh: async () => {
      throw new Error("World state is not built yet.");
    },
    render: () => "",
    tools: () => ({}),
  };
}
