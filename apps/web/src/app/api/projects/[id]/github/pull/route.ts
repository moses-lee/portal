import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { pullFastForward } from "@/lib/github-summary";
import { projects } from "@/lib/projects";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

/** `git pull --ff-only` in the project's checkout; git's refusal comes back as a 409 `{error}`. */
export async function POST(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  try {
    return NextResponse.json({ summary: await pullFastForward(project.path) });
  } catch (err) {
    return fail(err);
  }
}
