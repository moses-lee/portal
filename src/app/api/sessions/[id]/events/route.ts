import { getSession, type PortalEvent } from "@/lib/acp";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return new Response("no such session", { status: 404 });

  const since = Number(new URL(req.url).searchParams.get("since") ?? -1);
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (index: number, ev: PortalEvent) => {
        controller.enqueue(enc.encode(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`));
      };
      // Replay.
      for (let i = since + 1; i < session.events.length; i++) send(i, session.events[i]);
      controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify({ busy: session.busy, cwd: session.cwd })}\n\n`));
      // Tail.
      session.listeners.add(send);
      const ping = setInterval(() => controller.enqueue(enc.encode(`: ping\n\n`)), 15000);
      req.signal.addEventListener("abort", () => {
        session.listeners.delete(send);
        clearInterval(ping);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
