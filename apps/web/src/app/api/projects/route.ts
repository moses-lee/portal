import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { projects } from "@/lib/projects";
import { ProjectError, summarizeProject } from "@/lib/projects-store";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  return NextResponse.json({ projects: await Promise.all(projects.list().map(summarizeProject)) });
}

export async function POST(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }
  const { path, name } = body as Record<string, unknown>;
  if (typeof path !== "string" || !path.trim()) {
    return NextResponse.json({ error: "Path is required." }, { status: 400 });
  }
  if (name !== undefined && typeof name !== "string") {
    return NextResponse.json({ error: "Name must be a string." }, { status: 400 });
  }
  try {
    return NextResponse.json(await projects.add({ path: path.trim(), name }), { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const project = err instanceof Error ? (err as Partial<ProjectError>).project : undefined;
    return NextResponse.json(project ? { error: message, project } : { error: message }, { status: errorStatus(err) ?? 500 });
  }
}
