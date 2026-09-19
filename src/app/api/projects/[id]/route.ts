import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { listSessions, ready } from "@/lib/acp";
import { errorStatus } from "@/lib/fs-paths";
import { readGitInfo } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import { checkSameOrigin } from "@/lib/shell-http";
import { mainWorktreeOf, removeWorktree } from "@/lib/worktrees";
import type { Project } from "@/lib/types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  const dirty = err instanceof Error && (err as { dirty?: unknown }).dirty === true;
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json(dirty ? { error: message, dirty: true } : { error: message }, { status: errorStatus(err) ?? 500 });
}

export async function PATCH(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const name = body && typeof body === "object" ? (body as Record<string, unknown>).name : undefined;
  if (typeof name !== "string") {
    return NextResponse.json({ error: "Expected {name}." }, { status: 400 });
  }
  try {
    return NextResponse.json(await projects.rename(id, name));
  } catch (err) {
    return fail(err);
  }
}

/**
 * Remove the worktree folder behind a worktree project. The git commands run in the main checkout,
 * found through the parent project or, when that is gone, through the worktree's own `.git` file.
 * A folder that has already disappeared only needs its registration pruned.
 */
async function deleteWorktreeFolder(project: Project & { worktree: NonNullable<Project["worktree"]> }, force: boolean) {
  const exists = await stat(project.path).then(() => true, () => false);
  // The project may sit in a subfolder of the worktree; git needs the worktree's root.
  const worktreeRoot = exists ? (await readGitInfo(project.path))?.root ?? null : null;
  const parent = projects.get(project.worktree.parentId);
  let repoRoot: string | null = null;
  if (parent && await stat(parent.path).then(() => true, () => false)) {
    repoRoot = (await readGitInfo(parent.path))?.root ?? null;
  }
  if (!repoRoot && worktreeRoot) repoRoot = await mainWorktreeOf(worktreeRoot);
  // Without a folder and without a repository there is nothing left for git to clean up.
  if (!repoRoot) return;
  await removeWorktree({ repoRoot, path: worktreeRoot ?? project.path, branch: project.worktree.branch, force });
}

export async function DELETE(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const query = new URL(req.url).searchParams;
  const deleteWorktree = query.get("worktree") === "delete";
  const force = query.get("force") === "1";
  const project = projects.get(id);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  try {
    if (deleteWorktree) {
      if (!project.worktree) return NextResponse.json({ error: "This project is not a worktree." }, { status: 400 });
      await deleteWorktreeFolder({ ...project, worktree: project.worktree }, force);
    }
    // Sessions created from this project keep running. While any exist, the project is kept as a
    // removed record so the Removed view can bring it (and them) back; otherwise it is forgotten.
    await ready;
    const keep = listSessions().some((session) => session.projectId === id);
    await projects.remove(id, { keep });
    return new Response(null, { status: 204 });
  } catch (err) {
    return fail(err);
  }
}
