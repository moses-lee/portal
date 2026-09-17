import { NextResponse } from "next/server";
import { deleteSession, getSession, ready } from "@/lib/acp";
import { projects } from "@/lib/projects";
import { summarizeSession } from "@/lib/session-summary";
import { checkSameOrigin } from "@/lib/shell-http";
import { terminals } from "@/lib/terminals";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Context) {
  const { id } = await params;
  await Promise.all([projects.ready, ready]);
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: "Unknown session." }, { status: 404 });
  return NextResponse.json(await summarizeSession(session, projects.get(session.projectId) ?? null));
}

/** Remove the session, its log, and its terminals. */
export async function DELETE(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    if (!(await deleteSession(id))) return NextResponse.json({ error: "Unknown session." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  terminals.closeSession(id);
  return new Response(null, { status: 204 });
}
