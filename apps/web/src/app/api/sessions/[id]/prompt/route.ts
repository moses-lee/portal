import { NextResponse } from "next/server";
import { sendPrompt } from "@/lib/acp";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  const { text } = ((await req.json().catch(() => ({}))) ?? {}) as { text?: string };
  if (!text?.trim()) return NextResponse.json({ error: "empty prompt" }, { status: 400 });
  try {
    await sendPrompt(id, text);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
