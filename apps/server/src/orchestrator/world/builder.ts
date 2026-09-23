/**
 * The world builder: one `WorldState` from everything Portal can see (projects and the repos behind
 * them, worktrees, sessions, terminals, the attention pulls, and the orchestrator's own intents,
 * jobs, and open items). A "full" build also asks GitHub and reads worktree state, and carries the
 * digest's `TickSnapshot` (collected by `collectSnapshot`, so one build serves the tick too); a
 * "local" build refreshes only what the machine answers at once and reuses the rest of the
 * previous build, so a chat turn never waits on the network. A source that fails keeps its
 * previous slice and adds a line to `errors`. Never throws.
 */
import type { WorldProject, WorldRepo, WorldSession, WorldState, WorldTerminal } from "@portal/contracts/world";
import { githubRepoUrl } from "../../lib/github-summary.ts";
import type { Project, ProjectSummary, SessionMeta } from "../../lib/types.ts";
import type { OrchestratorDeps } from "../deps.ts";
import { collectSnapshot, snapshotActivity } from "../digest.ts";
import { type LocalProject, attachLocalProjects, pullKey } from "../github-attention.ts";
import type { OrchestratorHub } from "../hub.ts";
import type { PullAttention, TickSnapshot } from "../types.ts";

/** How long a repository's default branch is trusted before it is read again. */
export const DEFAULT_BRANCH_TTL_MS = 6 * 60 * 60 * 1000;

export type BuildMode = "full" | "local";

/** What survives between builds: facts about checkouts that all but never change. */
export type WorldCache = {
  /** GitHub origin URL per project path (only found ones: a folder may gain an origin later). */
  origins: Map<string, string>;
  /** Repository root per checkout path. */
  repoRoots: Map<string, string>;
  /** Default branch per repository root, with when it was read. */
  defaultBranches: Map<string, { value: string | null; at: number }>;
};

export function createWorldCache(): WorldCache {
  return { origins: new Map(), repoRoots: new Map(), defaultBranches: new Map() };
}

export type WorldBuildInput = {
  hub: Pick<OrchestratorHub, "deps" | "store" | "jobs" | "timers">;
  /** The previous build; failing sources keep their slice from here. */
  previous: WorldState | null;
  mode: BuildMode;
  cache?: WorldCache;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const emptySnapshot = (at: number): TickSnapshot => ({ at, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [] });

/** "owner/name" from an origin URL, or null when it is not a GitHub remote. */
export function repoFromOrigin(origin: string | null): string | null {
  const url = origin ? githubRepoUrl(origin) : null;
  return url ? url.slice("https://github.com/".length) : null;
}

/** Whether `dir` is `root` or inside it. */
export function isInside(dir: string, root: string): boolean {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return dir === base || dir.startsWith(`${base}/`);
}

/** The project whose folder holds `cwd` most closely (a worktree inside a checkout wins over the checkout). */
export function projectForPath(projects: Pick<WorldProject, "id" | "path">[], cwd: string): string | null {
  let best: { id: string; length: number } | null = null;
  for (const project of projects) {
    if (isInside(cwd, project.path) && (!best || project.path.length > best.length)) best = { id: project.id, length: project.path.length };
  }
  return best?.id ?? null;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => (promise ??= fn());
}

function worldSession(meta: SessionMeta): WorldSession {
  return {
    id: meta.id, title: meta.title, projectId: meta.projectId, agentId: meta.agentId, agentName: meta.agentName,
    activity: snapshotActivity(meta), link: meta.link.status, createdAt: meta.createdAt, lastActiveAt: meta.lastActiveAt,
  };
}

const byRecent = (a: WorldSession, b: WorldSession) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id);
const byUpdated = (a: PullAttention, b: PullAttention) => b.updatedAt - a.updatedAt || pullKey(a).localeCompare(pullKey(b));

/** Repositories with every project checked out from them: the main checkout first, then worktrees in project order. */
export function groupRepos(projects: WorldProject[]): WorldRepo[] {
  const groups = new Map<string, WorldProject[]>();
  for (const project of projects) {
    if (!project.repo) continue;
    const key = project.repo.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  return [...groups.values()]
    .map((members) => {
      const ordered = [...members.filter((p) => !p.worktree), ...members.filter((p) => p.worktree)];
      const main = ordered.find((p) => !p.worktree) ?? ordered[0];
      return { repo: main.repo!, defaultBranch: ordered.find((p) => p.defaultBranch)?.defaultBranch ?? null, projectIds: ordered.map((p) => p.id) };
    })
    .sort((a, b) => a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()));
}

