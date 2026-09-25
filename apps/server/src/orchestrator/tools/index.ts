/**
 * The classic tools the orchestrator's model can call, built over one `ToolContext` per turn (each
 * domain adds its own, see `turn.ts`). A background turn that does not name its tools gets only
 * `BACKGROUND_TOOLS`: tool schemas are re-sent on every model step, so the subset is the largest
 * token saving there is, and it keeps anything destructive (deleting sessions, removing worktrees,
 * running commands) out of unattended runs.
 */
import { compositeTools } from "./composite.ts";
import { type ToolContext, withRedaction } from "./context.ts";
import { githubTools } from "./github.ts";
import { itemTools } from "./items.ts";
import { projectTools } from "./projects.ts";
import { sessionTools } from "./sessions.ts";
import { shellTools } from "./shell.ts";

export type { ToolContext } from "./context.ts";

function allTools(ctx: ToolContext) {
  return {
    ...projectTools(ctx),
    ...githubTools(ctx),
    ...sessionTools(ctx),
    ...shellTools(ctx),
    ...itemTools(ctx),
    ...compositeTools(ctx),
  };
}

export type OrchestratorTools = ReturnType<typeof allTools>;

/** The tools a background turn gets unless it names its own: items and read-only looks at sessions and PRs (memory, world, and job tools come from their domains). */
export const BACKGROUND_TOOLS = [
  "list_items", "create_item", "update_item", "resolve_item", "snooze_item", "dismiss_item",
  "list_sessions", "get_session", "read_transcript", "get_pull", "get_github_status",
] as const satisfies readonly (keyof OrchestratorTools)[];

const backgroundToolSet = new Set<string>(BACKGROUND_TOOLS);

/**
 * Tools that only look, in every domain. A job's run calls any other tool only while its job is
 * still wanted (see `turn.ts`), so a tool missing here is checked, never let through unchecked.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "use_tools",
  "list_projects", "get_project", "search_projects", "list_removed_projects", "list_directories", "list_branches", "read_file",
  "list_sessions", "list_active_sessions", "get_session", "search_sessions", "read_transcript", "get_pending_permission", "list_agents",
  "list_attention_pulls", "list_pulls", "get_pull", "get_github_status", "github_identity",
  "list_items", "list_threads", "get_settings", "get_schedule",
  "list_jobs", "list_runs", "list_intents",
  "get_world", "get_changes", "resolve_pull", "resolve_repo", "resolve_session",
  "search_memory", "explain_memory",
]);

export function createTools(ctx: ToolContext): OrchestratorTools {
  const tools = withRedaction(ctx, allTools(ctx));
  if (ctx.interactive) return tools;
  // The subset is typed as the whole set: the agent only needs a tool set, and the names are checked above.
  return Object.fromEntries(Object.entries(tools).filter(([name]) => backgroundToolSet.has(name))) as OrchestratorTools;
}
