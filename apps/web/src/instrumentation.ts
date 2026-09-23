/**
 * Runs once when the Next server starts. Bringing the orchestrator up here starts its scheduler at
 * boot, so ticks happen whether or not a browser ever opens Talk to Portal. Node only: the runtime
 * spawns processes and reads files that the edge runtime has no access to.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getOrchestrator } = await import("@/lib/orchestrator/runtime");
  getOrchestrator();
}
