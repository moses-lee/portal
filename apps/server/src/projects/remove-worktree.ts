/**
 * Taking a project out of Portal, optionally removing the worktree folder behind it. The one
 * implementation behind `DELETE /api/projects/:id`, the orchestrator's project removal and review
 * cleanup (`orchestrator/ops.ts`), and the lifecycle sweep's idle worktree removal
 * (`lib/lifecycle-sweep.ts`). Each caller hands in the I/O it has (the live services, or the
 * orchestrator's deps), so the steps are the same everywhere: the user's pre-deletion script,
 * `git worktree remove` (forced only when asked), the branch only when merged (or, with
 * `deleteBranch: "pushed"`, exactly on origin), then the project entry, kept as a removed record
 * while sessions still point at it.
 */
import { stat } from "node:fs/promises";
import type { ScriptKind } from "@portal/shared/scripts";
import type { AppContext } from "../context.ts";
import { readGitInfo } from "../lib/git-info.ts";
import { type ScriptRunOptions, preWorktreeDeleteRun, runConfiguredScript } from "../lib/script-runner.ts";
import type { Project, WorktreeMeta } from "../lib/types.ts";
import { WorktreeError, mainWorktreeOf, removeWorktree } from "../lib/worktrees.ts";

export type DeleteBranch = "merged" | "pushed";

/** What removing a project needs from the outside world. */
export type ProjectRemovalIo = {
  getProject(id: string): Project | undefined | Promise<Project | undefined>;
  /** The root of the git checkout containing `dir`, or null outside one. */
  gitRoot(dir: string): Promise<string | null>;
  mainWorktreeOf(dir: string): Promise<string>;
  /** Run the user's script for `kind`; throws when it fails and the script says to abort. */
  runScript(kind: ScriptKind, opts: ScriptRunOptions): Promise<unknown>;
  removeWorktree(opts: { repoRoot: string; path: string; branch: string; force?: boolean; deleteBranch?: DeleteBranch }): Promise<{ branchDeleted: boolean }>;
  /** Whether any session still belongs to the project. */
  hasSessions(projectId: string): boolean | Promise<boolean>;
  /** Take the project out of the list, keeping a removed record when `keep`. */
  removeProject(id: string, opts: { keep: boolean }): Promise<void>;
  /**
   * Asked after the pre-deletion script and just before git runs: false cancels the removal with a
   * `RemovalSkipped`. The lifecycle sweep uses it to judge the project on live data once more; the
   * route and the orchestrator leave it out.
   */
  recheck?(): Promise<boolean>;
};

/** Thrown when `recheck` cancelled a removal: something changed, nothing was removed. */
export class RemovalSkipped extends Error {
  constructor() {
    super("The removal was cancelled because the project changed.");
    this.name = "RemovalSkipped";
  }
}

const exists = (dir: string) => stat(dir).then(() => true, () => false);

/** The live services, looked up on every call (tests swap them on the context after boot). */
export function liveProjectRemovalIo(ctx: Pick<AppContext, "projects" | "sessions" | "settings">): ProjectRemovalIo {
  return {
    getProject: (id) => ctx.projects.get(id),
    gitRoot: async (dir) => (await readGitInfo(dir))?.root ?? null,
    mainWorktreeOf,
    runScript: (kind, opts) => runConfiguredScript(kind, opts, ctx.settings),
    removeWorktree,
    async hasSessions(projectId) {
      await ctx.sessions.ready;
      return ctx.sessions.listSessions().some((session) => session.projectId === projectId);
    },
    removeProject: (id, opts) => ctx.projects.remove(id, opts),
  };
}

/**
 * Remove the worktree folder behind a worktree project. The git commands run in the main checkout,
 * found through the parent project or, when that is gone, through the worktree's own `.git` file.
 * `io.recheck`, when given, runs between the pre-deletion script and git. A folder that has already
 * disappeared only needs its registration pruned. Git's refusal (a dirty tree without `force`) is a
 * 409 `WorktreeError` with `dirty: true`.
 */
export async function deleteWorktreeFolder(
  io: ProjectRemovalIo,
  project: Project & { worktree: WorktreeMeta },
  { force = false, deleteBranch }: { force?: boolean; deleteBranch?: DeleteBranch } = {},
): Promise<{ branchDeleted: boolean }> {
  const present = await exists(project.path);
  // The project may sit in a subfolder of the worktree; git needs the worktree's root.
  const worktreeRoot = present ? await io.gitRoot(project.path) : null;
  const parent = await io.getProject(project.worktree.parentId);
  let repoRoot: string | null = null;
  if (parent && await exists(parent.path)) repoRoot = await io.gitRoot(parent.path);
  if (!repoRoot && worktreeRoot) repoRoot = await io.mainWorktreeOf(worktreeRoot);
  const worktreePath = worktreeRoot ?? project.path;
  // The user's pre-deletion script runs first, while the folder is still there; a forced retry runs it again.
  if (repoRoot && present) await io.runScript("preWorktreeDelete", preWorktreeDeleteRun(project, { worktreePath, repoRoot }));
  if (io.recheck && !(await io.recheck())) throw new RemovalSkipped();
  // Without a folder and without a repository there is nothing left for git to clean up.
  if (!repoRoot) return { branchDeleted: false };
  return io.removeWorktree({ repoRoot, path: worktreePath, branch: project.worktree.branch, force, ...(deleteBranch ? { deleteBranch } : {}) });
}

/**
 * Take a project out of Portal, with `deleteWorktree` removing its worktree folder first (a 400 for
 * a project that is not a worktree). Sessions created from it keep running; while any exist the
 * project is kept as a removed record so the Removed view can bring it (and them) back.
 */
export async function removeProject(
  io: ProjectRemovalIo,
  project: Project,
  { deleteWorktree = false, force = false, deleteBranch }: { deleteWorktree?: boolean; force?: boolean; deleteBranch?: DeleteBranch } = {},
): Promise<{ kept: boolean; branchDeleted: boolean }> {
  let branchDeleted = false;
  if (deleteWorktree) {
    if (!project.worktree) throw new WorktreeError("This project is not a worktree.", 400);
    ({ branchDeleted } = await deleteWorktreeFolder(io, { ...project, worktree: project.worktree }, { force, deleteBranch }));
  }
  const kept = await io.hasSessions(project.id);
  await io.removeProject(project.id, { keep: kept });
  return { kept, branchDeleted };
}
