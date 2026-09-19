import { withOrchestrator } from "./respond";

export const dynamic = "force-dynamic";

/** `GET /api/portal` — `{ status }`: readiness, model, busy flag, presence, last and next tick. */
export async function GET(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ status: await runtime.status() }));
}
