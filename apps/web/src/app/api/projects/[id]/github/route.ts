import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/compress";
import { errorStatus } from "@/lib/fs-paths";
import { readGithubSummary } from "@/lib/github-summary";
import { projects } from "@/lib/projects";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

/** The GitHub panel's snapshot for a project; `?fetch=1` runs `git fetch origin --prune` first. */
export async function GET(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const project = projects.get(id);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  const fetch = new URL(req.url).searchParams.get("fetch") === "1";
  try {
    return jsonResponse(req, { summary: await readGithubSummary(project.path, { fetch }) });
  } catch (err) {
    return fail(err);
  }
}
