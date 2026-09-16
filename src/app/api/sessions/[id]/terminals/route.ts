import { stat } from "node:fs/promises";
import { getSession } from "@/lib/acp";
import { displayPath } from "@/lib/git-info";
import { checkSameOrigin } from "@/lib/shell-http";
import { terminals } from "@/lib/terminals";
import { info } from "@/lib/terminals-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  if (!getSession(id)) return Response.json({ error: "Unknown session." }, { status: 404 });
  return Response.json({ terminals: terminals.listBySession(id).map(info) });
}

export async function POST(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Unknown session." }, { status: 404 });
  try {
    await stat(session.cwd);
  } catch {
    return Response.json({ error: `Project folder is missing: ${displayPath(session.cwd)}` }, { status: 409 });
  }
  return Response.json(info(terminals.create({ sessionId: id, cwd: session.cwd })), { status: 201 });
}
