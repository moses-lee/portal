import { stat } from "node:fs/promises";
import os from "node:os";
import { displayPath } from "@/lib/git-info";
import { checkSameOrigin } from "@/lib/shell-http";
import { terminals } from "@/lib/terminals";
import { info } from "@/lib/terminals-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Standalone terminals: shells owned by no session, started in the host user's home directory. */
export async function GET(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  return Response.json({ terminals: terminals.listStandalone().map(info) });
}

export async function POST(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const cwd = os.homedir();
  try {
    await stat(cwd);
  } catch {
    return Response.json({ error: `Home directory is missing: ${displayPath(cwd)}` }, { status: 409 });
  }
  return Response.json(info(terminals.create({ sessionId: null, cwd })), { status: 201 });
}
