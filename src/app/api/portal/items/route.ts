import { withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `GET /api/portal/items` — every item, in every status `{ items }`. */
export async function GET(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ items: await runtime.listItems() }));
}
