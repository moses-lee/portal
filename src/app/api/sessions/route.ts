import { NextResponse } from "next/server";
import { createSession, listSessions } from "@/lib/acp";
import { defaultAgentId, getAgent } from "@/lib/agents";
import { errorStatus, resolveDirectory } from "@/lib/fs-paths";
import { displayPath } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import { summarizeSession } from "@/lib/session-summary";

export const dynamic = "force-dynamic";

export async function GET() {
  await projects.ready;
  return NextResponse.json({
    sessions: await Promise.all(
      listSessions().map((meta) => summarizeSession(meta, projects.get(meta.projectId) ?? null)),
    ),
  });
}

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }
  const { projectId, agentId: requestedAgentId } = body as Record<string, unknown>;
  if (typeof projectId !== "string" || !projectId) {
    return NextResponse.json({ error: "Choose a project to start the session in." }, { status: 400 });
  }
  const agentId = requestedAgentId === undefined ? defaultAgentId : requestedAgentId;
  if (typeof agentId !== "string" || !getAgent(agentId)) {
    return NextResponse.json({ error: "Unknown agent. Choose an agent from the dropdown." }, { status: 400 });
  }
  await projects.ready;
  const project = projects.get(projectId);
  if (!project) return NextResponse.json({ error: "Unknown project." }, { status: 404 });
  let cwd: string;
  try {
    // The project stores a realpath, but the folder may have been deleted or renamed since.
    cwd = await resolveDirectory(project.path);
  } catch (err) {
    if (errorStatus(err) === 404) {
      return NextResponse.json({ error: `Project folder is missing: ${displayPath(project.path)}` }, { status: 409 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
  }
  try {
    const session = await createSession(cwd, agentId, project.id);
    return NextResponse.json(await summarizeSession(session, project));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
