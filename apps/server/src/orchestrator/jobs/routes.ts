/**
 * `/api/portal/jobs/**`, `/api/portal/runs/**`, `/api/portal/intents/**`: the Upcoming view (jobs
 * by next run, run now, pause, reschedule), the run history, and intents (the UI may cancel or
 * re-activate one). Every route is same-origin checked first; errors carry their HTTP status.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IntentStatus, JobStatus, RunKind, RunTrigger } from "@portal/contracts/jobs";
import type { AppContext } from "../../context.ts";
import { rejectCrossOrigin } from "../../http/origin.ts";
import { intentStatuses, jobStatuses, runKinds } from "./store.ts";

type IdParams = { Params: { id: string } };
type Query = { Querystring: Record<string, string | undefined> };

const notAnObject = (reply: FastifyReply) => reply.code(400).send({ error: "Expected a JSON object body." });

function readObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** A comma-separated query value reduced to the allowed values; undefined when absent, a 400 message when not allowed. */
function listQuery<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T[] | undefined | { error: string } {
  if (!value) return undefined;
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  const bad = values.find((part) => !allowed.includes(part as T));
  if (bad) return { error: `Unknown ${what} "${bad}"; expected ${allowed.join(", ")}.` };
  return values as T[];
}

const isError = (value: unknown): value is { error: string } => !!value && typeof value === "object" && !Array.isArray(value) && "error" in value;

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function jobsFor(req: FastifyRequest, reply: FastifyReply) {
    if (rejectCrossOrigin(req, reply)) return null;
    await ctx.orchestrator.ready;
    return ctx.orchestrator.hub.jobs;
  }

  /** `GET /api/portal/jobs?status=<s>[,<s>]` — `{ jobs }` by next run (unscheduled last). */
  app.get<Query>("/api/portal/jobs", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const status = listQuery<JobStatus>(req.query?.status, jobStatuses, "job status");
    if (isError(status)) return reply.code(400).send(status);
    return { jobs: await jobs.listJobs(status ? { status } : {}) };
  });

  /** `PATCH /api/portal/jobs/:id` — body `JobPatch` (status active/paused/cancelled, schedule, title) -> `{ job }`. */
  app.patch<IdParams>("/api/portal/jobs/:id", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const body = readObject(req.body);
    if (!body) return notAnObject(reply);
    return { job: await jobs.updateJob(req.params.id, body, "user") };
  });

  /** `POST /api/portal/jobs/:id/run` — runs the job now (its schedule is unchanged) -> `{ run }`; 404 when it is not an active job. */
  app.post<IdParams>("/api/portal/jobs/:id/run", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const trigger: RunTrigger = "manual";
    const run = await jobs.runNow(req.params.id, trigger);
    if (!run) return reply.code(404).send({ error: `No active job "${req.params.id}".` });
    return { run };
  });

  /** `GET /api/portal/runs?jobId=&threadId=&kind=&before=&limit=` — `{ runs }`, newest first. */
  app.get<Query>("/api/portal/runs", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const query = req.query ?? {};
    const kind = listQuery<RunKind>(query.kind, runKinds, "run kind");
    if (isError(kind)) return reply.code(400).send(kind);
    if (kind && kind.length > 1) return reply.code(400).send({ error: "Give one run kind." });
    const limit = query.limit && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined;
    return {
      runs: await jobs.listRuns({
        ...(query.jobId ? { jobId: query.jobId } : {}), ...(query.threadId ? { threadId: query.threadId } : {}), ...(kind ? { kind: kind[0] } : {}),
        ...(query.before ? { before: query.before } : {}), ...(limit !== undefined ? { limit } : {}),
      }),
    };
  });

  /** `GET /api/portal/runs/:id` — `{ run }`; 404 for an unknown run. */
  app.get<IdParams>("/api/portal/runs/:id", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const run = await jobs.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: `Unknown run "${req.params.id}".` });
    return { run };
  });

  /** `POST /api/portal/runs/:id/cancel` — stops a running job run or helper -> 204 (also when it already ended); 404 unknown. */
  app.post<IdParams>("/api/portal/runs/:id/cancel", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    await jobs.cancelRun(req.params.id);
    return reply.code(204).send();
  });

  /** `GET /api/portal/intents?status=<s>[,<s>]` — `{ intents }`, newest first. */
  app.get<Query>("/api/portal/intents", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const status = listQuery<IntentStatus>(req.query?.status, intentStatuses, "intent status");
    if (isError(status)) return reply.code(400).send(status);
    return { intents: await jobs.listIntents(status ? { status } : {}) };
  });

  /** `PATCH /api/portal/intents/:id` — body `IntentPatch` ({ status: "cancelled" | "active" }) -> `{ intent }`. */
  app.patch<IdParams>("/api/portal/intents/:id", async (req, reply) => {
    const jobs = await jobsFor(req, reply);
    if (!jobs) return reply;
    const body = readObject(req.body);
    if (!body) return notAnObject(reply);
    if (body.status !== undefined && body.status !== "cancelled" && body.status !== "active") {
      return reply.code(400).send({ error: 'intent patch: "status" must be active or cancelled.' });
    }
    return { intent: await jobs.updateIntent(req.params.id, body.status === undefined ? {} : { status: body.status }, "user") };
  });
}
