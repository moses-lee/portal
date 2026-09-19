/**
 * Portal operations the orchestrator performs on the user's behalf, each mirroring the API route
 * the browser uses for the same thing (create a session, find or create a worktree project,
 * remove a project, restore one). Shared by the tools and by `performAction`, so an item button
 * and a chat request do exactly the same work. Errors carry an HTTP `status` like the routes'.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { errorStatus } from "../fs-paths.ts";
import { displayPath } from "../git-info.ts";
import { githubRepoUrl } from "../github-summary.ts";
import { parentOf } from "../removed-projects.ts";
import type { Project, RemovedProject, WorktreeMeta } from "../types.ts";
import type { OrchestratorDeps } from "./deps.ts";

export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const exists = (dir: string) => stat(dir).then((info) => info.isDirectory(), () => false);

export async function requireProject(deps: OrchestratorDeps, id: string): Promise<Project> {
  const project = await deps.projects.get(id);
  if (!project) throw httpError("Unknown project.", 404);
  return project;
}

/** The project's folder as it is now; the stored realpath may have been deleted or renamed since. */
export async function projectCwd(deps: OrchestratorDeps, project: Project): Promise<string> {
  try {
    return await deps.fs.resolveDirectory(project.path);
  } catch (err) {
    if (errorStatus(err) === 404) throw httpError(`Project folder is missing: ${displayPath(project.path)}`, 409);
    throw err;
  }
}

/**
 * Create a session in a project and, with `prompt`, start its first turn (POST /api/sessions + prompt).
 * The session exists once created: a prompt that fails is reported as `promptError` rather than
 * thrown, so a retry sends the prompt again instead of creating a second session.
 */
