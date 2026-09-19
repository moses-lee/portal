import { NextResponse } from "next/server";
import { parseIndex, withOrchestrator } from "../../../../respond";

export const dynamic = "force-dynamic";

/**
 * `POST /api/portal/items/[id]/actions/[index]` — performs the item's action server-side
 * (start a session, send a prompt, remove a worktree) -> `{ sessionId? }`. `open_*` actions
 * belong to the browser and are rejected by the runtime.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  return withOrchestrator(req, async (runtime) => {
    const { id, index } = await params;
    const actionIndex = parseIndex(index);
    if (actionIndex === null) return NextResponse.json({ error: "Expected a numeric action index." }, { status: 400 });
    return runtime.performAction(id, actionIndex);
  });
}
