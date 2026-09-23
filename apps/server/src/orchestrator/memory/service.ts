/**
 * Curated memory. STUB (phase 2 step 1): CORE.md is the legacy memory text, capped as before, and
 * nothing is retrieved. Replaced in step 4 by entities, records, revisions, the validator, the
 * memory tools, CORE.md generation, scoped retrieval, and the import of the old memory text.
 */
import { MEMORY_PROMPT_BYTES, truncateBytes } from "../digest.ts";
import type { MemoryService, OrchestratorHub } from "../hub.ts";

export type MemoryOptions = Record<string, never>;

export function createMemoryService(hub: OrchestratorHub, _options: MemoryOptions = {}): MemoryService {
  return {
    ready: Promise.resolve(),
    async promptContext() {
      const text = truncateBytes(await hub.store.readMemory(), MEMORY_PROMPT_BYTES);
      return { core: { text, generatedAt: hub.timers.now(), tokens: Math.ceil(text.length / 4) }, retrieved: "" };
    },
    inboxCount: async () => 0,
    tools: () => ({}),
  };
}
