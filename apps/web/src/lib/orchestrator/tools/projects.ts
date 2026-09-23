import { z } from "zod";
import { displayPath } from "../../git-info.ts";
import type { Project } from "../../types.ts";
import { findProjectForRepo, httpError, removeProject, repoOf, requireProject, restoreProject, worktreeProject } from "../ops.ts";
import { type ToolContext, capped, define } from "./context.ts";

const id = z.string().min(1);

function row(project: Project) {
  return { id: project.id, name: project.name, path: displayPath(project.path), ...(project.worktree ? { worktree: project.worktree } : {}) };
}

export function projectTools({ deps }: ToolContext) {
  return {
    list_projects: define(
      "Portal's projects (folders sessions run in), oldest first. filter: main (checkouts), worktrees, or all.",
      z.object({ filter: z.enum(["all", "main", "worktrees"]).optional() }),
      async ({ filter = "all" }) => {
        const projects = (await deps.projects.list()).filter((project) => filter === "all" || (filter === "worktrees") === !!project.worktree);
        const { rows, truncated } = capped(projects);
        const summaries = await Promise.all(rows.map((project) => deps.projects.summarize(project)));
        return {
          projects: rows.map((project, i) => ({ ...row(project), branch: summaries[i].git?.branch ?? null, exists: summaries[i].exists })),
          truncated,
          total: projects.length,
        };
      },
    ),
    get_project: define(
      "One project: folder state, current branch, GitHub repo, and how many sessions it has.",
      z.object({ id }),
      async ({ id }) => {
        const project = await requireProject(deps, id);
        const summary = await deps.projects.summarize(project);
        const sessions = (await deps.sessions.list()).filter((session) => session.projectId === id).length;
        const repo = summary.exists ? await repoOf(deps, project) : null;
        return {
          ...row(project), fullPath: project.path, exists: summary.exists,
          branch: summary.git?.branch ?? null, detached: summary.git?.detached ?? false, repo: repo?.repo ?? null, sessions,
        };
      },
    ),
    search_projects: define(
      "Projects whose name, path, or worktree branch contains the query (case-insensitive).",
      z.object({ query: z.string().min(1) }),
      async ({ query }) => {
        const needle = query.toLowerCase();
        const hits = (await deps.projects.list()).filter((project) =>
          [project.name, project.path, project.worktree?.branch ?? ""].some((value) => value.toLowerCase().includes(needle)));
        const { rows, truncated } = capped(hits);
        return { projects: rows.map(row), truncated };
      },
    ),
    add_project: define(
      "Add a folder on the machine running Portal as a project (paths may start with ~/). Returns the project.",
      z.object({ path: z.string().min(1), name: z.string().optional() }),
      async ({ path, name }) => row(await deps.projects.add({ path: path.trim(), name })),
    ),
    rename_project: define(
      "Rename a project.",
      z.object({ id, name: z.string().min(1) }),
      async ({ id, name }) => row(await deps.projects.rename(id, name)),
    ),
    remove_project: define(
      "Remove a project from Portal. deleteWorktree also removes a worktree project's folder (force discards uncommitted changes). Its sessions keep running; the project is kept restorable while they exist.",
      z.object({ id, deleteWorktree: z.boolean().optional(), force: z.boolean().optional() }),
      async (input) => ({ id: input.id, removed: true, ...(await removeProject(deps, input)) }),
    ),
    list_removed_projects: define(
      "Projects removed from Portal whose conversations still exist, most recently removed first.",
      z.object({}),
      async () => {
        const { rows, truncated } = capped(await deps.projects.listRemoved());
        return { projects: rows.map((project) => ({ ...row(project), removedAt: project.removedAt })), truncated };
      },
    ),
    restore_project: define(
      "Bring a removed project back under its original id, recreating its worktree when the folder is gone.",
      z.object({ id }),
      async ({ id }) => row(await restoreProject(deps, id)),
    ),
    create_worktree: define(
      "Find or create a git worktree of the project's repository and return the project living in it. Give exactly one of branch (a branch name; create: true starts it as a new branch from the default branch) or pull (a PR number, whose head branch is used). Never pass both.",
      z.object({ projectId: id, branch: z.string().optional(), pull: z.number().int().positive().optional(), create: z.boolean().optional() }),
      async ({ projectId, branch, pull, create }) => {
        const from = await requireProject(deps, projectId);
        let name = branch?.trim();
        // A model that passes both usually means the branch; guessing wrong checks out the wrong code, so refuse.
        if (name && pull !== undefined) throw httpError("Give either branch or pull, not both.", 400);
        if (pull !== undefined) {
          const info = await deps.git.getPull(await deps.git.repoRootOf(from.path), pull);
          if (info.fork) throw httpError(`PR #${pull} comes from a fork; Portal cannot check it out.`, 409);
          name = info.branch;
        }
        if (!name) throw httpError("Give a branch or a pull number.", 400);
        const { project, created } = await worktreeProject(deps, { from, branch: name, create });
        return { ...row(project), created };
      },
    ),
    clone_repo: define(
      "Clone owner/name from GitHub into Portal's repos folder (or reuse a project that already has it) and add it as a project.",
      z.object({ repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected owner/name.") }),
      async ({ repo }) => {
        const known = await findProjectForRepo(deps, repo);
        if (known) return { ...row(known), cloned: false };
        const dir = await deps.github.cloneRepo(repo);
        const existing = await deps.projects.findByPath(dir);
        return { ...row(existing ?? await deps.projects.add({ path: dir })), cloned: true };
      },
    ),
    list_directories: define(
      "Subdirectories of a folder on the machine running Portal (to find a folder to add). Paths may start with ~/.",
      z.object({ path: z.string().min(1) }),
      async ({ path }) => {
        const listing = await deps.fs.listDirectories(await deps.fs.resolveDirectory(path));
        const { rows, truncated } = capped(listing.entries, 50);
        return {
          path: displayPath(listing.path), parent: listing.parent ? displayPath(listing.parent) : null,
          entries: rows.map(({ name, isGitRepo }) => ({ name, isGitRepo })), truncated,
        };
      },
    ),
  };
}
