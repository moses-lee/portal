import { getSession } from "@/lib/acp";
import type { PortalEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return new Response("no such session", { status: 404 });

  const since = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("since") ?? -1);
  if (!Number.isSafeInteger(since) || since < -1) {
    return new Response("invalid event cursor", { status: 400 });
  }
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      const send = (index: number, ev: PortalEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`));
        } catch { cleanup(); }
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        session.listeners.delete(send);
        if (ping) clearInterval(ping);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) { cleanup(); return; }
      // Replay.
      for (let i = since + 1; i < session.events.length; i++) send(i, session.events[i]);
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify({ busy: session.busy, cwd: session.cwd, agentId: session.agentId, agentName: session.agentName })}\n\n`));
      // Tail.
      session.listeners.add(send);
      ping = setInterval(() => {
        try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch { cleanup(); }
      }, 15000);
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
