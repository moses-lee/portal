import { stat } from "node:fs/promises";
import { attach, eventsSince, getSession, ready } from "@/lib/acp";
import { readGitInfo, sameGitInfo, type GitInfo } from "@/lib/git-info";
import { projects } from "@/lib/projects";
import type { PortalEvent, SessionMetaEvent } from "@/lib/types";

const META_POLL_MS = 1000;

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events tail of a session. `?since=<seq>` (or `Last-Event-ID` on reconnect) names the
 * last event the viewer holds; events after it are replayed from memory, then new ones stream as
 * they happen. If that gap has aged out of memory a `reset` event tells the viewer to refetch a
 * page. Opening the stream also reattaches the agent to a persisted session.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await Promise.all([projects.ready, ready]);
  const session = getSession(id);
  if (!session) return new Response("no such session", { status: 404 });

  // EventSource sends the last `id:` it saw on reconnect; a first connection names it in the query.
  const cursor = req.headers.get("last-event-id") || new URL(req.url).searchParams.get("since") || "-1";
  if (!/^-1$|^\d{1,15}$/.test(cursor)) {
    return new Response("invalid event cursor", { status: 400 });
  }
  const since = Number(cursor);
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
      const write = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(frame));
        } catch { cleanup(); }
      };
      const send = (seq: number, ev: PortalEvent) => write(`id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      const sendMeta = () => {
        const meta: SessionMetaEvent = {
          busy: session.busy, link: session.link, title: session.title, cwd: session.cwd,
          agentId: session.agentId, agentName: session.agentName, git, state: session.state, project, cwdMissing,
        };
        write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
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
      // Mode, model, command, connection, and title changes reach viewers through `meta`, not the event log.
      const onState = () => sendMeta();
      const onClose = () => {
        write(`event: deleted\ndata: {}\n\n`);
        cleanup();
      };
      cleanup = () => {
        if (closed) return;
        closed = true;
        session.listeners.delete(send);
        session.stateListeners.delete(onState);
        session.linkListeners.delete(onState);
        session.closeListeners.delete(onClose);
        if (ping) clearInterval(ping);
        if (metaPoll) clearInterval(metaPoll);
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) { cleanup(); return; }
      // Replay what the viewer missed, or tell it to start over from a fresh page.
      const missed = eventsSince(id, since);
      if (missed === null) write(`event: reset\ndata: {}\n\n`);
      else {
        for (const stored of missed) {
          const ev: Record<string, unknown> = { ...stored };
          delete ev.seq;
          delete ev.ts;
          send(stored.seq, ev as PortalEvent);
        }
      }
      sendMeta();
      // Tail.
      session.listeners.add(send);
      session.stateListeners.add(onState);
      session.linkListeners.add(onState);
      session.closeListeners.add(onClose);
      ping = setInterval(() => write(`: ping\n\n`), 15000);
      metaPoll = setInterval(() => { void refreshMeta(false); }, META_POLL_MS);
      req.signal.addEventListener("abort", cleanup, { once: true });
      void refreshMeta(true);
      // Reconnect a persisted session's agent; the outcome arrives as `meta.link`.
      if (session.link.status !== "live") attach(id).catch(() => {});
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
