import { NextResponse } from "next/server";
import { sendPrompt } from "@/lib/acp";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { text } = (await req.json()) as { text?: string };
  if (!text?.trim()) return NextResponse.json({ error: "empty prompt" }, { status: 400 });
  try {
    await sendPrompt(id, text);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
