/** The tool loop shared by chat turns and background turns; one agent instance per turn, built over that turn's tools. */
import { type LanguageModel, NoSuchToolError, ToolLoopAgent, stepCountIs } from "ai";
import type { ToolLoader } from "./tools/groups.ts";
import type { ProviderOptions } from "./model.ts";
import type { ToolSet } from "./hub.ts";

/** Model calls per turn before the loop stops; enough for a review setup, too few to spin. */
export const MAX_STEPS = 24;
/** Wall-clock budget for one turn, passed as `timeout` on every call. */
export const CALL_TIMEOUT_MS = 5 * 60_000;

export type OrchestratorAgent = ToolLoopAgent<never, ToolSet>;

export function createOrchestratorAgent({ model, tools, system, providerOptions, maxSteps = MAX_STEPS, loader }: {
  model: LanguageModel;
  tools: ToolSet;
  system: string;
  providerOptions?: ProviderOptions;
  /** Model calls before the loop stops; helpers run with fewer. */
  maxSteps?: number;
  /** A chat turn's tool loader: it decides the tools offered on each step (asked before every step); all tools when omitted. */
  loader?: Pick<ToolLoader, "active" | "repair"> | null;
}): OrchestratorAgent {
  return new ToolLoopAgent({
    model, tools, instructions: system, stopWhen: stepCountIs(Math.min(maxSteps, MAX_STEPS)), providerOptions,
    ...(loader ? {
      prepareStep: () => ({ activeTools: loader.active() }),
      repairToolCall: async ({ toolCall, error }) => (NoSuchToolError.isInstance(error) ? loader.repair(toolCall) : null),
    } : {}),
  });
}
