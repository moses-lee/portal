/** `/api/agents`, `/api/sessions/**`, as the web app's Next.js routes served them. */
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { errorMessage } from "../http/errors.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { openEventStream } from "../http/sse.ts";
import { toMeta, type SessionListChange } from "../lib/acp-runtime.ts";
import { errorStatus, resolveDirectory } from "../lib/fs-paths.ts";
import { sameGitInfo } from "@portal/shared/git-info";
import { displayPath, readGitInfo, type GitInfo } from "../lib/git-info.ts";
import { summarizeSession } from "../lib/session-summary.ts";
import type { PermissionAnswerRequest, PortalEvent, SessionListEvent, SessionMetaEvent, SetConfigRequest } from "../lib/types.ts";

const META_POLL_MS = 1000;
const DEFAULT_PAGE = 300;
const MAX_PAGE = 2000;

type IdParams = { Params: { id: string } };

/** A plain non-negative decimal integer, or null. */
function parseCount(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/** The query string as the web routes read it (`URLSearchParams.get` takes the first of repeated keys). */
function searchParams(req: FastifyRequest): URLSearchParams {
  return new URL(req.url, "http://portal.invalid").searchParams;
}

function parseConfigBody(body: unknown): SetConfigRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { configId, value, modeId } = body as Record<string, unknown>;
  if (typeof modeId === "string" && modeId && configId === undefined && value === undefined) return { modeId };
  if (typeof configId === "string" && configId && modeId === undefined
    && ((typeof value === "string" && value) || typeof value === "boolean")) {
    return { configId, value };
  }
  return null;
}

