import path from "node:path";
import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { displayPath } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import { ProjectError, summarizeProject } from "@/lib/projects-store";
import { checkSameOrigin } from "@/lib/shell-http";
import { ensureWorktree, mainWorktreeOf, repoRootOf } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

/**
 * Find or create a worktree of the project's repository for `branch` and return the project that
 * lives in it (201 when the project is new, 200 when one already covered that folder). Works from
 * the main checkout and from any worktree project of the same repository; the new project points
 * at the original project either way.
 */
export async function POST(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }
  const { branch, create } = body as Record<string, unknown>;
  if (typeof branch !== "string" || !branch.trim()) {
    return NextResponse.json({ error: "Branch is required." }, { status: 400 });
  }
  if (create !== undefined && typeof create !== "boolean") {
    return NextResponse.json({ error: "create must be a boolean." }, { status: 400 });
  }
  const from = projects.get(id);
  if (!from) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  // Worktrees of a worktree belong to the original project while it is still listed.
  const parentId = from.worktree && projects.get(from.worktree.parentId) ? from.worktree.parentId : from.id;
  try {
    const root = await repoRootOf(from.path);
    // Worktree folders are named after the main checkout, wherever the request started.
    const worktree = await ensureWorktree({ repoRoot: await mainWorktreeOf(root), branch: branch.trim(), create: create === true });
    // A project rooted in a subfolder of the repo gets the same subfolder inside the worktree.
    const projectPath = path.join(worktree.path, path.relative(root, from.path));
    const existing = projects.findByPath(projectPath);
    if (existing) return NextResponse.json({ project: await summarizeProject(existing) });
    let project;
    try {
      project = await projects.add({
        path: projectPath,
        name: branch.trim(),
        worktree: { parentId, branch: branch.trim() },
      });
    } catch (err) {
      // Lost a race with a concurrent request for the same branch: that project is the answer.
      const raced = err instanceof Error ? (err as Partial<ProjectError>).project : undefined;
      if (raced) return NextResponse.json({ project: await summarizeProject(raced) });
      if (errorStatus(err) === 404) {
        return NextResponse.json({ error: `The worktree has no ${displayPath(projectPath)} folder.` }, { status: 409 });
      }
      throw err;
    }
    return NextResponse.json({ project: await summarizeProject(project) }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}
