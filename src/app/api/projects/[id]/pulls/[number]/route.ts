import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { projects } from "@/lib/projects";
import { checkSameOrigin } from "@/lib/shell-http";
import { getPull, repoRootOf } from "@/lib/worktrees";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; number: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

export async function GET(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id, number: raw } = await params;
  const number = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    return NextResponse.json({ error: "PR number must be a positive integer." }, { status: 400 });
  }
  const project = projects.get(id);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  try {
    return NextResponse.json({ pull: await getPull(await repoRootOf(project.path), number) });
  } catch (err) {
    return fail(err);
  }
}
