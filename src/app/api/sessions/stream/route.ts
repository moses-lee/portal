import { listSessions, onSessionsChange, ready, type SessionListChange } from "@/lib/acp";
import { projects } from "@/lib/projects";
import { summarizeSession } from "@/lib/session-summary";
import type { SessionListEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events feed of the session list: which sessions exist and, for each, whether it is
 * working, waiting on a permission prompt, connected, its title, and when it was last active. Every
 * connection opens with a `snapshot` (authoritative for which sessions exist, so a reconnect can
 * drop what was deleted meanwhile), then changes follow one message each.
 */
export async function GET(req: Request) {
  await Promise.all([projects.ready, ready]);
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(frame));
        } catch { cleanup(); }
      };
      const send = (event: SessionListEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (ping) clearInterval(ping);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) { cleanup(); return; }
      send({
        type: "snapshot",
        sessions: listSessions().map(({ id, busy, awaitingPermission, link, title, lastActiveAt }) => ({ id, busy, awaitingPermission, link, title, lastActiveAt })),
      });
      // `created` carries the full list entry, which needs the folder's git state; keep those in
      // order behind one another so a fast create-then-update cannot arrive reversed.
      let queue: Promise<void> = Promise.resolve();
      const onChange = (change: SessionListChange) => {
        queue = queue.then(async () => {
          if (closed) return;
          if (change.type !== "created") { send(change); return; }
          const session = await summarizeSession(change.session, projects.get(change.session.projectId) ?? null);
          send({ type: "created", session });
        }).catch(() => {});
      };
      unsubscribe = onSessionsChange(onChange);
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
