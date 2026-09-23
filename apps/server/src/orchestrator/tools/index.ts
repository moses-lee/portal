/**
 * Every tool the orchestrator's model can call, built over one `ToolContext` per turn. A tick gets
 * only `TICK_TOOLS`: tool schemas are re-sent on every model step, so the subset is the largest
 * token saving there is, and it keeps anything destructive (deleting sessions, removing worktrees,
 * running commands) out of unattended runs.
 */
import { compositeTools } from "./composite.ts";
import { type ToolContext, withRedaction } from "./context.ts";
import { githubTools } from "./github.ts";
import { itemTools } from "./items.ts";
import { projectTools } from "./projects.ts";
import { selfTools } from "./self.ts";
import { sessionTools } from "./sessions.ts";
import { shellTools } from "./shell.ts";
import { watchTools } from "./watches.ts";

export type { Schedule, ToolContext } from "./context.ts";

function allTools(ctx: ToolContext) {
  return {
    ...projectTools(ctx),
    ...githubTools(ctx),
    ...sessionTools(ctx),
    ...shellTools(ctx),
    ...itemTools(ctx),
    ...watchTools(ctx),
    ...selfTools(ctx),
    ...compositeTools(ctx),
  };
}

export type OrchestratorTools = ReturnType<typeof allTools>;

/** The tools a tick may call: items, watches, and read-only looks at sessions and PRs (memory tools come from the memory domain). */
export const TICK_TOOLS = [
  "list_items", "create_item", "update_item", "resolve_item", "snooze_item", "dismiss_item",
  "create_watch", "update_watch", "list_watches", "close_watch",
  "list_sessions", "get_session", "read_transcript", "get_pull", "get_github_status",
] as const satisfies readonly (keyof OrchestratorTools)[];

const tickToolSet = new Set<string>(TICK_TOOLS);

export function createTools(ctx: ToolContext): OrchestratorTools {
  const tools = withRedaction(ctx, allTools(ctx));
  if (ctx.interactive) return tools;
  // The subset is typed as the whole set: the agent only needs a tool set, and the names are checked above.
  return Object.fromEntries(Object.entries(tools).filter(([name]) => tickToolSet.has(name))) as OrchestratorTools;
}
