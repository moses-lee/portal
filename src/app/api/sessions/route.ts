import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { createSession, listSessions } from "@/lib/acp";
import { defaultAgentId, getAgent } from "@/lib/agents";
import { summarizeSession } from "@/lib/session-summary";
import { shell } from "@/lib/shell";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ sessions: await Promise.all(listSessions().map(summarizeSession)) });
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
  try {
    // The UI omits cwd so a new chat uses the authoritative shared shell directory.
    let cwd = (requestedCwd ?? "").trim() || await shell.workingDirectory();
    if (cwd === "~" || cwd.startsWith("~/")) cwd = path.join(os.homedir(), cwd.slice(1));
    cwd = path.resolve(cwd);
    const session = await createSession(cwd, agentId);
    return NextResponse.json(await summarizeSession(session));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
