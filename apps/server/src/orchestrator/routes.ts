/**
 * `/api/portal/**`, as the web app's Next.js routes served it. Every route (reads included, as on the
 * web) is same-origin checked first; runtime and store errors carry their HTTP status (409 busy or
 * not ready, 404 unknown item, 400 bad patch) and reach the browser as `{ error }` through the
 * app's error handler.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { openEventStream } from "../http/sse.ts";
import { registerApprovalRoutes } from "./approvals/routes.ts";
import { registerJobRoutes } from "./jobs/routes.ts";
import { registerMemoryRoutes } from "./memory/routes.ts";
import { parseItemPatch } from "./store.ts";
import type { OrchestratorEvent, OrchestratorMessage } from "./types.ts";
import { MAIN_THREAD_ID } from "./types.ts";
import { registerWorldRoutes } from "./world/routes.ts";

type IdParams = { Params: { id: string } };

/** The request's JSON body as an object, or null (answer 400). */
function readObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const notAnObject = (reply: FastifyReply) => reply.code(400).send({ error: "Expected a JSON object body." });

/** A query value as a non-negative integer, or undefined. */
function queryInt(value: unknown): number | undefined {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
}

const queryString = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** The `:index` segment as a non-negative integer, or null. */
function parseIndex(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * The user message the thread will keep, rebuilt from what the client sent: its id (so the
 * browser's copy and the stored one line up) and the text of its text parts, joined. Everything
 * else (other part kinds, metadata) is the server's to decide, so nothing arbitrary gets stored
 * or shown to the model. Null when there is no text.
 */
function parseUserMessage(value: unknown): OrchestratorMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "user" || !Array.isArray(message.parts)) return null;
  const text = (message.parts as unknown[])
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const { type, text } = part as Record<string, unknown>;
      return type === "text" && typeof text === "string" && text.trim() ? [text.trim()] : [];
    })
    .join("\n");
  if (!text) return null;
  return {
    id: typeof message.id === "string" && message.id ? message.id : randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { at: Date.now() },
  };
}

/**
 * Hands a web `Response` (the AI SDK's UI message stream) to Fastify: same status and headers, body
 * piped as it arrives. `no-transform` on top of the SDK's `no-cache`: without it the Next proxy
 * gzips the stream and never flushes, so the reply would reach the browser in one piece at the end.
 */
function sendWebResponse(reply: FastifyReply, response: Response) {
  reply.code(response.status);
  response.headers.forEach((value, name) => { void reply.header(name, value); });
  void reply.header("cache-control", "no-cache, no-transform");
  return reply.send(response.body ? Readable.fromWeb(response.body as unknown as NodeReadableStream) : null);
}

