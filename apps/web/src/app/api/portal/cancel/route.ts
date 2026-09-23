import { withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `POST /api/portal/cancel` — stops the running chat turn or tick; 204 either way. */
export async function POST(req: Request) {
  return withOrchestrator(req, async (runtime) => {
    runtime.cancel();
    return new Response(null, { status: 204 });
  });
}
