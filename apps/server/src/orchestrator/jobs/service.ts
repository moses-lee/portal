/**
 * Jobs, runs, and intents. STUB (phase 2 step 1): runs are kept in memory so chat turns and ticks
 * can be recorded; there is no job table, worker, or intent yet. Replaced in step 2 by the Postgres
 * jobs store, the worker loop, the tick job, intents, and the job tools.
 */
import { randomUUID } from "node:crypto";
import type { JobRun } from "@portal/contracts/jobs";
import type { JobsService, OrchestratorHub } from "../hub.ts";

export type JobsOptions = Record<string, never>;

export function createJobsService(hub: OrchestratorHub, _options: JobsOptions = {}): JobsService {
  const runs = new Map<string, JobRun>();
  return {
    ready: Promise.resolve(),
    start() {},
    async dispose() {},
    async startRun(input) {
      const run: JobRun = {
        id: randomUUID(), jobId: input.jobId ?? null, kind: input.kind, threadId: input.threadId ?? null, parentRunId: input.parentRunId ?? null,
        status: "running", trigger: input.trigger, startedAt: hub.timers.now(), finishedAt: null, model: input.model ?? null, usage: null,
        log: [], result: null, summary: input.summary ?? null, error: null,
      };
      runs.set(run.id, run);
      hub.emit({ type: "run", run });
      return run;
    },
    async finishRun(id, outcome) {
      const current = runs.get(id);
      if (!current) throw new Error(`Unknown run "${id}".`);
      const run: JobRun = {
        ...current, status: outcome.status, finishedAt: hub.timers.now(), model: outcome.model ?? current.model, usage: outcome.usage ?? current.usage,
        log: outcome.log ?? current.log, result: outcome.result ?? current.result, summary: outcome.summary ?? current.summary, error: outcome.error ?? null,
      };
      runs.delete(id);
      hub.emit({ type: "run", run });
      return run;
    },
    running: () => [...runs.values()].sort((a, b) => a.startedAt - b.startedAt),
    nextDue: async () => null,
    runNow: async () => null,
    listIntents: async () => [],
    tools: () => ({}),
  };
}
