import { NextResponse } from "next/server";
import { attach } from "@/lib/acp";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

/** Reconnect the agent to a persisted session; progress and the outcome arrive as `meta` on the stream. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    await attach(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: /no such session/i.test(message) ? 404 : 409 });
  }
}
