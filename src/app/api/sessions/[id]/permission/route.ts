import { NextResponse } from "next/server";
import { respondPermission } from "@/lib/acp";
import type { PermissionAnswerRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseBody(body: unknown): PermissionAnswerRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { requestId, optionId } = body as Record<string, unknown>;
  if (typeof requestId !== "string" || !requestId) return null;
  if (optionId !== null && (typeof optionId !== "string" || !optionId)) return null;
  return { requestId, optionId };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = parseBody(await req.json().catch(() => null));
  if (!body) {
    return NextResponse.json({ error: "Expected {requestId, optionId: string | null}." }, { status: 400 });
  }
  try {
    respondPermission(id, body.requestId, body.optionId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
