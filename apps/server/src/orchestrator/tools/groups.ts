/**
 * Tool groups for chat turns. Every tool schema is re-sent on every model step, and a chat turn
 * offering all ~70 tools pays about 11k tokens a step for them. A chat turn therefore starts with
 * the tools most turns use; the rest sit in named groups the model loads with `use_tools` when a
 * request needs them, and they stay loaded for the rest of the turn. A tool no group names is
 * always offered, so a tool added later is never hidden by accident.
 */
import { z } from "zod";
import type { ToolSet } from "../hub.ts";
import { define } from "./context.ts";

/** The groups a chat turn can load, with what each is for. Tool names only; a name the turn lacks is ignored. */
export const TOOL_GROUPS = {
  items: { about: "change Needs-you items", tools: ["create_item", "update_item", "resolve_item", "snooze_item", "dismiss_item"] },
  projects: {
    about: "manage projects, clones, branches, worktrees",
    tools: [
      "get_project", "search_projects", "add_project", "remove_project", "rename_project", "restore_project", "list_removed_projects",
      "clone_repo", "fetch_repo", "pull_fast_forward", "list_directories", "create_worktree", "list_branches",
    ],
  },
  sessions: {
    about: "search, configure, reconnect, delete sessions; permissions; stop a turn",
    tools: ["search_sessions", "delete_session", "set_session_config", "reconnect_session", "answer_permission", "get_pending_permission", "cancel_turn", "stop_session", "list_agents"],
  },
  github: { about: "pull request lists and per-project GitHub state", tools: ["list_pulls", "get_github_status", "github_identity"] },
  jobs: { about: "inspect and change jobs, runs, intents", tools: ["list_jobs", "update_job", "list_runs", "update_intent"] },
  memory: { about: "propose, explain, forget memory records", tools: ["propose_memory", "explain_memory", "forget"] },
  threads: { about: "list and archive side threads", tools: ["list_threads", "archive_thread"] },
  settings: { about: "the tick schedule, the last tick, the digest, stored settings", tools: ["get_schedule", "get_last_tick", "get_tick_digest", "get_settings"] },
} as const satisfies Record<string, { about: string; tools: readonly string[] }>;

export type ToolGroup = keyof typeof TOOL_GROUPS;
export const toolGroups = Object.keys(TOOL_GROUPS) as ToolGroup[];

const grouped = new Set<string>(Object.values(TOOL_GROUPS).flatMap((group) => group.tools));

/** One line per group for the system prompt, naming only tools the turn has. */
export function toolGroupsGuidance(available: ReadonlySet<string>): string {
  const lines = toolGroups.flatMap((name) => {
    const tools = TOOL_GROUPS[name].tools.filter((tool) => available.has(tool));
    return tools.length ? [`- ${name}: ${TOOL_GROUPS[name].about} (${tools.join(", ")})`] : [];
  });
  if (!lines.length) return "";
  return `More tools load with use_tools({ groups }) and stay for the rest of the turn; load a group before calling its tools:\n${lines.join("\n")}`;
}

/** The part of a model's tool call the loader looks at and rewrites. */
export type RawToolCall = { toolName: string; input: string };

export type ToolLoader = {
  /** `use_tools`, to add to the turn's tools. */
  tool: ToolSet;
  /** The tools offered on the next step. */
  active(): string[];
  /**
   * A call to a tool whose group is not loaded yet becomes a `use_tools` call for that group, so
   * the model learns to call it again instead of the turn failing; null for any other call.
   */
  repair<T extends RawToolCall>(call: T): T | null;
};

/** The per-turn loader over the turn's whole tool set. */
export function createToolLoader(tools: ToolSet): ToolLoader {
  const names = Object.keys(tools);
  const loaded = new Set<string>(names.filter((name) => !grouped.has(name)));
  loaded.add("use_tools");
  const use_tools = define(
    "Load tool groups for the rest of this turn (see the list in your instructions).",
    z.object({ groups: z.array(z.enum(toolGroups as [ToolGroup, ...ToolGroup[]])).min(1), forTool: z.string().optional() }),
    async ({ groups, forTool }) => {
      const added: string[] = [];
      for (const group of groups) {
        for (const name of TOOL_GROUPS[group].tools) {
          if (name in tools && !loaded.has(name)) {
            loaded.add(name);
            added.push(name);
          }
        }
      }
      if (forTool) return { loaded: added, note: `${forTool} was not loaded yet, so it did not run. Its group is loaded now: call ${forTool} again.` };
      return { loaded: added, note: added.length ? "These tools are available from the next step." : "Those groups were already loaded." };
    },
  );
  const groupOf = (name: string) => toolGroups.find((group) => (TOOL_GROUPS[group].tools as readonly string[]).includes(name));
  return {
    tool: { use_tools },
    active: () => [...loaded],
    repair(call) {
      const group = call.toolName in tools && !loaded.has(call.toolName) ? groupOf(call.toolName) : undefined;
      if (!group) return null;
      return { ...call, toolName: "use_tools", input: JSON.stringify({ groups: [group], forTool: call.toolName }) };
    },
  };
}
