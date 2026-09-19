import { getOrchestrator } from "@/lib/orchestrator/runtime";
import type { OrchestratorEvent } from "@/lib/orchestrator/types";
import { presence } from "@/lib/presence";
import { checkSameOrigin } from "@/lib/shell-http";
import { fail } from "../respond";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events feed of the orchestrator: opens with `status`, `items`, and `watches`, then
 * forwards every runtime event (`status`, `messages`, `items`, `watches`, `tick`) as it happens.
 * Holding this stream open counts the browser as present, which picks the shorter tick interval.
 */
export async function GET(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  let runtime;
  let opening: OrchestratorEvent[];
  try {
    runtime = getOrchestrator();
    await runtime.ready;
    const [status, items, watches] = await Promise.all([runtime.status(), runtime.listItems(), runtime.listWatches()]);
    opening = [{ type: "status", status }, { type: "items", items }, { type: "watches", watches }];
  } catch (err) {
    return fail(err);
  }
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      const leave = presence.open();
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(frame));
        } catch { cleanup(); }
      };
      const send = (event: OrchestratorEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        leave();
        if (ping) clearInterval(ping);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) { cleanup(); return; }
      for (const event of opening) send(event);
      unsubscribe = runtime.subscribe(send);
      ping = setInterval(() => write(`: ping\n\n`), 15000);
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
