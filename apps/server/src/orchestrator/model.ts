/**
 * Turns the orchestrator settings into an AI SDK language model. The key comes from the settings
 * store at call time and goes straight into the provider; it is never kept here.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { JSONValue, LanguageModel } from "ai";
import type { OrchestratorProvider, OrchestratorSettings } from "./types.ts";

/** Provider-specific call options, keyed by provider (the AI SDK's `providerOptions`). */
export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export function buildLanguageModel(settings: OrchestratorSettings, apiKey: string): LanguageModel {
  if (settings.provider === "anthropic") return createAnthropic({ apiKey })(settings.model);
  // The provider's default is the Responses API, which is what reasoning models need for tool use.
  return createOpenAI({ apiKey })(settings.model);
}

/**
 * Provider options for a lightweight assistant: OpenAI reasoning models run at low effort (the
 * provider drops the option with a warning on models without reasoning).
 *
 * `store: false` matters for history. With server-side storage the Responses API replays earlier
 * assistant messages as references to stored items, and a message item must travel with the
 * reasoning item it came from; Portal prunes reasoning from older turns, so the second turn of a
 * conversation failed with "provided without its required 'reasoning' item". Unstored, the SDK
 * sends plain content and the thread on disk stays the only copy.
 */
export function providerOptionsFor(provider: OrchestratorProvider): ProviderOptions | undefined {
  return provider === "openai" ? { openai: { reasoningEffort: "low", store: false } } : undefined;
}
