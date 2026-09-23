import { parseItemPatch } from "@/lib/orchestrator/store";
import { readObject, withOrchestrator } from "../../respond";

export const dynamic = "force-dynamic";

/** `PATCH /api/portal/items/[id]` — body `ItemPatch` (status, snoozedUntil, list, …) -> `{ item }`; 400 for a body that is not one. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withOrchestrator(req, async (runtime) => {
    const body = await readObject(req);
    if (body instanceof Response) return body;
    const { id } = await params;
    return { item: await runtime.updateItem(id, parseItemPatch(body)) };
  });
}
