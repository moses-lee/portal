/**
 * The world tools: `resolve_pull`, `resolve_repo`, `resolve_session` (loose reference to full ids,
 * deterministically) and `get_world` (the rendered world with more room, or one slice as JSON).
 * Chat turns get all four; background turns only `resolve_pull` and `resolve_repo`.
 */
import type { WorldState } from "@portal/contracts/world";
import { z } from "zod";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { define } from "../tools/context.ts";
import { type PullLookupOptions, resolvePull, resolveRepo, resolveSession } from "./resolve.ts";
import type { RenderOptions } from "./render.ts";

/** Budgets for get_world's text: roomier than the prompt's section. */
export const GET_WORLD_TOKENS = 4000;
export const GET_WORLD_DETAIL_TOKENS = 8000;
/** Rows of a JSON slice (with `detail`, more). */
const SLICE_ROWS = 50;
const SLICE_DETAIL_ROWS = 200;

export const worldSlices = ["projects", "repos", "sessions", "terminals", "pulls", "intents", "jobs", "items", "errors"] as const;

export type WorldToolSource = {
  current(): Promise<WorldState | null>;
  refresh(reason: string): Promise<WorldState>;
  render(world: WorldState, opts?: RenderOptions): string;
};

export function worldTools(ctx: DomainToolContext, source: WorldToolSource, lookup: PullLookupOptions = {}): ToolSet {
  const world = async () => {
    const found = await source.current();
    if (!found) throw new Error("The world state is not available yet.");
    return found;
  };
  const tools: ToolSet = {
    resolve_pull: define(
      "Find a pull request by number (and optionally a repo name or owner/name): which repo it belongs to, its state and branches, the Portal project with that repo (projectId) and a worktree already on its branch (worktreeProjectId). Searches the user's PRs first, then asks GitHub in every repo Portal has. Returns { match } or { candidates, reason }.",
      z.object({ number: z.number().int().positive(), repo: z.string().optional() }),
      async ({ number, repo }) => resolvePull(await world(), ctx.deps, { number, repo }, lookup),
    ),
    resolve_repo: define(
      "Find a repository Portal has, by owner/name, name, project name, folder name, or a loose or misspelled version of any of them (\"the monorepo\", \"portal\"). Returns { match } with the repo, its default branch, main checkout projectId, and every project checked out from it, or { candidates, reason }.",
      z.object({ query: z.string().min(1) }),
      async ({ query }) => resolveRepo(await world(), query),
    ),
  };
  if (!ctx.interactive) return tools;
  return {
    ...tools,
    resolve_session: define(
      "Find a session by id or id prefix, title, words of its title, project name, or activity (waiting, working, idle, error). Returns { match } or { candidates, reason }, most recent first.",
      z.object({ query: z.string().min(1) }),
      async ({ query }) => resolveSession(await world(), query),
    ),
    get_world: define(
      "Portal's world state. Without scope: the rendered overview with more room than the prompt's section (detail: more still). With scope: that slice as JSON with full ids. refresh: rebuild first, including GitHub (slower).",
      z.object({ scope: z.enum(worldSlices).optional(), detail: z.boolean().optional(), refresh: z.boolean().optional() }),
      async ({ scope, detail, refresh }) => {
        const current = refresh ? await source.refresh("tool") : await world();
        if (!scope) {
          return { at: current.at, text: source.render(current, { budgetTokens: detail ? GET_WORLD_DETAIL_TOKENS : GET_WORLD_TOKENS, scope: ctx.turn.scope }) };
        }
        const rows = current[scope] as unknown[];
        const limit = detail ? SLICE_DETAIL_ROWS : SLICE_ROWS;
        return { at: current.at, [scope]: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
      },
    ),
  };
}
