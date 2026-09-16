import { stat } from "node:fs/promises";
import { getSession } from "@/lib/acp";
import { readGitInfo, sameGitInfo, type GitInfo } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import type { PortalEvent, SessionMetaEvent } from "@/lib/types";

const META_POLL_MS = 1000;

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return new Response("no such session", { status: 404 });

  const since = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("since") ?? -1);
  if (!Number.isSafeInteger(since) || since < -1) {
    return new Response("invalid event cursor", { status: 400 });
  }
  await projects.ready;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      let metaPoll: ReturnType<typeof setInterval> | null = null;
      const currentProject = (): SessionMetaEvent["project"] => {
        const owner = projects.get(session.projectId);
        return owner ? { id: owner.id, name: owner.name } : null;
      };
      let git: GitInfo = null;
      let cwdMissing = false;
      let project = currentProject();
      let checking = false;
      const send = (index: number, ev: PortalEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`));
        } catch { cleanup(); }
      };
      const sendMeta = () => {
        if (closed) return;
        const meta: SessionMetaEvent = {
          busy: session.busy, cwd: session.cwd, agentId: session.agentId, agentName: session.agentName, git,
          state: session.state, project, cwdMissing,
        };
        try {
          controller.enqueue(enc.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));
        } catch { cleanup(); }
      };
      // The session directory is fixed, but its checked-out branch moves as the agent or a
      // terminal run git, the folder itself can disappear, and the owning project can be renamed
      // or removed; re-announce meta whenever any of those change.
      const refreshMeta = async (announce: boolean) => {
        if (checking) return;
        checking = true;
        try {
          const missing = await stat(session.cwd).then(() => false, () => true);
          // readGitInfo walks up to parent directories, so skip it once the folder itself is gone.
          const nextGit = missing ? null : await readGitInfo(session.cwd);
          if (closed) return;
          const nextProject = currentProject();
          const changed = !sameGitInfo(nextGit, git) || missing !== cwdMissing
            || nextProject?.id !== project?.id || nextProject?.name !== project?.name;
          git = nextGit;
          cwdMissing = missing;
          project = nextProject;
          if (announce || changed) sendMeta();
        } finally { checking = false; }
      };
      // Mode, model, and command changes reach viewers through `meta`, not the event log.
      const onState = () => sendMeta();
      cleanup = () => {
        if (closed) return;
        closed = true;
        session.listeners.delete(send);
        session.stateListeners.delete(onState);
        if (ping) clearInterval(ping);
        if (metaPoll) clearInterval(metaPoll);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) { cleanup(); return; }
      // Replay.
      for (let i = since + 1; i < session.events.length; i++) send(i, session.events[i]);
      sendMeta();
      // Tail.
      session.listeners.add(send);
      session.stateListeners.add(onState);
      ping = setInterval(() => {
        try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch { cleanup(); }
      }, 15000);
      metaPoll = setInterval(() => { void refreshMeta(false); }, META_POLL_MS);
      req.signal.addEventListener("abort", cleanup, { once: true });
      void refreshMeta(true);
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
