/**
 * Global search (`GET /api/search`, docs/SEARCH.md): message text hits from `session_messages`, and
 * the sessions associated with the pull requests a query names (see `pulls.ts`). The client matches
 * session and project names itself from the lists it already holds.
 *
 * The PR catalog is what Portal already has, never a new GitHub call: the newest stored world
 * build's PRs (with head branches), the change log's PR rows (with titles), and the PRs orchestrator
 * items link (refs only). It is read at most every `CATALOG_TTL_MS`; the world itself only changes
 * on the hourly refresh. Sessions and projects are read live.
 */
import { desc, isNotNull, like, sql } from "drizzle-orm";
import type { SearchMessageHit, SearchResponse } from "@portal/contracts/search";
import type { WorldProject, WorldRepo } from "@portal/contracts/world";
import type { PullAttention } from "@portal/contracts/orchestrator";
import type { Db } from "../db/client.ts";
import { orchestratorItems, sessionMessages, worldChanges, worldSnapshots } from "../db/schema.ts";
import type { Project } from "../lib/types.ts";
import { type CatalogPull, type SearchSession, mergeCatalog, searchPulls } from "./pulls.ts";

/** Shorter queries answer nothing: two characters is where substring matches stop being noise. */
export const QUERY_MIN = 2;
/** Longer queries are cut to this many characters. */
export const QUERY_MAX = 200;
export const MESSAGE_HITS_MAX = 8;
export const SNIPPET_CHARS = 160;
export const CATALOG_TTL_MS = 30_000;

export type SearchDeps = {
  db: Db;
  sessions(): SearchSession[] | Promise<SearchSession[]>;
  projects(): Pick<Project, "id" | "worktree">[] | Promise<Pick<Project, "id" | "worktree">[]>;
  now?(): number;
};

export interface SearchService {
  search(q: string): Promise<SearchResponse>;
}

/** `ILIKE` pattern for a literal substring: `%`, `_`, and the escape character itself match only themselves. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * About `SNIPPET_CHARS` of `text` around the first case-insensitive match of `q`, whitespace runs
 * folded to one space, with "…" where it was cut.
 */
