import { NextResponse } from "next/server";
import { setConfigOption, setMode } from "@/lib/acp";
import type { SetConfigRequest } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseBody(body: unknown): SetConfigRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { configId, value, modeId } = body as Record<string, unknown>;
  if (typeof modeId === "string" && modeId && configId === undefined && value === undefined) return { modeId };
  if (typeof configId === "string" && configId && modeId === undefined
    && ((typeof value === "string" && value) || typeof value === "boolean")) {
    return { configId, value };
  }
  return null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = parseBody(await req.json().catch(() => null));
  if (!body) {
    return NextResponse.json({ error: "Expected {configId, value} or {modeId}." }, { status: 400 });
  }
  try {
    const state = "modeId" in body
      ? await setMode(id, body.modeId)
      : await setConfigOption(id, body.configId, body.value);
    return NextResponse.json({ state });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
