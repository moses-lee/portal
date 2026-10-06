/** `/api/agents`, `/api/sessions/**`, and `/api/blobs/**`, as the web app's Next.js routes served them. */
import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { errorMessage } from "../http/errors.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { openEventStream } from "../http/sse.ts";
import { toMeta, type SessionListChange } from "../lib/acp-runtime.ts";
import { BLOB_NAME, mimeTypeOf } from "../lib/blobs.ts";
import { errorStatus, resolveDirectory } from "../lib/fs-paths.ts";
import { displayPath } from "../lib/git-info.ts";
import { summarizeForList, summarizeSession } from "../lib/session-summary.ts";
import { deleteRemovedSessions, deleteSessionFully } from "./delete.ts";
import { attachSessionViewer } from "./viewer.ts";
import { SESSION_TITLE_MAX, type PermissionAnswerRequest, type SessionListEvent, type SetConfigRequest } from "../lib/types.ts";

/** The most sessions one `/api/sessions/streams` socket carries. */
export const STREAM_IDS_MAX = 32;
const DEFAULT_PAGE = 300;
const MAX_PAGE = 2000;
const MAX_TURNS = 50;

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

/** An event cursor: the last seq a viewer holds, or -1 for none. */
const CURSOR = /^-1$|^\d{1,15}$/;

/**
 * `/api/sessions/streams`' query: `ids=a,b` names the sessions, `since=a:5,b:-1` the last seq the
 * viewer holds for each (-1, the default, for none). Answers the cursor per id in `ids` order, or
 * the text of the 400.
 */
