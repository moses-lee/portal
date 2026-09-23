import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { listSessions, ready } from "@/lib/acp";
import { displayPath, readGitInfo } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import { parentOf, summarizeOrphans, summarizeRemoved, type ProjectLookup, type RemovedFacts } from "@/lib/removed-projects";
import { checkSameOrigin } from "@/lib/shell-http";
import { hasBranch } from "@/lib/worktrees";
import type { RemovedProject, RemovedProjectSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

const isDirectory = (dir: string) => stat(dir).then((info) => info.isDirectory(), () => false);

const lookup: ProjectLookup & { displayPath: typeof displayPath } = {
  project: projects.get, projectByPath: projects.findByPath, removed: projects.getRemoved, displayPath,
};

/** What restoring `record` would need: its folder, or (for a worktree) the parent's repository and the branch. */
async function gatherFacts(record: RemovedProject): Promise<RemovedFacts> {
  const exists = await isDirectory(record.path);
  if (exists || !record.worktree) return { exists, branchExists: null, parentExists: null };
  const parent = parentOf(record, lookup);
  if (!parent) return { exists, branchExists: null, parentExists: null };
  const parentExists = await isDirectory(parent.path);
  if (!parentExists) return { exists, branchExists: null, parentExists };
  const root = (await readGitInfo(parent.path))?.root;
  const branchExists = root ? await hasBranch(root, record.worktree.branch).catch(() => false) : false;
  return { exists, branchExists, parentExists };
}

/** Removed projects (most recent first) followed by conversations whose project left no record. */
export async function GET(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await Promise.all([projects.ready, ready]);
  const sessions = listSessions();
  const removed: RemovedProjectSummary[] = await Promise.all(
    projects.listRemoved().map(async (record) =>
      summarizeRemoved(record, await gatherFacts(record), sessions.filter((s) => s.projectId === record.id), lookup),
    ),
  );
  const orphans = summarizeOrphans(
    sessions,
    (projectId) => !!projects.get(projectId) || !!projects.getRemoved(projectId),
    displayPath,
  );
  return NextResponse.json({ removed: [...removed, ...orphans] });
}
