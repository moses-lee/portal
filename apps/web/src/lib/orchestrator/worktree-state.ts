/**
 * What the orchestrator's tick records about a worktree project: whether its branch has landed on
 * the default branch and whether the tree has uncommitted changes. Local reads only; never fetches.
 */
import { stat } from "node:fs/promises";
import { gitMaybe } from "../worktrees.ts";

export type WorktreeState = {
  /** False when the worktree folder is gone; `merged` and `dirty` are then both false. */
  exists: boolean;
  /** `branch` is an ancestor of `origin/<defaultBranch>` as last fetched. */
  merged: boolean;
  /** `git status --porcelain` in the worktree printed something. */
  dirty: boolean;
};

async function isMerged(repoRoot: string, branch: string, defaultBranch: string | null): Promise<boolean> {
  if (!branch || !defaultBranch || branch === defaultBranch) return false;
  // Exit status carries the answer; a missing ref on either side fails and reads as not merged.
  return await gitMaybe(repoRoot, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${defaultBranch}`]) !== null;
}

/** Merged/dirty state of the worktree at `path` for `branch`, judged from `repoRoot` without fetching. */
export async function readWorktreeState({ repoRoot, path: dir, branch, defaultBranch }: {
  repoRoot: string; path: string; branch: string; defaultBranch: string | null;
}): Promise<WorktreeState> {
  const exists = await stat(dir).then((info) => info.isDirectory(), () => false);
  if (!exists) return { exists: false, merged: false, dirty: false };
  const [merged, status] = await Promise.all([
    isMerged(repoRoot, branch, defaultBranch),
    gitMaybe(dir, ["status", "--porcelain"]),
  ]);
  return { exists: true, merged, dirty: !!status && status.trim() !== "" };
}
