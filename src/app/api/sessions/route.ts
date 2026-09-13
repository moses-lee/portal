import { NextResponse } from "next/server";
import os from "node:os";
import path from "node:path";
import { createSession, listSessions } from "@/lib/acp";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ sessions: listSessions() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { cwd?: string };
  let cwd = (body.cwd ?? "").trim() || os.homedir();
  if (cwd.startsWith("~")) cwd = path.join(os.homedir(), cwd.slice(1));
  cwd = path.resolve(cwd);
  try {
    const s = await createSession(cwd);
    return NextResponse.json({ id: s.id, cwd: s.cwd, createdAt: s.createdAt });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