function parsePermissionBody(body: unknown): PermissionAnswerRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { requestId, optionId } = body as Record<string, unknown>;
  if (typeof requestId !== "string" || !requestId) return null;
  if (optionId !== null && (typeof optionId !== "string" || !optionId)) return null;
  return { requestId, optionId };
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ready = () => Promise.all([ctx.projects.ready, ctx.sessions.ready]);
  const projectOf = (projectId: string) => ctx.projects.get(projectId) ?? null;

  app.get("/api/agents", async () => ({ agents: ctx.sessions.listAgents(), defaultAgentId: ctx.sessions.defaultAgentId }));

  app.get("/api/sessions", async () => {
    await ready();
    return {
      sessions: await Promise.all(ctx.sessions.listSessions().map((meta) => summarizeSession(meta, projectOf(meta.projectId)))),
    };
  });

  app.post("/api/sessions", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "Expected a JSON object." });
    }
    const { projectId, agentId: requestedAgentId } = body as Record<string, unknown>;
    if (typeof projectId !== "string" || !projectId) {
      return reply.code(400).send({ error: "Choose a project to start the session in." });
    }
    const agentId = requestedAgentId === undefined ? ctx.sessions.defaultAgentId : requestedAgentId;
    if (typeof agentId !== "string" || !ctx.sessions.getAgent(agentId)) {
      return reply.code(400).send({ error: "Unknown agent. Choose an agent from the dropdown." });
    }
    await ctx.projects.ready;
    const project = ctx.projects.get(projectId);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    let cwd: string;
    try {
      // The project stores a realpath, but the folder may have been deleted or renamed since.
      cwd = await resolveDirectory(project.path);
    } catch (err) {
      if (errorStatus(err) === 404) {
        return reply.code(409).send({ error: `Project folder is missing: ${displayPath(project.path)}` });
      }
      return reply.code(errorStatus(err) ?? 500).send({ error: errorMessage(err) });
    }
    try {
      const session = await ctx.sessions.createSession(cwd, agentId, project.id);
      return await summarizeSession(toMeta(session), project);
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  /**
   * Server-Sent Events feed of the session list: which sessions exist and, for each, whether it is
   * working, waiting on a permission prompt, connected, its title, and when it was last active.
   * Every connection opens with a `snapshot` (authoritative for which sessions exist, so a
   * reconnect can drop what was deleted meanwhile), then changes follow one message each.
   */
  app.get("/api/sessions/stream", async (req, reply) => {
    await ready();
    const stream = openEventStream(req, reply);
    if (stream.closed) return;
    // Any open Portal tab counts as an attended Portal for the orchestrator's scheduler.
    stream.onClose(ctx.presence.open());
    const send = (event: SessionListEvent) => stream.send(event);
    send({
      type: "snapshot",
      sessions: ctx.sessions.listSessions().map(({ id, busy, awaitingPermission, link, title, lastActiveAt }) => ({ id, busy, awaitingPermission, link, title, lastActiveAt })),
    });
    // `created` carries the full list entry, which needs the folder's git state; keep those in
    // order behind one another so a fast create-then-update cannot arrive reversed.
    let queue: Promise<void> = Promise.resolve();
    const onChange = (change: SessionListChange) => {
      queue = queue.then(async () => {
        if (stream.closed) return;
        if (change.type !== "created") { send(change); return; }
        const session = await summarizeSession(change.session, projectOf(change.session.projectId));
        send({ type: "created", session });
      }).catch(() => {});
    };
    stream.onClose(ctx.sessions.onSessionsChange(onChange));
  });

  app.get<IdParams>("/api/sessions/:id", async (req, reply) => {
    await ready();
    const session = ctx.sessions.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "Unknown session." });
    return summarizeSession(toMeta(session), projectOf(session.projectId));
  });

  /** Remove the session, its log, and its terminals. */
  app.delete<IdParams>("/api/sessions/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const { id } = req.params;
    try {
      if (!(await ctx.sessions.deleteSession(id))) return reply.code(404).send({ error: "Unknown session." });
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
    ctx.terminals.closeSession(id);
    return reply.code(204).send();
  });

  /**
   * Server-Sent Events tail of a session. `?since=<seq>` (or `Last-Event-ID` on reconnect) names
   * the last event the viewer holds; events after it are replayed from memory, then new ones
   * stream as they happen. If that gap has aged out of memory a `reset` event tells the viewer to
   * refetch a page. Opening the stream also reattaches the agent to a persisted session.
   */
  app.get<IdParams>("/api/sessions/:id/stream", async (req, reply) => {
    const { id } = req.params;
    await ready();
    const session = ctx.sessions.getSession(id);
    if (!session) return reply.code(404).type("text/plain; charset=utf-8").send("no such session");

    // EventSource sends the last `id:` it saw on reconnect; a first connection names it in the query.
    const lastEventId = req.headers["last-event-id"];
    const cursor = (typeof lastEventId === "string" && lastEventId) || searchParams(req).get("since") || "-1";
    if (!/^-1$|^\d{1,15}$/.test(cursor)) {
      return reply.code(400).type("text/plain; charset=utf-8").send("invalid event cursor");
    }
    const since = Number(cursor);

    const stream = openEventStream(req, reply);
    if (stream.closed) return;
    const currentProject = (): SessionMetaEvent["project"] => {
      const owner = ctx.projects.get(session.projectId);
      return owner ? { id: owner.id, name: owner.name } : null;
    };
    let git: GitInfo = null;
    let cwdMissing = false;
    let project = currentProject();
    let checking = false;
    const send = (seq: number, ev: PortalEvent) => stream.send(ev, { id: seq });
    const sendMeta = () => {
      const meta: SessionMetaEvent = {
        busy: session.busy, link: session.link, title: session.title, cwd: session.cwd,
        agentId: session.agentId, agentName: session.agentName, git, state: session.state, project, cwdMissing,
      };
      stream.send(meta, { event: "meta" });
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
        if (stream.closed) return;
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
    if (missed === null) stream.write(`event: reset\ndata: {}\n\n`);
    else {
      for (const stored of missed) {
        const ev: Record<string, unknown> = { ...stored };
        delete ev.seq;
        delete ev.ts;
        send(stored.seq, ev as PortalEvent);
      }
    }
    sendMeta();
    // Tail. Mode, model, command, connection, and title changes reach viewers through `meta`, not the event log.
    stream.onClose(ctx.sessions.subscribe(id, {
      onEvent: send,
      onState: sendMeta,
      onLink: sendMeta,
      onClose: () => {
        stream.write(`event: deleted\ndata: {}\n\n`);
        stream.close();
      },
    }));
    const metaPoll = setInterval(() => { void refreshMeta(false); }, META_POLL_MS);
    stream.onClose(() => clearInterval(metaPoll));
    void refreshMeta(true);
    // Reconnect a persisted session's agent; the outcome arrives as `meta.link`.
    if (session.link.status !== "live") ctx.sessions.attach(id).catch(() => {});
  });

  /**
   * One page of the session's log, oldest first, ending before `?before=<seq>` (default: the
   * newest events) and starting at a turn boundary. Follow the live tail with `/stream?since=<last seq>`.
   */
  app.get<IdParams>("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params;
    await ctx.sessions.ready;
    if (!ctx.sessions.getSession(id)) return reply.code(404).send({ error: "Unknown session." });
    const query = searchParams(req);
    const before = query.get("before") === null ? undefined : parseCount(query.get("before"));
    const limit = query.get("limit") === null ? DEFAULT_PAGE : parseCount(query.get("limit"));
    if (before === null || limit === null || limit < 1) {
      return reply.code(400).send({ error: "Invalid page cursor." });
    }
    return ctx.sessions.readEvents(id, { before, limit: Math.min(limit, MAX_PAGE) });
  });

  app.post<IdParams>("/api/sessions/:id/prompt", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "empty prompt" });
    try {
      await ctx.sessions.sendPrompt(req.params.id, text);
      return reply.code(202).send({ ok: true });
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  app.post<IdParams>("/api/sessions/:id/cancel", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    try {
      await ctx.sessions.cancel(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  app.post<IdParams>("/api/sessions/:id/permission", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body = parsePermissionBody(req.body);
    if (!body) return reply.code(400).send({ error: "Expected {requestId, optionId: string | null}." });
    try {
      ctx.sessions.respondPermission(req.params.id, body.requestId, body.optionId);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  app.post<IdParams>("/api/sessions/:id/config", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body = parseConfigBody(req.body);
    if (!body) return reply.code(400).send({ error: "Expected {configId, value} or {modeId}." });
    try {
      const state = "modeId" in body
        ? await ctx.sessions.setMode(req.params.id, body.modeId)
        : await ctx.sessions.setConfigOption(req.params.id, body.configId, body.value);
      return { state };
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  /** Reconnect the agent to a persisted session; progress and the outcome arrive as `meta` on the stream. */
  app.post<IdParams>("/api/sessions/:id/attach", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    try {
      await ctx.sessions.attach(req.params.id);
      return { ok: true };
    } catch (err) {
      const message = errorMessage(err);
      return reply.code(/no such session/i.test(message) ? 404 : 409).send({ error: message });
    }
  });
}
