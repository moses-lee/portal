/**
 * Helpers: bounded sub-turns the agent starts for a side task (research, summarizing, curation).
 * A chat turn may run one inline and wait for its text (a child run of the chat turn's run);
 * anything else becomes a `helper` job that runs now, or on a schedule, and posts its final text to
 * its thread. Helpers nest at most two levels below the turn that started the chain.
 */
import type { HelperPayload, Job, JobSchedule } from "@portal/contracts/jobs";
import type { DomainToolContext } from "../hub.ts";
import { httpError } from "../ops.ts";
import { generateTurn, prepareTurn } from "../turn.ts";
import { MAIN_THREAD_ID } from "../types.ts";
import type { JobsCore } from "./core.ts";
import type { KindContext, KindResult } from "./kinds.ts";
import { helperPrompt } from "./prompt.ts";
import { nextRunAt } from "./schedule.ts";

/** What a helper may use unless the agent names its tools: looking, never changing anything. */
export const HELPER_TOOLS = [
  "list_projects", "get_project", "search_projects", "list_sessions", "list_active_sessions", "get_session", "search_sessions", "read_transcript",
  "list_attention_pulls", "list_pulls", "get_pull", "get_github_status", "list_branches", "list_items", "read_file",
  "get_world", "resolve_pull", "resolve_repo", "resolve_session", "search_memory", "explain_memory",
] as const;

export const DEFAULT_HELPER_STEPS = 12;
export const MAX_HELPER_STEPS = 24;
/** Levels of helpers below the turn that started the chain. */
export const MAX_HELPER_DEPTH = 2;
/** Characters of a helper's answer handed back to the turn that waited for it. */
export const MAX_HELPER_TEXT = 6000;

export type HelperRequest = Pick<HelperPayload, "prompt" | "role" | "tools" | "maxSteps" | "report">;

const clampSteps = (steps: number | undefined) => Math.max(1, Math.min(MAX_HELPER_STEPS, Math.round(steps ?? DEFAULT_HELPER_STEPS)));
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function helperTitle(prompt: string): string {
  return `Helper: ${cut(prompt.trim().replace(/\s+/g, " "), 80)}`;
}

export function createHelpers(core: JobsCore) {
  const { hub, runs } = core;
  /** Inline helpers in flight, by run id, so a run can be cancelled. */
  const inline = new Map<string, AbortController>();

  /** The depth a new helper started from `ctx`'s turn would have; refuses past the limit. */
  async function childDepth(parentRunId: string): Promise<number> {
    const depth = (await runs.depth(parentRunId)) + 1;
    if (depth > MAX_HELPER_DEPTH) throw httpError(`Helpers nest at most ${MAX_HELPER_DEPTH} levels deep; do this step yourself.`, 409);
    return depth;
  }

  /** Run a helper inside a chat turn and answer its text. */
  async function runInline(ctx: DomainToolContext, request: HelperRequest): Promise<{ runId: string | null; text: string }> {
    await childDepth(ctx.turn.runId);
    const prepared = await prepareTurn(hub, {
      kind: "helper", role: request.role ?? "chat", trigger: "agent", threadId: ctx.turn.threadId, parentRunId: ctx.turn.runId,
      interactive: false, toolNames: request.tools ?? HELPER_TOOLS, scope: ctx.turn.scope, query: request.prompt, touched: ctx.touched,
      self: ctx.self, summary: helperTitle(request.prompt),
    });
    if (!prepared) throw httpError("No API key is stored for the helper's model.", 409);
    const controller = new AbortController();
    inline.set(prepared.run.id, controller);
    try {
      const result = await generateTurn(prepared, {
        prompt: helperPrompt(request), signal: controller.signal, maxSteps: clampSteps(request.maxSteps), summarize: (text) => cut(text, 200) || null,
      });
      return { runId: prepared.run.id, text: cut(result.text, MAX_HELPER_TEXT) };
    } finally {
      inline.delete(prepared.run.id);
    }
  }

  /**
   * Make a helper job; it runs at `schedule` (now when omitted). `chain` makes it a child of the
   * turn that asked (run_helper): it counts toward the nesting limit and its run links back.
   */
  async function schedule(request: HelperRequest & { title?: string; threadId?: string | null; schedule?: JobSchedule }, { ctx, chain = false }: {
    ctx: DomainToolContext | null;
    chain?: boolean;
  }): Promise<Job> {
    const parentRunId = chain && ctx ? ctx.turn.runId : null;
    const depth = parentRunId ? await childDepth(parentRunId) : 0;
    const now = hub.timers.now();
    const plan: JobSchedule = request.schedule ?? { type: "at", at: now };
    const payload: HelperPayload & { parentRunId?: string; depth?: number } = {
      prompt: request.prompt, ...(request.role ? { role: request.role } : {}), ...(request.tools ? { tools: request.tools } : {}),
      ...(request.maxSteps ? { maxSteps: clampSteps(request.maxSteps) } : {}), ...(request.report === false ? { report: false } : {}),
      ...(parentRunId ? { parentRunId, depth } : {}),
    };
    const actor = ctx ? "agent" : "user";
    return core.scheduleJob({
      kind: "helper", title: request.title?.trim() || helperTitle(request.prompt), schedule: plan, payload,
      threadId: request.threadId ?? ctx?.turn.threadId ?? null, createdBy: actor,
      nextRunAt: nextRunAt(plan, { now, lastRunAt: null, present: core.present() }),
    }, actor, { runId: ctx?.turn.runId });
  }

  /** A helper job firing: its turn, and its answer posted to the job's thread. */
  async function run({ job, run: jobRun, trigger, signal }: KindContext): Promise<KindResult> {
    const payload = job.payload as Partial<HelperPayload>;
    if (typeof payload.prompt !== "string" || !payload.prompt.trim()) return { status: "failed", error: "The helper job has no prompt.", jobStatus: "done" };
    const touched = new Set<string>();
    const threadId = job.threadId ?? MAIN_THREAD_ID;
    const prepared = await prepareTurn(hub, {
      kind: "helper", role: payload.role === "bookkeeping" ? "bookkeeping" : "chat", trigger, threadId, jobId: job.id, parentRunId: jobRun.parentRunId,
      interactive: false, toolNames: Array.isArray(payload.tools) ? payload.tools : HELPER_TOOLS, query: payload.prompt, touched, self: core.self(),
      summary: job.title,
    });
    if (!prepared) return { status: "failed", skipped: true, error: "not ready", summary: "No API key is stored; the helper did not run." };
    const result = await generateTurn(prepared, { prompt: helperPrompt({ prompt: payload.prompt }), signal, maxSteps: clampSteps(payload.maxSteps) });
    const text = result.text.trim();
    if (payload.report !== false && text) await core.postToThread(threadId, text, jobRun, [...touched]);
    if (touched.size > 0) hub.emit({ type: "items", items: await hub.store.listItems() });
    return { summary: text ? cut(text, 200) : "The helper finished without an answer.", result: { text: cut(text, MAX_HELPER_TEXT) } };
  }

  return {
    runInline,
    schedule,
    run,
    /** Stop an inline helper; false when `runId` is not one. */
    cancel(runId: string): boolean {
      const controller = inline.get(runId);
      controller?.abort();
      return !!controller;
    },
    abortAll() {
      for (const controller of inline.values()) controller.abort();
    },
  };
}
