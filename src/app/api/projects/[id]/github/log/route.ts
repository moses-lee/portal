import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { readCommitPage } from "@/lib/github-summary";
import { projects } from "@/lib/projects";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

/** One page of older commits from `?before=<cursor>`, a cursor handed out by the summary or a previous page. */
export async function GET(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const before = new URL(req.url).searchParams.get("before");
  if (!before) return NextResponse.json({ error: "before must be a log cursor from a previous page." }, { status: 400 });
  const project = projects.get(id);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  try {
    return NextResponse.json(await readCommitPage(project.path, before));
  } catch (err) {
    return fail(err);
  }
}
