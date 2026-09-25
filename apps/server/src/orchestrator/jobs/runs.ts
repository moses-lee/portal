/**
 * Run bookkeeping: every chat turn, job firing, and helper sub-turn is a row in `job_runs`, started
 * and finished here, announced as a `run` event, and (for background runs) written to the activity
 * log. `running()` answers from an in-process map so the status line never waits on Postgres. The
 * world refresh's runs (kind `tick`) are recorded like any other but announced nowhere: no `run`
 * event, no activity entry.
 *
 * A job's run is started by the worker before it knows whether a model will be called (a
 * deterministic check that finds nothing still counts). When the job then prepares a turn, `prepareTurn` asks for
 * a run of its own: inside `adopting()` that request is answered with the job's run instead, and
 * the turn's outcome (model, usage, summary) is kept for the worker to merge into the final record.
 * So one firing is one run, whatever the job did.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { JobRun } from "@portal/contracts/jobs";
import type { OrchestratorHub, RunOutcome, RunStart } from "../hub.ts";
import { newId } from "../store.ts";
import type { JobsStore } from "./store.ts";

type Adoption = { run: JobRun; adopted: boolean; outcome: RunOutcome | null };

export type Runs = ReturnType<typeof createRuns>;

export function createRuns(hub: OrchestratorHub, store: JobsStore) {
  const running = new Map<string, JobRun>();
  /** Runs whose turn outcome goes to the worker instead of the table, by id. */
  const adoptions = new Map<string, Adoption>();
  const context = new AsyncLocalStorage<Adoption>();

  /** `adopt: false` for a job's own run, which must never be mistaken for a turn inside another job. */
  async function start(input: RunStart, { adopt = true }: { adopt?: boolean } = {}): Promise<JobRun> {
    const slot = adopt ? context.getStore() : undefined;
    if (slot && !slot.adopted && slot.run.kind === input.kind) {
      slot.adopted = true;
      const current = running.get(slot.run.id) ?? slot.run;
      const run: JobRun = { ...current, model: input.model ?? current.model, summary: input.summary ?? current.summary };
      running.set(run.id, run);
      slot.run = run;
      return run;
    }
    const draft: JobRun = {
      id: newId(), jobId: input.jobId ?? null, kind: input.kind, threadId: input.threadId ?? null, parentRunId: input.parentRunId ?? null,
      status: "running", trigger: input.trigger, startedAt: hub.timers.now(), finishedAt: null, model: input.model ?? null, usage: null,
      log: [], result: null, summary: input.summary ?? null, error: null,
    };
    const run = await store.insertRun(draft);
    running.set(run.id, run);
    if (run.kind !== "tick") hub.emit({ type: "run", run });
    return run;
  }

  /** Persist a run's end. A background run that left an approval pending ends as `awaiting_approval`. */
  async function complete(id: string, outcome: RunOutcome): Promise<JobRun> {
    const current = running.get(id) ?? (await store.getRun(id));
    if (!current) throw new Error(`Unknown run "${id}".`);
    let status = outcome.status;
    if (status === "succeeded" && current.kind !== "chat") {
      const pending = await hub.approvals.hasPendingFor(id).catch(() => false);
      if (pending) status = "awaiting_approval";
    }
    const run: JobRun = {
      ...current, status, finishedAt: hub.timers.now(), model: outcome.model ?? current.model, usage: outcome.usage ?? current.usage,
      log: outcome.log ?? current.log, result: outcome.result ?? current.result, summary: outcome.summary ?? current.summary, error: outcome.error ?? null,
    };
    try {
      await store.updateRun(run);
    } finally {
      running.delete(id);
      if (run.kind !== "tick") hub.emit({ type: "run", run });
    }
    if (run.kind !== "chat" && run.kind !== "tick") {
      void hub.activity.log({
        actor: "system", kind: "run.finished",
        summary: `${run.kind === "intent_check" ? "Intent check" : run.kind === "helper" ? "Helper" : "Job"} ${run.status.replace("_", " ")}${run.summary ? `: ${run.summary}` : ""}`,
        refs: { runId: run.id, ...(run.jobId ? { jobId: run.jobId } : {}), ...(run.threadId ? { threadId: run.threadId } : {}) },
        detail: { status: run.status, trigger: run.trigger, ...(run.error ? { error: run.error } : {}), ...(run.usage ? { usage: run.usage } : {}) },
      });
    }
    return run;
  }

  async function finish(id: string, outcome: RunOutcome): Promise<JobRun> {
    const adoption = adoptions.get(id);
    if (adoption?.adopted) {
      adoption.outcome = { ...adoption.outcome, ...outcome };
      const current = running.get(id) ?? adoption.run;
      const run: JobRun = { ...current, model: outcome.model ?? current.model, usage: outcome.usage ?? current.usage, summary: outcome.summary ?? current.summary };
      running.set(id, run);
      return { ...run, status: outcome.status, error: outcome.error ?? null };
    }
    return complete(id, outcome);
  }

  /**
   * Run `fn` so that the first turn it prepares of the run's kind records into `run`. Resolves with
   * what `fn` answered (or the error it threw) and the turn's outcome, if a turn ran.
   */
  async function adopting<T>(run: JobRun, fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; turn: RunOutcome | null }> {
    const slot: Adoption = { run, adopted: false, outcome: null };
    adoptions.set(run.id, slot);
    try {
      const value = await context.run(slot, fn);
      return { value, turn: slot.outcome };
    } catch (error) {
      return { error, turn: slot.outcome };
    } finally {
      adoptions.delete(run.id);
    }
  }

  /** How many runs up the parent chain `runId` sits (a chat turn is 0, its helper 1, ...). */
  async function depth(runId: string | null): Promise<number> {
    let levels = 0;
    let id = runId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const run = running.get(id) ?? (await store.getRun(id));
      if (!run?.parentRunId) break;
      levels++;
      id = run.parentRunId;
    }
    return levels;
  }

  return {
    start,
    finish,
    complete,
    adopting,
    depth,
    /** A run in progress in this process. */
    get: (id: string) => running.get(id) ?? null,
    running: () => [...running.values()].sort((a, b) => a.startedAt - b.startedAt),
  };
}
