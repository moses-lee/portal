/**
 * One viewer of one session, as the session event streams serve it: the events after the viewer's
 * cursor replayed from memory (or `reset` when they have aged out), `meta` on connect and whenever
 * the agent's state, link or queue changes, the folder's git state, presence and owning project
 * re-read every second and re-announced when they change, and `deleted` once the session goes
 * away. Opening a viewer also reattaches the agent to a persisted session, unless the caller says
 * the session is already introduced (`attach: false`: the web's hub reopening its stream for
 * another session).
 *
 * `/api/sessions/:id/stream` carries one viewer per socket; `/api/sessions/streams` multiplexes
 * several onto one. Both are framed by their routes; this module only produces the frames.
 */
import { stat } from "node:fs/promises";
import { sameGitInfo } from "@portal/shared/git-info";
import type { AppContext } from "../context.ts";
import { readGitInfo, type GitInfo } from "../lib/git-info.ts";
import type { SessionMetaEvent, StreamedEvent } from "../lib/types.ts";

export const META_POLL_MS = 1000;

export type SessionViewerFrame =
  /** One logged event after the cursor, with its seq and logged time. */
  | { kind: "event"; seq: number; event: StreamedEvent }
  | { kind: "meta"; meta: SessionMetaEvent }
  /** The events after the cursor are no longer in memory: the viewer must refetch a page. */
  | { kind: "reset" }
  /** The session was deleted; the viewer is detached and no frame follows. */
  | { kind: "deleted" };

export type SessionViewerSink = (frame: SessionViewerFrame) => void;

/**
 * Attach a viewer of session `id` that holds events up to `since` (-1 for none). Frames reach
 * `sink` in order: the replay (or `reset`), the first `meta`, then the live tail. Answers the
 * function that detaches the viewer (safe to call more than once), or null when there is no such
 * session. With `attach` (the default) a persisted session's agent is reattached; the outcome
 * arrives as `meta.link`.
 */
export function attachSessionViewer(
  ctx: AppContext,
  id: string,
  since: number,
  sink: SessionViewerSink,
  { attach = true }: { attach?: boolean } = {},
): (() => void) | null {
  const session = ctx.sessions.getSession(id);
  if (!session) return null;

  const currentProject = (): SessionMetaEvent["project"] => {
    const owner = ctx.projects.get(session.projectId);
    return owner ? { id: owner.id, name: owner.name } : null;
  };
  let git: GitInfo = null;
  let cwdMissing = false;
  let project = currentProject();
  let checking = false;
  let detached = false;
  const sendMeta = () => {
    const meta: SessionMetaEvent = {
      busy: session.busy, link: session.link, title: session.title, titleSource: session.titleSource, cwd: session.cwd,
      agentId: session.agentId, agentName: session.agentName, git, state: session.state, project, cwdMissing, queue: [...session.queue],
    };
    sink({ kind: "meta", meta });
  };
  // The session directory is fixed, but its checked-out branch moves as the agent or a terminal
  // run git, the folder itself can disappear, and the owning project can be renamed or removed;
  // re-announce meta whenever any of those change.
  const refreshMeta = async (announce: boolean) => {
    if (checking) return;
    checking = true;
    try {
      const missing = await stat(session.cwd).then(() => false, () => true);
      // readGitInfo walks up to parent directories, so skip it once the folder itself is gone.
      const nextGit = missing ? null : await readGitInfo(session.cwd);
      if (detached) return;
      const nextProject = currentProject();
      const changed = !sameGitInfo(nextGit, git) || missing !== cwdMissing
        || nextProject?.id !== project?.id || nextProject?.name !== project?.name;
      git = nextGit;
      cwdMissing = missing;
      project = nextProject;
      if (announce || changed) sendMeta();
    } finally { checking = false; }
  };

  // Replay what the viewer missed, or tell it to start over from a fresh page.
  const missed = ctx.sessions.eventsSince(id, since);
  if (missed === null) sink({ kind: "reset" });
  else {
    for (const { seq, ...event } of missed) sink({ kind: "event", seq, event });
  }
  sendMeta();
  // Tail. Mode, model, command, connection, title, and queue changes reach viewers through `meta`, not the event log.
  const unsubscribe = ctx.sessions.subscribe(id, {
    onEvent: (seq, ev, ts) => sink({ kind: "event", seq, event: { ...ev, ts } }),
    onState: sendMeta,
    onLink: sendMeta,
    onQueue: sendMeta,
    onClose: () => {
      detach();
      sink({ kind: "deleted" });
    },
  });
  const metaPoll = setInterval(() => { void refreshMeta(false); }, META_POLL_MS);
  const detach = () => {
    if (detached) return;
    detached = true;
    clearInterval(metaPoll);
    unsubscribe();
  };
  void refreshMeta(true);
  // Reconnect a persisted session's agent; the outcome arrives as `meta.link`.
  if (attach && session.link.status !== "live") ctx.sessions.attach(id).catch(() => {});
  return detach;
}