export function registerOrchestratorRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Same-origin check, then the ready runtime; null when the request was already answered with a 403. */
  async function runtimeFor(req: FastifyRequest, reply: FastifyReply) {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    return ctx.orchestrator;
  }

  /** `GET /api/portal` — `{ status }`: readiness, model, busy flag, presence, runs, next job, counts. */
  app.get("/api/portal", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    return { status: await runtime.status() };
  });

  /** `GET /api/portal/messages` — the whole thread `{ messages }`. */
  app.get("/api/portal/messages", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    return { messages: await runtime.history() };
  });

  /** Answers a chat turn in `threadId` for the request's `{ message }` body. */
  async function postMessage(req: FastifyRequest, reply: FastifyReply, threadId: string) {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    const body = readObject(req.body);
    if (!body) return notAnObject(reply);
    const message = parseUserMessage(body.message);
    if (!message) return reply.code(400).send({ error: "Expected { message } with role \"user\" and a non-empty text part." });
    return sendWebResponse(reply, await runtime.chat(message, threadId));
  }

  /**
   * `POST /api/portal/messages` — body `{ message }`, the newest user message only (the server owns
   * the history); only its id and text are used. A turn in the main thread; answers with the AI SDK
   * UI message stream; 409 (JSON) while not ready or while the main thread is answering. Not
   * compressed: gzip would hold the stream's chunks back.
   */
  app.post("/api/portal/messages", { compress: false }, (req, reply) => postMessage(req, reply, MAIN_THREAD_ID));

  /** `GET /api/portal/threads` — `{ threads }`: main first, then side threads by latest activity. */
  app.get("/api/portal/threads", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    return { threads: await runtime.listThreads() };
  });

  /** `GET /api/portal/threads/:id/messages` — one thread's messages `{ messages }`; 404 for an unknown thread. */
  app.get<IdParams>("/api/portal/threads/:id/messages", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    if (!(await runtime.hub.store.getThread(req.params.id))) return reply.code(404).send({ error: `Unknown thread "${req.params.id}".` });
    return { messages: await runtime.history(req.params.id) };
  });

  /** `POST /api/portal/threads/:id/messages` — as `POST /api/portal/messages`, in that thread (each thread has its own lock). */
  app.post<IdParams>("/api/portal/threads/:id/messages", { compress: false }, (req, reply) => postMessage(req, reply, req.params.id));

  /** `POST /api/portal/threads/:id/cancel` — stops that thread's chat turn; background jobs keep going. 204 either way. */
  app.post<IdParams>("/api/portal/threads/:id/cancel", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    runtime.cancel(req.params.id);
    return reply.code(204).send();
  });

  /** `GET /api/portal/activity?before=&limit=&kind=&threadId=&runId=` — `{ entries }`, newest first. */
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/portal/activity", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    const query = req.query ?? {};
    return {
      entries: await runtime.hub.activity.list({
        before: queryInt(query.before), limit: queryInt(query.limit), kind: queryString(query.kind),
        threadId: queryString(query.threadId), runId: queryString(query.runId),
      }),
    };
  });

  /** `POST /api/portal/cancel` — stops the main thread's chat turn; background jobs keep going. 204 either way. */
  app.post("/api/portal/cancel", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    runtime.cancel();
    return reply.code(204).send();
  });

  /** `GET /api/portal/items` — every item, in every status `{ items }`. */
  app.get("/api/portal/items", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    return { items: await runtime.listItems() };
  });

  /** `PATCH /api/portal/items/:id` — body `ItemPatch` (status, snoozedUntil, list, …) -> `{ item }`; 400 for a body that is not one. */
  app.patch<IdParams>("/api/portal/items/:id", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    const body = readObject(req.body);
    if (!body) return notAnObject(reply);
    return { item: await runtime.updateItem(req.params.id, parseItemPatch(body)) };
  });

  /**
   * `POST /api/portal/items/:id/actions/:index` — performs the item's action server-side (start a
   * session, send a prompt, remove a worktree) -> `{ sessionId? }`. `open_*` actions belong to the
   * browser and are rejected by the runtime.
   */
  app.post<{ Params: { id: string; index: string } }>("/api/portal/items/:id/actions/:index", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    const actionIndex = parseIndex(req.params.index);
    if (actionIndex === null) return reply.code(400).send({ error: "Expected a numeric action index." });
    return runtime.performAction(req.params.id, actionIndex);
  });

  /**
   * `GET /api/portal/stream` — Server-Sent Events feed of the orchestrator: opens with `status`,
   * `items`, `threads`, `approvals`, and `intents`, then forwards every runtime event as
   * it happens (see `OrchestratorEvent`). Holding it open counts the browser as present, which picks
   * the shorter cadence of jobs that have an idle one.
   */
  app.get("/api/portal/stream", async (req, reply) => {
    const runtime = await runtimeFor(req, reply);
    if (!runtime) return reply;
    // Read before the reply is hijacked, so a failure still answers `{ error }` with its status.
    const [status, items, threads, approvals, intents] = await Promise.all([
      runtime.status(), runtime.listItems(), runtime.listThreads(), runtime.hub.approvals.pending(),
      runtime.hub.jobs.listIntents({ status: ["active"] }),
    ]);
    const opening: OrchestratorEvent[] = [
      { type: "status", status }, { type: "items", items }, { type: "threads", threads },
      { type: "approvals", approvals }, { type: "intents", intents },
    ];
    const stream = openEventStream(req, reply);
    if (stream.closed) return reply;
    const leave = ctx.presence.open();
    for (const event of opening) stream.send(event);
    const unsubscribe = runtime.subscribe((event) => stream.send(event));
    stream.onClose(() => {
      unsubscribe();
      leave();
    });
    return reply;
  });

  registerJobRoutes(app, ctx);
  registerWorldRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
}
