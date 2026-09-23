/**
 * `/api/portal/memory/**`: the memory browser's surface (entities, records, the inbox, revisions,
 * CORE.md), exactly as the header of `@portal/contracts/memory` lists it. Every route is
 * same-origin checked first. What the user adds or edits here is user-stated; an edit of a body
 * supersedes the record. A key already held by an active record answers 409 with `existing`.
 * `POST /api/portal/memory/consolidate` runs the curation job now and answers its run.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MemoryRecordInput, MemoryRecordPatch, RecordStatus, RecordType } from "@portal/contracts/memory";
import { recordTypes } from "@portal/contracts/memory";
import type { AppContext } from "../../context.ts";
import { rejectCrossOrigin } from "../../http/origin.ts";
import { CONSOLIDATE_JOB_ID } from "../jobs/consolidate-job.ts";
import type { CuratedMemoryService } from "./service.ts";
import { MemoryConflictError } from "./store.ts";

type IdParams = { Params: { id: string } };

const statuses = new Set<RecordStatus>(["active", "proposed", "superseded", "expired", "archived", "rejected"]);

function readObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const queryString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const queryInt = (value: unknown) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined);

/** A body's `reason`, when it has one. */
function reasonOf(body: unknown): string | null {
  const reason = readObject(body)?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null;
}

function parsePatch(body: Record<string, unknown>): MemoryRecordPatch | string {
  const patch: MemoryRecordPatch = {};
  if (body.body !== undefined) {
    if (typeof body.body !== "string") return "body must be a string.";
    patch.body = body.body;
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") return "pinned must be a boolean.";
    patch.pinned = body.pinned;
  }
  if (body.reviewBy !== undefined) {
    if (body.reviewBy !== null && !Number.isSafeInteger(body.reviewBy)) return "reviewBy must be epoch milliseconds or null.";
    patch.reviewBy = body.reviewBy as number | null;
  }
  if (body.type !== undefined) {
    if (!recordTypes.includes(body.type as RecordType)) return `type must be one of ${recordTypes.join(", ")}.`;
    patch.type = body.type as RecordType;
  }
  if (body.status !== undefined) {
    if (body.status !== "archived") return 'status can only be set to "archived".';
    patch.status = "archived";
  }
  return patch;
}

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Same-origin check, then the memory service; null when the request was already answered. */
  async function memoryFor(req: FastifyRequest, reply: FastifyReply): Promise<CuratedMemoryService | null> {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    const memory = ctx.orchestrator.hub.memory as Partial<CuratedMemoryService>;
    if (typeof memory.remember !== "function") {
      void reply.code(503).send({ error: "Curated memory is not available." });
      return null;
    }
    await memory.ready;
    return memory as CuratedMemoryService;
  }

  /** Runs a change; a taken key answers 409 with the record that holds it. */
  async function conflictAware<T>(reply: FastifyReply, run: () => Promise<T>) {
    try {
      return await run();
    } catch (err) {
      if (err instanceof MemoryConflictError) return reply.code(409).send({ error: err.message, existing: err.existing });
      throw err;
    }
  }

  const user = { actor: "user" as const };

  app.get("/api/portal/memory/entities", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    return { entities: await memory.store.listEntities() };
  });

  app.get<IdParams>("/api/portal/memory/entities/:id", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    const entity = await memory.store.getEntity(req.params.id);
    if (!entity) return reply.code(404).send({ error: `Unknown memory entity "${req.params.id}".` });
    return { entity, records: await memory.store.listRecords({ entityIds: [entity.id], limit: 1000 }) };
  });

  /** `?status=` takes one status or a comma list; `q` searches full text (every term must match). */
  app.get<{ Querystring: Record<string, unknown> }>("/api/portal/memory/records", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    const status = queryString(req.query.status)?.split(",").map((value) => value.trim()) as RecordStatus[] | undefined;
    if (status?.some((value) => !statuses.has(value))) return reply.code(400).send({ error: `status must be among ${[...statuses].join(", ")}.` });
    const type = queryString(req.query.type) as RecordType | undefined;
    if (type && !recordTypes.includes(type)) return reply.code(400).send({ error: `type must be one of ${recordTypes.join(", ")}.` });
    const entityId = queryString(req.query.entityId);
    const q = queryString(req.query.q);
    const filter = { status, type, entityIds: entityId ? [entityId] : undefined, limit: queryInt(req.query.limit) };
    if (q) return { records: (await memory.store.searchRecords(q, { ...filter, mode: "all" })).map((hit) => hit.record) };
    return { records: await memory.store.listRecords(filter) };
  });

  app.post("/api/portal/memory/records", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    const body = readObject(req.body);
    if (!body) return reply.code(400).send({ error: "Expected a JSON object body." });
    const { source: _ignored, ...input } = body as unknown as MemoryRecordInput;
    return conflictAware(reply, async () => ({ record: (await memory.create({ ...input, source: { kind: "ui" } }, user)).record }));
  });

  app.patch<IdParams>("/api/portal/memory/records/:id", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    const body = readObject(req.body);
    if (!body) return reply.code(400).send({ error: "Expected a JSON object body." });
    const patch = parsePatch(body);
    if (typeof patch === "string") return reply.code(400).send({ error: patch });
    return conflictAware(reply, async () => ({ record: (await memory.edit(req.params.id, patch, user)).record }));
  });

  app.post<IdParams>("/api/portal/memory/records/:id/approve", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    return conflictAware(reply, async () => ({ record: (await memory.approve(req.params.id, user)).record }));
  });

  app.post<IdParams>("/api/portal/memory/records/:id/reject", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    return { record: await memory.reject(req.params.id, reasonOf(req.body), user) };
  });

  app.post<IdParams>("/api/portal/memory/records/:id/forget", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    return { record: await memory.forget(req.params.id, reasonOf(req.body), user) };
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/portal/memory/revisions", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    return {
      revisions: await memory.store.listRevisions({
        recordId: queryString(req.query.recordId), entityId: queryString(req.query.entityId), before: queryInt(req.query.before), limit: queryInt(req.query.limit),
      }),
    };
  });

  /** Curate now: the consolidate job's run as it starts (the run that is already going, when one is). */
  app.post("/api/portal/memory/consolidate", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    const run = await ctx.orchestrator.hub.jobs.runNow(CONSOLIDATE_JOB_ID, "manual");
    if (!run) return reply.code(409).send({ error: "Memory curation is paused; resume \"Curate memory\" under Goals first." });
    return { run };
  });

  app.get("/api/portal/memory/core", async (req, reply) => {
    const memory = await memoryFor(req, reply);
    if (!memory) return reply;
    return memory.core();
  });
}
