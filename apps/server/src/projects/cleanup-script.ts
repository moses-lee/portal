/**
 * "Run cleanup script" (docs/MONITORING.md): the user's pre-deletion script (`preWorktreeDelete`)
 * run on a worktree that stays, to free what the worktree's tools keep (build output, servers).
 * It runs where and as it would before a removal, with `PORTAL_SCRIPT_TRIGGER=manual` added so the
 * script can tell the two apart. No new script kind: the script is the one the user already wrote.
 */
import path from "node:path";
import { isScriptEnabled, scriptDefinitions } from "@portal/shared/scripts";
import type { ScriptsSettings } from "@portal/shared/scripts";
import { httpError } from "../http/errors.ts";
import { type ScriptExec, type ScriptOutcome, ScriptError, preWorktreeDeleteRun, runScript } from "../lib/script-runner.ts";
import type { Project } from "../lib/types.ts";
import { type ProjectRemovalIo, locateWorktree, withWorktreeWork } from "./remove-worktree.ts";

/** What the script did, as `runScript` reports it, and how long it took. */
export type CleanupScriptResult = Extract<ScriptOutcome, { ran: true }> & { durationMs: number };

export type CleanupScriptDeps = Pick<ProjectRemovalIo, "getProject" | "gitRoot" | "mainWorktreeOf"> & {
  scripts(): Promise<ScriptsSettings>;
  /** Every session's folder, project, and idle clock (null while it is doing something). */
  sessions(): { projectId: string; cwd: string; idleSince: number | null }[];
  /** The listed projects, to find the others sharing the worktree's folder. */
  projects(): Project[];
  exec?: ScriptExec;
};

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);

/**
 * Run the cleanup script on `project`'s worktree. Throws a status error: 400 for a project that is
 * not a worktree, 409 when no script is set, the folder or its repository cannot be found, a
 * session in the worktree is busy (a turn, a permission prompt, background work), or the worktree
 * is being removed or cleaned already (`withWorktreeWork`). A script that fails or times out is a
 * result, not an error.
 */
export async function runCleanupScript(deps: CleanupScriptDeps, project: Project): Promise<CleanupScriptResult> {
  if (!project.worktree) throw httpError("This project is not a worktree.", 400);
  return withWorktreeWork(project.id, "cleanup", () => cleanWorktree(deps, project));
}

async function cleanWorktree(deps: CleanupScriptDeps, project: Project): Promise<CleanupScriptResult> {
  if (!project.worktree) throw httpError("This project is not a worktree.", 400);
  const settings = (await deps.scripts()).preWorktreeDelete;
  if (!isScriptEnabled(settings)) {
    throw httpError(`No cleanup script is set. Add one under "${scriptDefinitions.preWorktreeDelete.label}" in Settings.`, 409);
  }
  const worktreeProject = { ...project, worktree: project.worktree };
  const { present, worktreePath, repoRoot } = await locateWorktree(deps, worktreeProject);
  if (!present) throw httpError("The worktree's folder is missing.", 409);
  if (!repoRoot) throw httpError("Could not find the repository this worktree belongs to.", 409);
  // Every project in the folder counts: a subfolder project's session works in the same tree.
  const inTree = new Set(deps.projects().filter((other) => within(other.path, worktreePath)).map((other) => other.id));
  inTree.add(project.id);
  const busy = deps.sessions().some((session) => session.idleSince === null && (inTree.has(session.projectId) || within(session.cwd, worktreePath)));
  if (busy) throw httpError("A session in this worktree is busy. Wait for it to finish, then run the script.", 409);

  const run = preWorktreeDeleteRun(worktreeProject, { worktreePath, repoRoot });
  const startedAt = Date.now();
  let outcome: Extract<ScriptOutcome, { ran: true }>;
  try {
    // Abort on failure, whatever the setting: nothing follows here, and a failure is answered, not logged as carried past.
    const ran = await runScript("preWorktreeDelete", { ...settings, abortOnFailure: true }, { ...run, env: { ...run.env, PORTAL_SCRIPT_TRIGGER: "manual" } }, deps.exec);
    if (!ran.ran) throw httpError("No cleanup script is set.", 409);
    outcome = ran;
  } catch (err) {
    if (!(err instanceof ScriptError)) throw err;
    outcome = err.outcome;
  }
  return { ...outcome, durationMs: Date.now() - startedAt };
}
