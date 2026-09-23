import { NextResponse } from "next/server";
import { cancel } from "@/lib/acp";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    await cancel(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
