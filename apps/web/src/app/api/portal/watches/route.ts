import { withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `GET /api/portal/watches` — `{ watches }`. */
export async function GET(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ watches: await runtime.listWatches() }));
}