export async function startSession(deps: OrchestratorDeps, { projectId, agentId, prompt }: { projectId: string; agentId?: string; prompt?: string }): Promise<{ sessionId: string; promptError?: string }> {
  const project = await requireProject(deps, projectId);
  const agent = agentId ?? await deps.agents.defaultId();
  if (!(await deps.agents.list()).some((known) => known.id === agent)) throw httpError(`Unknown agent "${agent}".`, 400);
  const cwd = await projectCwd(deps, project);
  const session = await deps.sessions.create(cwd, agent, project.id);
  if (!prompt?.trim()) return { sessionId: session.id };
  try {
    await deps.sessions.prompt(session.id, prompt);
    return { sessionId: session.id };
  } catch (err) {
    return { sessionId: session.id, promptError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Find or create the worktree of `from`'s repository for `branch` and the project living in it
 * (POST /api/projects/[id]/worktrees). Works from the main checkout or any worktree of the repo.
 */
export async function worktreeProject(deps: OrchestratorDeps, { from, branch, create = false }: { from: Project; branch: string; create?: boolean }): Promise<{ project: Project; created: boolean }> {
  const name = branch.trim();
  if (!name) throw httpError("Branch is required.", 400);
  // Worktrees of a worktree belong to the original project while it is still listed.
  const parentId = from.worktree && await deps.projects.get(from.worktree.parentId) ? from.worktree.parentId : from.id;
  const root = await deps.git.repoRootOf(from.path);
  const worktree = await deps.git.ensureWorktree({ repoRoot: await deps.git.mainWorktreeOf(root), branch: name, create });
  // A project rooted in a subfolder of the repo gets the same subfolder inside the worktree.
  const projectPath = path.join(worktree.path, path.relative(root, from.path));
  const existing = await deps.projects.findByPath(projectPath);
  if (existing) return { project: existing, created: false };
  try {
    return { project: await deps.projects.add({ path: projectPath, name, worktree: { parentId, branch: name } }), created: true };
  } catch (err) {
    // Lost a race with a concurrent request for the same branch: that project is the answer.
    const raced = err instanceof Error ? (err as { project?: Project }).project : undefined;
    if (raced) return { project: raced, created: false };
    if (errorStatus(err) === 404) throw httpError(`The worktree has no ${displayPath(projectPath)} folder.`, 409);
    throw err;
  }
}

/** Remove the worktree folder behind a worktree project; see DELETE /api/projects/[id]?worktree=delete. */
async function deleteWorktreeFolder(deps: OrchestratorDeps, project: Project & { worktree: WorktreeMeta }, force: boolean) {
  const present = await exists(project.path);
  // The project may sit in a subfolder of the worktree; git needs the worktree's root.
  const worktreeRoot = present ? (await deps.git.info(project.path))?.root ?? null : null;
  const parent = await deps.projects.get(project.worktree.parentId);
  let repoRoot: string | null = null;
  if (parent && await exists(parent.path)) repoRoot = (await deps.git.info(parent.path))?.root ?? null;
  if (!repoRoot && worktreeRoot) repoRoot = await deps.git.mainWorktreeOf(worktreeRoot);
  // Without a folder and without a repository there is nothing left for git to clean up.
  if (!repoRoot) return;
  await deps.git.removeWorktree({ repoRoot, path: worktreeRoot ?? project.path, branch: project.worktree.branch, force });
}

/**
 * Take a project out of Portal (DELETE /api/projects/[id]). Sessions created from it keep running;
 * while any exist the project is kept as a removed record so it can be restored.
 */
export async function removeProject(deps: OrchestratorDeps, { id, deleteWorktree = false, force = false }: { id: string; deleteWorktree?: boolean; force?: boolean }): Promise<{ kept: boolean }> {
  const project = await requireProject(deps, id);
  if (deleteWorktree) {
    if (!project.worktree) throw httpError("This project is not a worktree.", 400);
    await deleteWorktreeFolder(deps, { ...project, worktree: project.worktree }, force);
  }
  const keep = (await deps.sessions.list()).some((session) => session.projectId === id);
  await deps.projects.remove(id, { keep });
  return { kept: keep };
}

/** Bring a removed project back, recreating its worktree first when the folder is gone (POST /api/projects/removed/[id]/restore). */
export async function restoreProject(deps: OrchestratorDeps, id: string): Promise<Project> {
  const record = await deps.projects.getRemoved(id);
  if (!record) throw httpError("Unknown removed project.", 404);
  const listed = new Map((await deps.projects.list()).map((project) => [project.id, project]));
  const removed = new Map((await deps.projects.listRemoved()).map((project) => [project.id, project]));
  const lookup = {
    project: (projectId: string) => listed.get(projectId),
    projectByPath: (realpath: string) => [...listed.values()].find((project) => project.path === realpath),
    removed: (projectId: string) => removed.get(projectId),
  };
  const present = await exists(record.path);
  let worktree = record.worktree;
  if (worktree) {
    const parent = parentOf({ ...record, worktree }, lookup);
    if (!present && !parent) {
      const parentRecord = removed.get(worktree.parentId);
      throw httpError(parentRecord ? `Restore ${parentRecord.name} first.` : "Its original project was removed from Portal.", 409);
    }
    // A parent that was re-added since has a new id; the restored project should point at it.
    if (parent && parent.id !== worktree.parentId) worktree = { parentId: parent.id, branch: worktree.branch };
    if (!present) await recreateWorktree(deps, { ...record, worktree }, parent!);
  } else if (!present) {
    throw httpError(`Project folder is missing: ${displayPath(record.path)}`, 409);
  }
  return deps.projects.restore(id, worktree && worktree !== record.worktree ? { worktree } : {});
}

async function recreateWorktree(deps: OrchestratorDeps, record: RemovedProject & { worktree: WorktreeMeta }, parent: Project) {
  const repoRoot = await deps.git.mainWorktreeOf(await deps.git.repoRootOf(parent.path));
  const worktree = await deps.git.ensureWorktree({ repoRoot, branch: record.worktree.branch });
  if (await exists(record.path)) return;
  if (worktree.created) await deps.git.removeWorktree({ repoRoot, path: worktree.path, branch: "", force: true }).catch(() => {});
  throw httpError(
    `Branch ${record.worktree.branch} ${worktree.created ? "would be checked out" : "is checked out"} at ${displayPath(worktree.path)}, not at ${displayPath(record.path)} where its conversations ran.`,
    409,
  );
}

/** "owner/name" and the GitHub URL of the project's origin, or null when origin is not on GitHub. */
export async function repoOf(deps: OrchestratorDeps, project: Project): Promise<{ repo: string; url: string } | null> {
  const origin = await deps.git.originUrl(project.path).catch(() => null);
  const url = origin ? githubRepoUrl(origin) : null;
  return url ? { repo: url.slice("https://github.com/".length), url } : null;
}

/** The listed project whose origin is `owner/name`, preferring a main checkout over a worktree. */
export async function findProjectForRepo(deps: OrchestratorDeps, repo: string): Promise<Project | null> {
  const wanted = `https://github.com/${repo}`.toLowerCase();
  const projects = [...await deps.projects.list()].sort((a, b) => Number(!!a.worktree) - Number(!!b.worktree));
  for (const project of projects) {
    const found = await repoOf(deps, project);
    if (found?.url.toLowerCase() === wanted) return project;
  }
  return null;
}
