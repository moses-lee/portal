import { getSession } from "@/lib/acp";
import { readGitInfo, sameGitInfo, type GitInfo } from "@/lib/git-info";
import type { PortalEvent } from "@/lib/types";

const GIT_POLL_MS = 1000;

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
      let gitPoll: ReturnType<typeof setInterval> | null = null;
      let git: GitInfo = null;
      let checkingGit = false;
      const send = (index: number, ev: PortalEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`));
        } catch { cleanup(); }
      };
      const sendMeta = () => {
        if (closed) return;
        const meta = { busy: session.busy, cwd: session.cwd, agentId: session.agentId, agentName: session.agentName, git };
        try {
          controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
        } catch { cleanup(); }
      };
      // The session directory is fixed, but its checked-out branch moves as the agent or the
      // shell run git; re-announce meta whenever it changes.
      const refreshGit = async (announce: boolean) => {
        if (checkingGit) return;
        checkingGit = true;
        try {
          const next = await readGitInfo(session.cwd);
          if (closed) return;
          const changed = !sameGitInfo(next, git);
          git = next;
          if (announce || changed) sendMeta();
        } finally { checkingGit = false; }
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        session.listeners.delete(send);
        if (ping) clearInterval(ping);
        if (gitPoll) clearInterval(gitPoll);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) { cleanup(); return; }
      // Replay.
      for (let i = since + 1; i < session.events.length; i++) send(i, session.events[i]);
      sendMeta();
      // Tail.
      session.listeners.add(send);
      ping = setInterval(() => {
        try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch { cleanup(); }
      }, 15000);
      gitPoll = setInterval(() => { void refreshGit(false); }, GIT_POLL_MS);
      req.signal.addEventListener("abort", cleanup, { once: true });
      void refreshGit(true);
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