export function snippet(text: string, q: string, size = SNIPPET_CHARS): string {
  const at = Math.max(0, text.toLowerCase().indexOf(q.toLowerCase()));
  const start = Math.max(0, Math.min(at - Math.floor((size - q.length) / 2), text.length - size));
  const end = Math.min(text.length, start + size);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** The title in a change-log PR summary: `owner/name#7 "Title" was merged`, `PR owner/name#7 "Title" needs attention: …`. */
export function titleFromSummary(summary: string): string | undefined {
  return /#\d+ "(.*)"/.exec(summary)?.[1] || undefined;
}

const pullUrl = (repo: string, number: number, url: unknown) => (typeof url === "string" && url ? url : `https://github.com/${repo}/pull/${number}`);

type Catalog = {
  pulls: CatalogPull[];
  repos: WorldRepo[];
  projects: Pick<WorldProject, "id" | "repo">[];
  itemLinks: { sessionId: string; repo: string; number: number }[];
};

async function readCatalog(db: Db): Promise<Catalog> {
  const [[world], changes, items] = await Promise.all([
    // Only the slices search reads: a build's body is mostly sessions and the snapshot.
    db.select({
      pulls: sql<PullAttention[] | null>`${worldSnapshots.body}->'world'->'pulls'`,
      repos: sql<WorldRepo[] | null>`${worldSnapshots.body}->'world'->'repos'`,
      projects: sql<WorldProject[] | null>`${worldSnapshots.body}->'world'->'projects'`,
    }).from(worldSnapshots).orderBy(desc(worldSnapshots.id)).limit(1),
    db.select({ summary: worldChanges.summary, refs: worldChanges.refs, at: worldChanges.at })
      .from(worldChanges).where(like(worldChanges.subject, "pr:%")),
    db.select({ links: sql<{ sessionId?: unknown; pull?: { repo?: unknown; number?: unknown; url?: unknown } } | null>`${orchestratorItems.body}->'links'`, at: orchestratorItems.updatedAt })
      .from(orchestratorItems)
      .where(isNotNull(sql`${orchestratorItems.body}->'links'->'pull'`)),
  ]);
  const fromWorld: CatalogPull[] = (world?.pulls ?? []).map((pull) => ({
    repo: pull.repo, number: pull.number, url: pull.url, title: pull.title, headBranch: pull.headBranch, updatedAt: pull.updatedAt,
  }));
  const fromChanges: CatalogPull[] = [];
  for (const row of changes) {
    const pull = (row.refs as { pull?: { repo?: unknown; number?: unknown; url?: unknown } }).pull;
    if (typeof pull?.repo !== "string" || typeof pull.number !== "number") continue;
    fromChanges.push({ repo: pull.repo, number: pull.number, url: pullUrl(pull.repo, pull.number, pull.url), title: titleFromSummary(row.summary), updatedAt: row.at });
  }
  const itemLinks: Catalog["itemLinks"] = [];
  const fromItems: CatalogPull[] = [];
  for (const { links, at } of items) {
    const { sessionId, pull } = links ?? {};
    if (typeof pull?.repo !== "string" || typeof pull.number !== "number") continue;
    fromItems.push({ repo: pull.repo, number: pull.number, url: pullUrl(pull.repo, pull.number, pull.url), updatedAt: at });
    if (typeof sessionId === "string") itemLinks.push({ sessionId, repo: pull.repo, number: pull.number });
  }
  return { pulls: mergeCatalog(fromWorld, fromChanges, fromItems), repos: world?.repos ?? [], projects: world?.projects ?? [], itemLinks };
}

/**
 * Which repo each project belongs to: the world build's repos and projects, plus worktrees made
 * since that build, which belong to their parent's repo.
 */
function repoIndex(catalog: Catalog, projects: Pick<Project, "id" | "worktree">[]): (projectId: string) => string | null {
  const repos = new Map<string, string>();
  for (const project of catalog.projects) if (project.repo) repos.set(project.id, project.repo.toLowerCase());
  for (const repo of catalog.repos) for (const id of repo.projectIds) repos.set(id, repo.repo.toLowerCase());
  for (const project of projects) {
    const parent = project.worktree?.parentId;
    if (!repos.has(project.id) && parent && repos.has(parent)) repos.set(project.id, repos.get(parent)!);
  }
  return (projectId) => repos.get(projectId) ?? null;
}

export function createSearchService(deps: SearchDeps): SearchService {
  const now = deps.now ?? Date.now;
  let catalog: { at: number; value: Promise<Catalog> } | null = null;

  function currentCatalog(): Promise<Catalog> {
    if (!catalog || now() - catalog.at >= CATALOG_TTL_MS) {
      const value = readCatalog(deps.db);
      catalog = { at: now(), value };
      // A failed read is not cached.
      value.catch(() => { if (catalog?.value === value) catalog = null; });
    }
    return catalog.value;
  }

  async function messages(q: string): Promise<SearchMessageHit[]> {
    const rows = await deps.db
      .select({ sessionId: sessionMessages.sessionId, seq: sessionMessages.seq, role: sessionMessages.role, ts: sessionMessages.ts, text: sessionMessages.text })
      .from(sessionMessages)
      .where(sql`${sessionMessages.text} ilike ${likePattern(q)}`)
      .orderBy(desc(sessionMessages.ts), desc(sessionMessages.seq))
      .limit(MESSAGE_HITS_MAX);
    return rows.map(({ text, ...row }) => ({ ...row, snippet: snippet(text, q) }));
  }

  async function pulls(q: string) {
    const [loaded, sessions, projects] = await Promise.all([currentCatalog(), deps.sessions(), deps.projects()]);
    const branches = new Map(projects.map((project) => [project.id, project.worktree?.branch ?? null]));
    return searchPulls(q, {
      pulls: loaded.pulls,
      sessions,
      itemLinks: loaded.itemLinks,
      repoOf: repoIndex(loaded, projects),
      worktreeBranch: (projectId) => branches.get(projectId) ?? null,
    });
  }

  return {
    async search(raw) {
      const q = raw.trim().slice(0, QUERY_MAX).trim();
      if (q.length < QUERY_MIN) return { q, messages: [], pulls: [] };
      const [messageHits, pullHits] = await Promise.all([messages(q), pulls(q)]);
      return { q, messages: messageHits, pulls: pullHits };
    },
  };
}
