import { withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `GET /api/portal/ticks` — the last tick reports, newest last `{ ticks }`. */
export async function GET(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ ticks: await runtime.listTicks() }));
}
