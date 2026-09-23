/**
 * Turns the orchestrator settings into an AI SDK language model. The key comes from the settings
 * store at call time and goes straight into the provider; it is never kept here.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { JSONValue, LanguageModel } from "ai";
import type { ModelChoice, ModelRole, OrchestratorProvider, OrchestratorSettings } from "./types.ts";

/** The provider and model a role uses: chat is the top-level pair, bookkeeping its own. */
export function roleChoice(settings: OrchestratorSettings, role: ModelRole): ModelChoice {
  return role === "chat" ? { provider: settings.provider, model: settings.model } : { ...settings.bookkeeping };
}

/** Provider-specific call options, keyed by provider (the AI SDK's `providerOptions`). */
export type ProviderOptions = Record<string, Record<string, JSONValue>>;

/** The model named by `settings.provider` and `settings.model` (a role's choice laid over the settings). */
export function buildLanguageModel(settings: OrchestratorSettings, apiKey: string): LanguageModel {
  if (settings.provider === "anthropic") return createAnthropic({ apiKey })(settings.model);
  // The provider's default is the Responses API, which is what reasoning models need for tool use.
  return createOpenAI({ apiKey })(settings.model);
}

/**
 * Provider options per provider. Anthropic turns on automatic prompt caching: the breakpoint moves
 * to the last cacheable block of each request, so every step of a tool loop (and the next turn in
 * the thread) reads the system prompt, the tools, and the history before it from the cache.
 *
 * OpenAI reasoning models run at low effort (the provider drops the option with a warning on
 * models without reasoning); OpenAI caches long prefixes on its own.
 *
 * `store: false` matters for history. With server-side storage the Responses API replays earlier
 * assistant messages as references to stored items, and a message item must travel with the
 * reasoning item it came from; Portal prunes reasoning from older turns, so the second turn of a
 * conversation failed with "provided without its required 'reasoning' item". Unstored, the SDK
 * sends plain content and the thread on disk stays the only copy.
 */
export function providerOptionsFor(provider: OrchestratorProvider): ProviderOptions {
  if (provider === "anthropic") return { anthropic: { cacheControl: { type: "ephemeral" } } };
  return { openai: { reasoningEffort: "low", store: false } };
}
