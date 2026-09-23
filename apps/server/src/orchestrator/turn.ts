/**
 * One model turn, however it started: a chat turn in a thread, a tick, a helper sub-turn, an intent
 * check. `prepareTurn` does what every turn needs: resolve the role's model, record a run, compose
 * the system prompt (base prompt, CORE.md, the rendered world, memory retrieved for the turn's
 * scope), and build the tools (the classic set plus each domain's, redacted, gated by approvals,
 * and logged to the activity log call by call). `generateTurn` runs a prepared turn to the end
 * without streaming, for background work.
 */
import type { JobRun, RunKind, RunTrigger, RunUsage } from "@portal/contracts/jobs";
import type { LanguageModelUsage, Tool } from "ai";
import { CALL_TIMEOUT_MS, createOrchestratorAgent } from "./agent.ts";
import type { DomainToolContext, OrchestratorHub, ResolvedModel, RunOutcome, ToolSet, TurnInfo } from "./hub.ts";
import { systemPrompt } from "./prompt.ts";
import { normalizeScope } from "./store.ts";
import { type ToolContext, createTools } from "./tools/index.ts";
import { withRedaction } from "./tools/context.ts";
import { threadTools } from "./tools/threads.ts";
import type { ModelRole, Scope } from "./types.ts";
import type { WorldState } from "@portal/contracts/world";

export type TurnOptions = {
  kind: RunKind;
  role: ModelRole;
  trigger: RunTrigger;
  threadId: string | null;
  jobId?: string | null;
  intentId?: string | null;
  parentRunId?: string | null;
  /** The whole classic tool set (a chat turn) or the tick subset (background bookkeeping). */
  interactive: boolean;
  /** When given, only these tools (classic and domain) are offered. */
  toolNames?: readonly string[];
  /** What the turn is about; defaults to the thread's scope. */
  scope?: Scope;
  /** The text memory retrieval searches with (the user's message, the helper's instruction). */
  query: string;
  /** Ids of items the turn's tools created or updated. */
  touched: Set<string>;
  self: ToolContext["self"];
  /** A line for the status bar while the run is going. */
  summary?: string;
};

export type PreparedTurn = {
  run: JobRun;
  turn: TurnInfo;
  model: ResolvedModel;
  tools: ToolSet;
  system: string;
  /** Record the run's end; safe to call once. */
  finish(outcome: RunOutcome): Promise<JobRun | null>;
};

/** Longest tool input kept in an activity entry, as JSON. */
const MAX_LOGGED_INPUT = 2000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The AI SDK's usage as a run records it. */
export function runUsage(usage: LanguageModelUsage | undefined): RunUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.inputTokenDetails?.cacheReadTokens ? { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens } : {}),
    ...(usage.outputTokenDetails?.reasoningTokens ? { reasoningTokens: usage.outputTokenDetails.reasoningTokens } : {}),
  };
}

function loggedInput(input: unknown): unknown {
  try {
    const text = JSON.stringify(input);
    return text && text.length > MAX_LOGGED_INPUT ? `${text.slice(0, MAX_LOGGED_INPUT)}…` : input;
  } catch {
    return null;
  }
}

/**
 * `scope` plus what the world knows is behind it: a session's project, and the repo of every
 * project and pull request named. Only additions; nothing named is dropped.
 */
export function widenScope(scope: Scope, world: WorldState): Scope {
  const projects = new Set(scope.projectIds);
  for (const id of scope.sessionIds) {
    const session = world.sessions.find((entry) => entry.id === id);
    if (session?.projectId) projects.add(session.projectId);
  }
  const repos = new Set(scope.repos);
  for (const id of projects) {
    const repo = world.projects.find((project) => project.id === id)?.repo;
    if (repo) repos.add(repo);
  }
  for (const pull of scope.pulls) repos.add(pull.repo);
  return normalizeScope({ ...scope, projectIds: [...projects], repos: [...repos] });
}

/** Every tool with an activity entry per call: which tool, its input, and whether it failed. */
function withActivity(hub: OrchestratorHub, turn: TurnInfo, tools: ToolSet): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (!execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options: Parameters<NonNullable<Tool["execute"]>>[1]) => {
        const output = await execute(input, options);
        const failed = !!output && typeof output === "object" && "error" in output && typeof (output as { error: unknown }).error === "string";
        void hub.activity.log({
          actor: "agent", kind: "tool.call", summary: failed ? `${name} failed: ${(output as { error: string }).error}` : `Called ${name}`,
          refs: { runId: turn.runId, ...(turn.threadId ? { threadId: turn.threadId } : {}), ...(turn.jobId ? { jobId: turn.jobId } : {}), ...(turn.intentId ? { intentId: turn.intentId } : {}) },
          detail: { tool: name, input: loggedInput(input), ...(failed ? { error: (output as { error: string }).error } : {}) },
        });
        return output;
      },
    } as Tool;
  }
  return wrapped;
}

