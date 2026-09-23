import { withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `POST /api/portal/tick` — runs one manual tick now and answers `{ report }` when it finishes. */
export async function POST(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ report: await runtime.runTick("manual") }));
}
