import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { displayPath } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import { summarizeProject } from "@/lib/projects-store";
import { parentOf } from "@/lib/removed-projects";
import { checkSameOrigin } from "@/lib/shell-http";
import { WorktreeError, ensureWorktree, mainWorktreeOf, removeWorktree, repoRootOf } from "@/lib/worktrees";
import type { Project, RemovedProject } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const lookup = { project: projects.get, projectByPath: projects.findByPath, removed: projects.getRemoved };

/** The listed parent of a removed worktree project, or the 409 that explains its absence. */
function requireParent(record: RemovedProject & { worktree: NonNullable<RemovedProject["worktree"]> }): Project {
  const parent = parentOf(record, lookup);
  if (parent) return parent;
  const parentRecord = projects.getRemoved(record.worktree.parentId);
  throw new WorktreeError(parentRecord ? `Restore ${parentRecord.name} first.` : "Its original project was removed from Portal.", 409);
}

/**
 * Recreate the worktree behind a removed worktree project at the folder its conversations expect.
 * `ensureWorktree` puts a branch back under `worktrees/<repo>/<branch>`, which is where the project
 * was created, so the recorded path reappears unless the branch is checked out elsewhere by now or
 * the repository folder was renamed; a checkout created somewhere else is removed again rather than
 * left behind untracked.
 */
async function recreateWorktree(record: RemovedProject & { worktree: NonNullable<RemovedProject["worktree"]> }, parent: Project) {
  const root = await repoRootOf(parent.path);
  const repoRoot = await mainWorktreeOf(root);
  const worktree = await ensureWorktree({ repoRoot, branch: record.worktree.branch });
  const exists = await stat(record.path).then((info) => info.isDirectory(), () => false);
  if (exists) return;
  if (worktree.created) {
    await removeWorktree({ repoRoot, path: worktree.path, branch: "", force: true }).catch(() => {});
  }
  throw new WorktreeError(
    `Branch ${record.worktree.branch} ${worktree.created ? "would be checked out" : "is checked out"} at ${displayPath(worktree.path)}, not at ${displayPath(record.path)} where its conversations ran.`,
    409,
  );
}

/** Bring a removed project back, recreating its worktree first when the folder is gone. */
export async function POST(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const record = projects.getRemoved(id);
  if (!record) return NextResponse.json({ error: "Unknown removed project." }, { status: 404 });
  try {
    const exists = await stat(record.path).then((info) => info.isDirectory(), () => false);
    let worktree = record.worktree;
    if (worktree) {
      // A parent that was re-added since has a new id; the restored project should point at it.
      const parent = exists ? parentOf({ ...record, worktree }, lookup) : requireParent({ ...record, worktree });
      if (parent && parent.id !== worktree.parentId) worktree = { parentId: parent.id, branch: worktree.branch };
      if (!exists) await recreateWorktree({ ...record, worktree }, parent!);
    } else if (!exists) {
      return NextResponse.json({ error: `Project folder is missing: ${displayPath(record.path)}` }, { status: 409 });
    }
    const project = await projects.restore(id, worktree && worktree !== record.worktree ? { worktree } : {});
    return NextResponse.json({ project: await summarizeProject(project) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
  }
}
