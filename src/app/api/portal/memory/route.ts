import { NextResponse } from "next/server";
import { readObject, withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `GET /api/portal/memory` — the orchestrator's memory file `{ memory }`. */
export async function GET(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ memory: await runtime.readMemory() }));
}

/** `PUT /api/portal/memory` — body `{ memory }` replaces it -> `{ memory }`. */
export async function PUT(req: Request) {
  return withOrchestrator(req, async (runtime) => {
    const body = await readObject(req);
    if (body instanceof Response) return body;
    if (typeof body.memory !== "string") return NextResponse.json({ error: "Expected { memory: string }." }, { status: 400 });
    await runtime.writeMemory(body.memory);
    return { memory: await runtime.readMemory() };
  });
}
