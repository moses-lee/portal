import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { createSession, listSessions } from "@/lib/acp";
import { defaultAgentId, getAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ sessions: listSessions() });
}

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }
  const { cwd: requestedCwd, agentId: requestedAgentId } = body as Record<string, unknown>;
  if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
    return NextResponse.json({ error: "Working directory must be a string." }, { status: 400 });
  }
  const agentId = requestedAgentId === undefined ? defaultAgentId : requestedAgentId;
  if (typeof agentId !== "string" || !getAgent(agentId)) {
    return NextResponse.json({ error: "Unknown agent. Choose an agent from the dropdown." }, { status: 400 });
  }
  let cwd = (requestedCwd ?? "").trim() || os.homedir();
  if (cwd === "~" || cwd.startsWith("~/")) cwd = path.join(os.homedir(), cwd.slice(1));
  cwd = path.resolve(cwd);
  try {
    const s = await createSession(cwd, agentId);
    return NextResponse.json({
      id: s.id,
      agentId: s.agentId,
      agentName: s.agentName,
      cwd: s.cwd,
      createdAt: s.createdAt,
      busy: s.busy,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