function parseStreamsQuery(ids: string | null, since: string | null): { cursors: Map<string, number> } | { error: string } {
  const list = (ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (list.length === 0) return { error: "no session ids" };
  const cursors = new Map(list.map((id) => [id, -1]));
  if (cursors.size > STREAM_IDS_MAX) return { error: `at most ${STREAM_IDS_MAX} session ids` };
  for (const part of (since ?? "").split(",").filter(Boolean)) {
    const at = part.lastIndexOf(":");
    const id = part.slice(0, at).trim();
    const cursor = part.slice(at + 1).trim();
    if (at < 1 || !cursors.has(id) || !CURSOR.test(cursor)) return { error: "invalid event cursor" };
    cursors.set(id, Number(cursor));
  }
  return { cursors };
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

  /**
   * Run the lifecycle sweep now (docs/SESSION-LIFECYCLE.md, "Sweep"): untrack idle tracked sessions,
   * remove idle worktrees. Joins a sweep already running. Answers `{ untracked, removed, kept }`.
   */
  app.post("/api/lifecycle/sweep", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    try {
      return await ctx.lifecycle.run();
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  app.get("/api/agents", async () =>({ agents: ctx.sessions.listAgents(), defaultAgentId: ctx.sessions.defaultAgentId }));

  app.get("/api/sessions", async () => {
    await ready();
    return {
      sessions: await Promise.all(ctx.sessions.listSessions().map((meta) => summarizeForList(meta, projectOf(meta.projectId)))),
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
   * working, waiting on a permission prompt, connected, its title, when it was last active, and its
   * liveness state (dead, blocked, busy, hung, idle).
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
      sessions: ctx.sessions.listSessions().map(({ id, busy, awaitingPermission, link, title, titleSource, lastActiveAt, idleSince, turnEndedAt, backgroundTasks, liveness }) => ({
        id, busy, awaitingPermission, link, title, titleSource, lastActiveAt, idleSince, turnEndedAt, backgroundTasks, liveness: liveness.state,
      })),
    });
    // `created` carries the full list entry, which needs the folder's git state; keep those in
    // order behind one another so a fast create-then-update cannot arrive reversed.
    let queue: Promise<void> = Promise.resolve();
    const onChange = (change: SessionListChange) => {
      queue = queue.then(async () => {
        if (stream.closed) return;
        if (change.type !== "created") { send(change); return; }
        const session = await summarizeForList(change.session, projectOf(change.session.projectId));
        send({ type: "created", session });
      }).catch(() => {});
    };
    stream.onClose(ctx.sessions.onSessionsChange(onChange));
  });

  /**
   * Several sessions' event streams on one socket: the page's open panes share it, as a browser
   * allows six connections per host on plain HTTP. `?ids=<id>,<id>` names the sessions and
   * `&since=<id>:<seq>,...` the last seq the viewer holds for each (default -1). Each session is
   * served as `/api/sessions/:id/stream` serves it, tagged with its id: default messages carry
   * `{ sessionId, seq, ...event }` under the SSE id `<sessionId>:<seq>`; `meta`, `reset` and
   * `deleted` carry `{ sessionId, ...payload }`. An unknown id gets `deleted` at once and the rest
   * proceed; the socket ends once every session on it is gone. The cursors travel in the query,
   * not `Last-Event-ID`, so the viewer reopens the stream itself instead of the browser's retry.
   */
  app.get("/api/sessions/streams", async (req, reply) => {
    const query = searchParams(req);
    const parsed = parseStreamsQuery(query.get("ids"), query.get("since"));
    if ("error" in parsed) return reply.code(400).type("text/plain; charset=utf-8").send(parsed.error);
    await ready();
    const stream = openEventStream(req, reply);
    if (stream.closed) return;
    let attached = 0;
    for (const [sessionId, since] of parsed.cursors) {
      const detach = attachSessionViewer(ctx, sessionId, since, (frame) => {
        switch (frame.kind) {
          case "event":
            stream.send({ ...frame.event, sessionId, seq: frame.seq }, { id: `${sessionId}:${frame.seq}` });
            return;
          case "meta":
            stream.send({ ...frame.meta, sessionId }, { event: "meta" });
            return;
          case "reset":
            stream.send({ sessionId }, { event: "reset" });
            return;
          case "deleted":
            stream.send({ sessionId }, { event: "deleted" });
            if (--attached === 0) stream.close();
        }
      });
      if (!detach) {
        stream.send({ sessionId }, { event: "deleted" });
        continue;
      }
      attached++;
      stream.onClose(detach);
    }
    if (attached === 0) stream.close();
  });

  // Above the `:id` routes so the literal path is never read as a session id.
  /** Delete every session whose project is gone, and the removed-project records. Answers `{ deleted }`. */
  app.delete("/api/sessions/removed", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    try {
      return { deleted: await deleteRemovedSessions(ctx) };
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  app.get<IdParams>("/api/sessions/:id", async (req, reply) => {
    await ready();
    const session = ctx.sessions.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "Unknown session." });
    // A fresh look at the agent's processes, so the liveness served is current.
    await ctx.sessions.probeSession(session.id).catch(() => {});
    return summarizeSession(toMeta(session), projectOf(session.projectId));
  });

  /**
   * Rename the session as the user: `{ title }`, trimmed, 1 to `SESSION_TITLE_MAX` characters. A
   * user's title outranks every other source, so nothing renames it afterwards but the user.
   * Viewers get it as `meta` and the list as an `updated` patch; answers the session as GET does.
   */
  app.patch<IdParams>("/api/sessions/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const body = req.body;
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).title : undefined;
    if (typeof raw !== "string") return reply.code(400).send({ error: "Expected {title: string}." });
    const title = raw.trim();
    if (!title) return reply.code(400).send({ error: "A session title cannot be empty." });
    if (title.length > SESSION_TITLE_MAX) {
      return reply.code(400).send({ error: `A session title can be at most ${SESSION_TITLE_MAX} characters.` });
    }
    await ready();
    if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
    try {
      await ctx.sessions.setTitle(req.params.id, title, "user");
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
    const session = ctx.sessions.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "Unknown session." });
    return summarizeSession(toMeta(session), projectOf(session.projectId));
  });

  /** Remove the session, its log, and its terminals. */
  app.delete<IdParams>("/api/sessions/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const { id } = req.params;
    try {
      if (!(await deleteSessionFully(ctx, id))) return reply.code(404).send({ error: "Unknown session." });
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
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
    if (!CURSOR.test(cursor)) {
      return reply.code(400).type("text/plain; charset=utf-8").send("invalid event cursor");
    }
    const since = Number(cursor);

    const stream = openEventStream(req, reply);
    if (stream.closed) return;
    const detach = attachSessionViewer(ctx, id, since, (frame) => {
      switch (frame.kind) {
        case "event":
          stream.send(frame.event, { id: frame.seq });
          return;
        case "meta":
          stream.send(frame.meta, { event: "meta" });
          return;
        case "reset":
          stream.write(`event: reset\ndata: {}\n\n`);
          return;
        case "deleted":
          stream.write(`event: deleted\ndata: {}\n\n`);
          stream.close();
      }
    });
    // The lookup above and this run without an await between them, so this is only in principle.
    if (!detach) {
      stream.write(`event: deleted\ndata: {}\n\n`);
      stream.close();
      return;
    }
    stream.onClose(detach);
  });

  /**
   * One page of the session's log, oldest first, ending before `?before=<seq>` (default: the
   * newest events) and starting at a turn boundary. Sized by `?turns=<n>` (the browser; capped
   * at `TURN_PAGE_MAX_EVENTS` rows, past which the page starts inside a turn) or `?limit=<rows>`.
   * Follow the live tail with `/stream?since=<last seq>`.
   */
  app.get<IdParams>("/api/sessions/:id/events", async (req, reply) => {
    const { id } = req.params;
    await ctx.sessions.ready;
    if (!ctx.sessions.getSession(id)) return reply.code(404).send({ error: "Unknown session." });
    const query = searchParams(req);
    const before = query.get("before") === null ? undefined : parseCount(query.get("before"));
    const turns = query.get("turns") === null ? undefined : parseCount(query.get("turns"));
    const limit = query.get("limit") === null ? DEFAULT_PAGE : parseCount(query.get("limit"));
    if (before === null || limit === null || limit < 1 || turns === null || (turns !== undefined && (turns < 1 || turns > MAX_TURNS))) {
      return reply.code(400).send({ error: "Invalid page cursor." });
    }
    return turns !== undefined
      ? ctx.sessions.readEvents(id, { before, turns })
      : ctx.sessions.readEvents(id, { before, limit: Math.min(limit, MAX_PAGE) });
  });

  /** An image a tool result carried, moved out of the event log; names are content hashes, so the response never changes. */
  app.get<{ Params: { name: string } }>("/api/blobs/:name", { compress: false }, async (req, reply) => {
    const { name } = req.params;
    const blobs = ctx.sessions.blobs;
    if (!blobs || !BLOB_NAME.test(name)) return reply.code(404).send({ error: "No such blob." });
    if (!(await blobs.has(name))) return reply.code(404).send({ error: "No such blob." });
    return reply
      .header("content-type", mimeTypeOf(name))
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(createReadStream(blobs.pathOf(name)));
  });

  /**
   * Send a prompt. With `queue: true` a busy session queues it instead of refusing (202 with the
   * queued item and its position; it goes out once the turn ends, after earlier queued prompts);
   * a free session sends it at once either way. 409 when the session is busy without `queue`,
   * the queue is full, or the agent could not be reached.
   */
  app.post<IdParams>("/api/sessions/:id/prompt", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const { text, queue } = (req.body ?? {}) as { text?: unknown; queue?: unknown };
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "empty prompt" });
    try {
      if (queue === true) {
        const { queued, position } = await ctx.sessions.sendOrQueue(req.params.id, text);
        return reply.code(202).send(queued ? { ok: true, queued, position } : { ok: true, queued: null });
      }
      await ctx.sessions.sendPrompt(req.params.id, text);
      return reply.code(202).send({ ok: true, queued: null });
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  /**
   * Save a queued prompt's new text. The prompt keeps its slot, and the edit begun with
   * `POST .../edit` ends (`editing: false`), so the queue resumes. 404 once it has gone out or was
   * removed.
   */
  app.patch<IdParams & { Params: { itemId: string } }>("/api/sessions/:id/queue/:itemId", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "empty prompt" });
    await ready();
    if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
    try {
      return { item: await ctx.sessions.updateQueued(req.params.id, req.params.itemId, text) };
    } catch (err) {
      return reply.code(404).send({ error: errorMessage(err) });
    }
  });

  /**
   * Begin editing a queued prompt: it is marked `editing` and the whole queue pauses until the
   * edit is saved (PATCH), cancelled (DELETE below), or the prompt is removed or dropped by a
   * stop. Answers `{ item }`; 404 once the prompt has gone out or was removed.
   */
  app.post<IdParams & { Params: { itemId: string } }>("/api/sessions/:id/queue/:itemId/edit", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ready();
    if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
    try {
      return { item: await ctx.sessions.beginEdit(req.params.id, req.params.itemId) };
    } catch (err) {
      return reply.code(404).send({ error: errorMessage(err) });
    }
  });

  /**
   * Cancel an edit without saving: the prompt keeps its text and the queue resumes. Answers
   * `{ item }`, null when the prompt is no longer queued (no error: there is nothing left to
   * resume).
   */
  app.delete<IdParams & { Params: { itemId: string } }>("/api/sessions/:id/queue/:itemId/edit", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ready();
    if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
    return { item: await ctx.sessions.cancelEdit(req.params.id, req.params.itemId) };
  });

  /**
   * Take a prompt out of the queue. Answers `{ removed }`: false when it was no longer there (it
   * went out as the turn ended, or another viewer removed it), so a viewer editing it knows not
   * to put the text back in its composer.
   */
  app.delete<IdParams & { Params: { itemId: string } }>("/api/sessions/:id/queue/:itemId", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ready();
    if (!ctx.sessions.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session." });
    const removed = await ctx.sessions.removeQueued(req.params.id, req.params.itemId);
    return { removed: removed !== null };
  });

  /** Stop the open turn. The queued prompts are dropped and answered, so the viewer can put them back in its composer. */
  app.post<IdParams>("/api/sessions/:id/cancel", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    try {
      const queued = await ctx.sessions.cancel(req.params.id);
      return { ok: true, queued };
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
      // Only the browser posts here (the orchestrator's set_session_config goes to the runtime), so
      // this is the user's own pick: it becomes the agent's last-used settings. Never fails the change.
      const agentId = ctx.sessions.getSession(req.params.id)?.agentId;
      if (agentId) {
        await ctx.lastUsed.recordChange(agentId, state, body).catch((err: unknown) => {
          req.log.warn({ err }, "Could not record the last-used agent settings");
        });
      }
      return { state };
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  /** Ask the agent to stop one background task; the task ends when the agent reports it stopped (list `updated` patch). */
  app.post<{ Params: { id: string; taskId: string } }>("/api/sessions/:id/tasks/:taskId/stop", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    try {
      const stopped = await ctx.sessions.stopBackgroundTask(req.params.id, req.params.taskId);
      if (!stopped) return reply.code(409).send({ error: "The agent had nothing to stop." });
      return { stopped };
    } catch (err) {
      const message = errorMessage(err);
      return reply.code(/^no such (session|background task)$/i.test(message) ? 404 : 409).send({ error: message });
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
