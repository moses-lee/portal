import { NextResponse } from "next/server";
import { deleteSession, listSessions, ready } from "@/lib/acp";
import { projects } from "@/lib/projects";
import { projectIdOfRow } from "@/lib/removed-projects";
import { checkSameOrigin } from "@/lib/shell-http";
import { terminals } from "@/lib/terminals";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Delete every conversation still pointing at a removed project, then forget the project. */
export async function DELETE(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await Promise.all([projects.ready, ready]);
  const { id } = await params;
  if (projects.get(id)) return NextResponse.json({ error: "This project is still listed." }, { status: 409 });
  const projectId = projectIdOfRow(id);
  try {
    for (const session of listSessions().filter((s) => s.projectId === projectId)) {
      if (await deleteSession(session.id)) terminals.closeSession(session.id);
    }
    await projects.forgetRemoved(id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  return new Response(null, { status: 204 });
}
