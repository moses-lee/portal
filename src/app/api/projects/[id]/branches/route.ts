import path from "node:path";
import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { projects } from "@/lib/projects";
import { displayPath } from "@/lib/git-info";
import { checkSameOrigin } from "@/lib/shell-http";
import type { BranchListing } from "@/lib/types";
import { listBranches, listPulls, mainWorktreeOf, portalWorktreesDir, repoRootOf } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

export async function GET(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  try {
    const root = await repoRootOf(project.path);
    // Listing never fetches; it reports what the repository already knows plus gh's view of open PRs.
    const [branches, pulls, main] = await Promise.all([listBranches(root), listPulls(root), mainWorktreeOf(root)]);
    // New worktrees are filed under the main checkout's name even when listing from a worktree.
    const repoWorktreesDir = displayPath(path.join(portalWorktreesDir(), path.basename(main)));
    const listing: BranchListing = { ...branches, ...pulls, repoWorktreesDir };
    return NextResponse.json(listing);
  } catch (err) {
    return fail(err);
  }
}
