/**
 * What every tool file receives and the conventions they share: outputs are compact objects with
 * short ids and capped lists, and a failure is returned as `{ error }` rather than thrown, so one
 * bad call never ends the model's turn.
 */
import type { FlexibleSchema, Tool } from "ai";
import type { OrchestratorDeps, OrchestratorSettingsStore } from "../deps.ts";
import type { OrchestratorStore } from "../types.ts";
import { orchestratorProviders } from "../types.ts";

export type ToolContext = {
  store: OrchestratorStore;
  settings: Pick<OrchestratorSettingsStore, "read" | "orchestrator" | "apiKey" | "serverSecrets">;
  deps: OrchestratorDeps;
  /** Ids of items created or updated during this turn; the runtime attaches them to the assistant message. */
  touched: Set<string>;
  /** A chat turn (every tool) rather than a background turn (the item and read-only session/PR tools, unless it names its own). */
  interactive: boolean;
  now(): number;
};

/** Rows returned by a list tool unless the caller asks for more. */
export const DEFAULT_LIMIT = 25;

export type ToolFailure = { error: string };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `rows` cut to `limit`, flagged when something was left out. */
export function capped<T>(rows: T[], limit = DEFAULT_LIMIT): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** What the SDK hands a tool's `execute` beside its input (the call id, the abort signal of the turn). */
export type ToolCallOptions = Parameters<NonNullable<Tool["execute"]>>[1];

/**
 * A tool whose `run` may throw: the error becomes the tool's output. `inputSchema` is a zod object
 * schema; `run` also gets the SDK's call options, whose `abortSignal` ends with the turn. The cast
 * stands in for `tool()`: its overloads hinge on conditional types over the output that TypeScript
 * cannot resolve for a generic `O`, while the shape here is exactly a function tool.
 *
 * `strict: false` is deliberate. OpenAI treats a function tool without the flag as strict, and a
 * strict schema makes every property required: the model then invents values for optional
 * parameters (seen live: a PR number passed beside a branch name, on every retry).
 */
export function define<I, O>(description: string, inputSchema: FlexibleSchema<I>, run: (input: I, options?: ToolCallOptions) => Promise<O>): Tool<I, O | ToolFailure> {
  const execute = async (input: I, options?: ToolCallOptions): Promise<O | ToolFailure> => {
    try {
      return await run(input, options);
    } catch (err) {
      return { error: errorMessage(err) };
    }
  };
  return { description, inputSchema, execute, strict: false } as unknown as Tool<I, O | ToolFailure>;
}

export const REDACTED = "[redacted]";

/** `output` with every stored API key replaced, wherever it sits: a file read or a command's output must not carry it into the thread. */
export function redactKeys(output: unknown, keys: string[]): unknown {
  const secrets = keys.filter((key) => key.length > 0);
  if (secrets.length === 0 || output === undefined) return output;
  const text = JSON.stringify(output);
  if (typeof text !== "string" || !secrets.some((key) => text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1)))) return output;
  let redacted = text;
  for (const key of secrets) {
    redacted = redacted.replaceAll(key, REDACTED);
    redacted = redacted.replaceAll(JSON.stringify(key).slice(1, -1), REDACTED);
  }
  try {
    return JSON.parse(redacted);
  } catch {
    return REDACTED;
  }
}

/**
 * Every tool of `tools` with its output passed through `redactKeys` against the keys stored for
 * all providers and the server key: a read-only command such as `grep -r ~` must not carry either
 * into the thread.
 */
export function withRedaction<T extends Record<string, Tool>>(ctx: Pick<ToolContext, "settings">, tools: T): T {
  const keys = () => Promise.all([
    ...orchestratorProviders.map((provider) => ctx.settings.apiKey(provider).catch(() => null)),
    ctx.settings.serverSecrets ? ctx.settings.serverSecrets().catch(() => []) : [],
  ]).then((found) => found.flat().filter((key): key is string => typeof key === "string" && key.length > 0));
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (!execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input, options) => redactKeys(await execute(input, options), await keys()),
    } as Tool;
  }
  return wrapped as T;
}