/** Pulls with `localProjectId`/`worktreeProjectId` matched against the world's projects. */
export function attachPulls(pulls: PullAttention[], projects: WorldProject[]): PullAttention[] {
  const locals: LocalProject[] = projects.filter((p) => p.repo).map((p) => ({
    id: p.id, path: p.path, remoteUrl: `https://github.com/${p.repo}`,
    ...(p.worktree ? { worktree: { parentId: p.worktree.parentId, branch: p.worktree.branch } } : {}),
  }));
  return attachLocalProjects(pulls, locals).sort(byUpdated);
}

/** Build the world. Never throws: a failing source keeps its slice from `previous` and adds to `errors`. */
export async function buildWorld({ hub, previous, mode, cache = createWorldCache() }: WorldBuildInput): Promise<WorldState> {
  const { deps } = hub;
  const now = hub.timers.now();
  const errors: string[] = [];
  const full = mode === "full";
  const kept = (what: string, err: unknown) => errors.push(`${what} could not be read (${errorMessage(err)}); kept the previous ones.`);

  // One read per source per build, shared by the snapshot and the world.
  const listSessions = once(() => deps.sessions.list());
  const listProjects = once(() => deps.projects.list());
  const summaries = new Map<string, Promise<ProjectSummary>>();
  const summarize = (project: Project) => {
    let found = summaries.get(project.id);
    if (!found) summaries.set(project.id, found = deps.projects.summarize(project));
    return found;
  };
  const originUrl = async (dir: string) => {
    const known = cache.origins.get(dir);
    if (known) return known;
    const url = await deps.git.originUrl(dir).catch(() => null);
    if (url) cache.origins.set(dir, url);
    return url;
  };
  const repoRootOf = async (dir: string) => {
    const known = cache.repoRoots.get(dir);
    if (known) return known;
    const root = await deps.git.repoRootOf(dir);
    cache.repoRoots.set(dir, root);
    return root;
  };
  const defaultBranchOf = async (repoRoot: string) => {
    const known = cache.defaultBranches.get(repoRoot);
    if (known && now - known.at < DEFAULT_BRANCH_TTL_MS) return known.value;
    const { defaultBranch } = await deps.git.listBranches(repoRoot);
    cache.defaultBranches.set(repoRoot, { value: defaultBranch, at: now });
    return defaultBranch;
  };
  const shared: OrchestratorDeps = {
    ...deps,
    sessions: { ...deps.sessions, list: listSessions },
    projects: { ...deps.projects, list: listProjects, summarize },
    git: { ...deps.git, originUrl, repoRootOf, listBranches: async (root) => ({ defaultBranch: await defaultBranchOf(root), branches: [] }) },
  };

  // The digest's slice. A local build keeps the previous one: it is only ever diffed after a full build.
  let snapshot = previous?.snapshot ?? emptySnapshot(now);
  if (full) {
    try {
      // The tick's stored snapshot is the reference: a PR that left the attention list since then is
      // carried once more with its final state, whatever builds ran in between.
      const stored = await hub.store.readSnapshot().catch(() => null);
      snapshot = await collectSnapshot({ deps: shared, previous: stored ?? previous?.snapshot ?? null, now, log: errors });
    } catch (err) {
      errors.push(`The snapshot could not be collected (${errorMessage(err)}); kept the previous one.`);
    }
  }

  // Sessions. In a full build `collectSnapshot` already reported a failure of the same read.
  let sessions = previous?.sessions ?? [];
  try {
    sessions = (await listSessions()).map(worldSession).sort(byRecent);
  } catch (err) {
    if (!full) kept("Sessions", err);
  }

  // Projects, with their repos and checkout state.
  let projects = previous?.projects ?? [];
  let projectsRead = false;
  try {
    const list = await listProjects();
    const before = new Map((previous?.projects ?? []).map((p) => [p.id, p]));
    projects = await Promise.all(list.map(async (project): Promise<WorldProject> => {
      const prior = before.get(project.id);
      let summary: ProjectSummary | null = null;
      try {
        summary = await summarize(project);
      } catch (err) {
        if (!full) errors.push(`Project ${project.name} could not be checked (${errorMessage(err)}).`);
      }
      const missing = summary ? !summary.exists : (prior?.missing ?? snapshot.missingProjects.includes(project.id));
      // A missing folder has no origin to read; the repo it had still names it.
      const repo = missing ? (prior?.repo ?? null) : repoFromOrigin(await originUrl(project.path));
      const state = snapshot.worktrees[project.id];
      return {
        id: project.id, name: project.name, path: project.path, repo, defaultBranch: null,
        worktree: project.worktree ? {
          parentId: project.worktree.parentId, branch: project.worktree.branch,
          dirty: state?.dirty ?? prior?.worktree?.dirty ?? null, merged: state?.merged ?? prior?.worktree?.merged ?? null,
        } : null,
        missing,
        branch: missing ? null : (summary?.git?.branch ?? prior?.branch ?? null),
      };
    }));
    projectsRead = true;
  } catch (err) {
    if (!full) kept("Projects", err);
  }

  // Default branches, once per repository, from any checkout of it that still exists.
  if (projectsRead) {
    const priorRepos = new Map((previous?.repos ?? []).map((r) => [r.repo.toLowerCase(), r.defaultBranch]));
    const repoBranches = new Map<string, string | null>();
    await Promise.all(groupRepos(projects).map(async (repo) => {
      const checkout = repo.projectIds.map((id) => projects.find((p) => p.id === id)!).find((p) => !p.missing);
      let branch = priorRepos.get(repo.repo.toLowerCase()) ?? null;
      if (checkout) {
        try {
          branch = await defaultBranchOf(await repoRootOf(checkout.path));
        } catch (err) {
          errors.push(`The default branch of ${repo.repo} could not be read (${errorMessage(err)}).`);
        }
      }
      repoBranches.set(repo.repo.toLowerCase(), branch);
    }));
    projects = projects.map((p) => (p.repo ? { ...p, defaultBranch: repoBranches.get(p.repo.toLowerCase()) ?? null } : p));
  }
  const repos = groupRepos(projects);

  // Terminals, placed in the project whose folder holds the shell (or the owning session's project).
  let terminals: WorldTerminal[] = previous?.terminals ?? [];
  try {
    const sessionProject = new Map(sessions.map((s) => [s.id, s.projectId || null]));
    terminals = (await deps.terminals.list()).map((terminal) => ({
      id: terminal.id, cwd: terminal.cwd, title: terminal.title,
      projectId: projectForPath(projects, terminal.cwd) ?? (terminal.sessionId ? sessionProject.get(terminal.sessionId) ?? null : null),
    }));
  } catch (err) {
    kept("Terminals", err);
  }

  // Pulls: the snapshot's (a failed search already kept the previous ones there), else the previous build's.
  const basePulls = full ? Object.values(snapshot.pulls) : (previous?.pulls ?? []);
  const pulls = projects.length > 0 ? attachPulls(basePulls, projects) : [...basePulls].sort(byUpdated);

  let intents = previous?.intents ?? [];
  try {
    intents = (await hub.jobs.listIntents({ status: ["active"] }))
      .map((intent) => ({ id: intent.id, text: intent.text, status: intent.status, lastCheckedAt: intent.lastCheckedAt }));
  } catch (err) {
    kept("Intents", err);
  }

  let jobs = previous?.jobs ?? [];
  try {
    jobs = (await hub.jobs.listJobs({ status: ["active"] }))
      .filter((job) => job.status === "active")
      .map((job) => ({ id: job.id, kind: job.kind, title: job.title, nextRunAt: job.nextRunAt }))
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.id.localeCompare(b.id));
  } catch (err) {
    kept("Jobs", err);
  }

  let items = previous?.items ?? [];
  try {
    items = (await hub.store.listItems())
      .filter((item) => item.status === "open" || item.status === "snoozed")
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map((item) => ({ id: item.id, kind: item.kind, title: item.title, status: item.status }));
  } catch (err) {
    kept("Items", err);
  }

  let login = previous?.login ?? null;
  if (full) {
    try {
      login = await deps.github.login();
    } catch (err) {
      errors.push(`The GitHub login could not be read (${errorMessage(err)}).`);
    }
  }

  return { at: now, login, projects, repos, sessions, terminals, pulls, intents, jobs, items, errors, snapshot };
}
