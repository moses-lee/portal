import { NextResponse } from "next/server";
import { cancel } from "@/lib/acp";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await cancel(id);
  return NextResponse.json({ ok: true });
}
