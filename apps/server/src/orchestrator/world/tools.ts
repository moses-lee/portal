/**
 * The world tools: `resolve_pull`, `resolve_repo`, `resolve_session` (loose reference to full ids,
 * deterministically), `get_world` (the rendered world with more room, or one slice as JSON), and
 * `get_changes` (the change log, unfiltered by freshness). Chat turns get all five; background
 * turns only `resolve_pull` and `resolve_repo`.
 */
import type { WorldState } from "@portal/contracts/world";
import { z } from "zod";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { httpError } from "../ops.ts";
import { define } from "../tools/context.ts";
import { type ChangeStore, MAX_CHANGE_LIMIT, type WorldChange } from "./changes.ts";
import { type PullLookupOptions, resolvePull, resolveRepo, resolveSession } from "./resolve.ts";
import type { RenderOptions } from "./render.ts";

/** Budgets for get_world's text: roomier than the prompt's section. */
export const GET_WORLD_TOKENS = 4000;
export const GET_WORLD_DETAIL_TOKENS = 8000;
/** Rows of a JSON slice (with `detail`, more). */
const SLICE_ROWS = 50;
const SLICE_DETAIL_ROWS = 200;

export const worldSlices = ["projects", "repos", "sessions", "terminals", "pulls", "intents", "jobs", "items", "errors"] as const;

/** get_changes looks back this far unless told otherwise, and answers this many rows by default and at most. */
export const DEFAULT_CHANGES_SINCE_MS = 24 * 60 * 60_000;
export const DEFAULT_CHANGES_ROWS = 25;
export const MAX_CHANGES_ROWS = 100;

const RELATIVE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i;
const unitMs: Record<string, number> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000, w: 7 * 24 * 60 * 60_000 };

/** `since` as get_changes takes it: relative ("30m", "2h", "1d", "1w") or an ISO 8601 time; absent means a day back. */
export function parseSince(value: string | undefined, now: number): number {
  if (value === undefined || !value.trim()) return now - DEFAULT_CHANGES_SINCE_MS;
  const text = value.trim();
  const relative = RELATIVE.exec(text);
  if (relative) return now - Math.round(Number(relative[1]) * unitMs[relative[2][0].toLowerCase()]);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) throw httpError(`since "${value}" is neither a relative time like "2h" or "1d" nor an ISO 8601 time.`, 400);
  return at;
}

/**
 * Whether a change is about `about`: every word of it appears in the change's summary, subject,
 * or refs (repo, "#n", session id, project id and name). "acme/app#12", "#12", "login bug", a
 * session id prefix, and a project name all work.
 */
export function changeMatches(change: WorldChange, about: string | undefined, projectName: (id: string) => string | undefined = () => undefined): boolean {
  const words = (about ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const { pull, sessionId, projectId } = change.refs;
  const haystack = [
    change.summary, change.subject, change.detail ?? "", pull ? `${pull.repo}#${pull.number} ${pull.url}` : "", sessionId ?? "", projectId ?? "",
    projectId ? projectName(projectId) ?? "" : "",
  ].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

function changeRow(change: WorldChange) {
  const { pull, sessionId, projectId } = change.refs;
  return {
    at: new Date(change.at).toISOString(), kind: change.kind, summary: change.summary, ...(change.detail ? { detail: change.detail } : {}),
    ...(pull ? { pull: `${pull.repo}#${pull.number}` } : {}), ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}),
    mine: change.mine, fingerprint: change.fingerprint,
  };
}

export type WorldToolSource = {
  current(): Promise<WorldState | null>;
  refresh(reason: string): Promise<WorldState>;
  render(world: WorldState, opts?: RenderOptions): string;
  changes: Pick<ChangeStore, "list">;
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
      "Find a session by id or id prefix, title, words of its title, project name, activity (waiting, working, idle, error), or liveness (hung, dead, stalled for either). Returns { match } or { candidates, reason }, most recent first.",
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
    get_changes: define(
      "What changed in the user's world (PRs, review requests, sessions, worktrees, folders), newest first, one line per subject at its latest state; not filtered for relevance. since: \"2h\", \"1d\", \"1w\" or an ISO time (default 1d). about: words, a PR (owner/name#n or #n), a session id, or a project name.",
      z.object({ since: z.string().optional(), about: z.string().optional(), limit: z.number().int().min(1).max(MAX_CHANGES_ROWS).optional() }),
      async ({ since, about, limit = DEFAULT_CHANGES_ROWS }) => {
        const from = parseSince(since, ctx.now());
        const known = await source.current().catch(() => null);
        const projectName = (id: string) => known?.projects.find((project) => project.id === id)?.name;
        const matching = (await source.changes.list({ since: from, limit: MAX_CHANGE_LIMIT })).filter((change) => changeMatches(change, about, projectName));
        return { since: new Date(from).toISOString(), changes: matching.slice(0, limit).map(changeRow), truncated: matching.length > limit };
      },
    ),
  };
}