/** The turn's tools: classic plus domain, redacted, cut to `toolNames`, gated, and logged. */
function turnTools(hub: OrchestratorHub, ctx: DomainToolContext, toolNames: readonly string[] | undefined): ToolSet {
  // An explicit list decides on its own; otherwise each tool family offers what suits the turn
  // (a background turn gets the tick subset of the classic tools and the domains' background tools).
  const offered: DomainToolContext = toolNames ? { ...ctx, interactive: true } : ctx;
  const domain: ToolSet = { ...threadTools(offered), ...hub.jobs.tools(offered), ...hub.world.tools(offered), ...hub.memory.tools(offered) };
  const classic = createTools(offered) as unknown as ToolSet;
  let tools: ToolSet = { ...classic, ...withRedaction(ctx, domain) };
  if (toolNames) {
    const allowed = new Set(toolNames);
    tools = Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name)));
  }
  return withActivity(hub, ctx.turn, hub.approvals.gate(tools, ctx));
}

/**
 * Everything a turn needs, with its run recorded as started. Null when the role's provider has no
 * key (nothing is recorded then).
 */
export async function prepareTurn(hub: OrchestratorHub, options: TurnOptions): Promise<PreparedTurn | null> {
  const model = await hub.model(options.role);
  if (!model) return null;
  const thread = options.threadId ? await hub.store.getThread(options.threadId) : null;
  const scope = normalizeScope(options.scope ?? thread?.scope);
  const run = await hub.jobs.startRun({
    kind: options.kind, trigger: options.trigger, jobId: options.jobId ?? null, threadId: options.threadId, parentRunId: options.parentRunId ?? null,
    model: model.choice, summary: options.summary ?? null,
  });
  let finished = false;
  const finish = async (outcome: RunOutcome) => {
    if (finished) return null;
    finished = true;
    return hub.jobs.finishRun(run.id, { model: model.choice, ...outcome }).catch((err: unknown) => {
      console.error("Could not record the end of a run:", err);
      return null;
    });
  };
  try {
    const turn: TurnInfo = {
      runId: run.id, kind: options.kind, role: options.role, origin: options.interactive ? "chat" : "job",
      threadId: options.threadId, jobId: options.jobId ?? null, intentId: options.intentId ?? null, scope,
    };
    const ctx: DomainToolContext = {
      store: hub.store, settings: hub.settings, deps: hub.deps, touched: options.touched, interactive: options.interactive,
      now: () => hub.timers.now(), self: options.self, hub, turn,
    };
    const [login, world] = await Promise.all([hub.deps.github.login().catch(() => null), hub.world.current().catch(() => null)]);
    // Memory is kept per repo as much as per project or session, so retrieval gets the repos behind them too.
    const memory = await hub.memory.promptContext({ scope: world ? widenScope(scope, world) : scope, query: options.query, threadId: options.threadId });
    const system = systemPrompt({
      login, now: hub.timers.now(), memory: memory.core.text, retrieved: memory.retrieved,
      world: world ? hub.world.render(world, { scope }) : "",
      thread: thread && thread.kind === "side" ? { title: thread.title } : null,
    });
    return { run, turn, model, tools: turnTools(hub, ctx, options.toolNames), system, finish };
  } catch (err) {
    await finish({ status: "failed", error: errorMessage(err) });
    throw err;
  }
}

/** `capped`: the loop stopped at its step cap while the model still wanted to call tools. */
export type GeneratedTurn = { run: JobRun | null; text: string; usage: RunUsage | null; steps: number; capped: boolean };

/**
 * Run a prepared turn to the end on `prompt` and record its outcome. Failures are recorded and
 * rethrown; the caller decides what they mean for its job.
 */
export async function generateTurn(prepared: PreparedTurn, { prompt, signal, maxSteps, summarize }: {
  prompt: string;
  signal?: AbortSignal;
  maxSteps?: number;
  /** The run's summary from the model's final text. */
  summarize?: (text: string) => string | null;
}): Promise<GeneratedTurn> {
  const agent = createOrchestratorAgent({
    model: prepared.model.model, tools: prepared.tools, system: prepared.system, providerOptions: prepared.model.providerOptions, maxSteps,
  });
  try {
    const result = await agent.generate({ prompt, abortSignal: signal, timeout: CALL_TIMEOUT_MS });
    const usage = runUsage(result.totalUsage ?? result.usage);
    const text = result.text.trim();
    const run = await prepared.finish({ status: "succeeded", usage, summary: summarize ? summarize(text) : null });
    return { run, text, usage, steps: result.steps.length, capped: result.finishReason === "tool-calls" };
  } catch (err) {
    await prepared.finish({ status: signal?.aborted ? "cancelled" : "failed", error: errorMessage(err) });
    throw err;
  }
}
