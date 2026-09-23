import { defaultModels, defaultOrchestratorSettings, orchestratorProviders } from "@portal/contracts/orchestrator";
import type { ConsolidationSettings, OrchestratorProvider, OrchestratorSettings, OrchestratorSettingsPatch } from "@portal/contracts/orchestrator";
import { defaultScripts, mergeScripts, scriptsOverrides } from "./scripts.ts";
import type { ScriptsPatch, ScriptsSettings } from "./scripts.ts";

/** The GitHub panel's one-click actions on a pull request; each sends a prompt to the agent. */
export type GitActionKind = "checks" | "conflicts" | "review";
export type GitActionPrompts = Record<GitActionKind, string>;

/**
 * Settings as served to the browser. `orchestrator.apiKeys` only says whether a key is stored;
 * the keys themselves stay in the settings store (see settings-store.ts).
 */
export type Settings = {
  version: 1;
  gitActions: { prompts: GitActionPrompts };
  orchestrator: OrchestratorSettings;
  /** User scripts run before certain actions; see scripts.ts. */
  scripts: ScriptsSettings;
};

/**
 * Partial overrides, as sent in PATCH (and, for everything but API keys, as stored on disk).
 * `orchestrator.apiKeys` carries the key text: an empty string clears the key.
 */
export type SettingsPatch = {
  gitActions?: { prompts?: Partial<Record<GitActionKind, string>> };
  orchestrator?: OrchestratorSettingsPatch;
  scripts?: ScriptsPatch;
};

export const gitActionKinds: readonly GitActionKind[] = ["checks", "conflicts", "review"];

/**
 * Size and range limits for orchestrator fields. The store enforces them on the server; the dialog
 * mirrors them so a bad value is caught before a request goes out.
 */
export const orchestratorLimits = {
  /** Longest model id, after trimming. */
  modelLength: 100,
  /** Longest API key, after trimming. */
  apiKeyLength: 512,
  /** Tick interval bounds in minutes: up to a day while a browser is open, up to a week while none is. */
  intervalMinutes: 1440,
  idleIntervalMinutes: 10080,
  /** Memory curation: an inbox of up to a thousand proposals, at most a day between inbox-started runs. */
  inboxThreshold: 1000,
  minIntervalMinutes: 1440,
} as const;

/** "HH:MM" on a 24-hour clock, as the nightly curation time is written. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && CLOCK_TIME.test(value);
}

export const defaultSettings: Settings = {
  version: 1,
  gitActions: {
    prompts: {
      checks: "Investigate the failing actions on this PR. Debug why they are failing. Do not fix it yet.",
      conflicts: "This branch has merge conflicts with base. Investigate why. Do not fix it yet.",
      review: "Pull the comments and review items on this PR. Summarize what they are and if they are legitimate.",
    },
  },
  orchestrator: defaultOrchestratorSettings,
  scripts: defaultScripts,
};

export function isOrchestratorProvider(value: unknown): value is OrchestratorProvider {
  return typeof value === "string" && (orchestratorProviders as readonly string[]).includes(value);
}

/** `base` consolidation settings with the well-formed fields of `given` laid on top (null turns a trigger off). */
function mergeConsolidation(base: ConsolidationSettings, given: Partial<ConsolidationSettings> | undefined): ConsolidationSettings {
  const next = { ...base };
  if (!given || typeof given !== "object") return next;
  if (given.nightlyAt === null || isClockTime(given.nightlyAt)) next.nightlyAt = given.nightlyAt;
  if (given.inboxThreshold === null || (Number.isInteger(given.inboxThreshold) && (given.inboxThreshold as number) > 0)) {
    next.inboxThreshold = given.inboxThreshold as number | null;
  }
  if (Number.isInteger(given.minIntervalMinutes) && (given.minIntervalMinutes as number) > 0) next.minIntervalMinutes = given.minIntervalMinutes as number;
  return next;
}

/** `base` prompts with `given` laid on top; empty or whitespace-only strings (and non-strings) leave the base value. */
function mergePrompts(base: GitActionPrompts, given: Partial<Record<GitActionKind, unknown>> | undefined): GitActionPrompts {
  const prompts = { ...base };
  if (given) {
    for (const kind of gitActionKinds) {
      const value = given[kind];
      if (typeof value === "string" && value.trim()) prompts[kind] = value;
    }
  }
  return prompts;
}

/**
 * `base` orchestrator settings with `given` laid on top. Unlike prompts, these fields have no
 * "blank means default": a value that is present and well-typed replaces the base one, anything
 * else leaves it. Key strings become the wire form's booleans (non-blank means "a key is stored").
 */
function mergeOrchestrator(base: OrchestratorSettings, given: OrchestratorSettingsPatch | undefined): OrchestratorSettings {
  const next: OrchestratorSettings = { ...base, bookkeeping: { ...base.bookkeeping }, consolidation: { ...base.consolidation }, apiKeys: { ...base.apiKeys } };
  if (!given) return next;
  // A provider change without a model takes that provider's default: a model id never outlives its provider.
  if (isOrchestratorProvider(given.provider) && given.provider !== base.provider) {
    next.provider = given.provider;
    next.model = defaultModels[given.provider].chat;
  }
  if (typeof given.model === "string" && given.model.trim()) next.model = given.model;
  if (given.bookkeeping && typeof given.bookkeeping === "object") {
    const { provider, model } = given.bookkeeping;
    if (isOrchestratorProvider(provider) && provider !== base.bookkeeping.provider) {
      next.bookkeeping = { provider, model: defaultModels[provider].bookkeeping };
    }
    if (typeof model === "string" && model.trim()) next.bookkeeping.model = model;
  }
  if (Number.isInteger(given.intervalMinutes) && (given.intervalMinutes as number) > 0) next.intervalMinutes = given.intervalMinutes as number;
  if (Number.isInteger(given.idleIntervalMinutes) && (given.idleIntervalMinutes as number) > 0) {
    next.idleIntervalMinutes = given.idleIntervalMinutes as number;
  }
  next.consolidation = mergeConsolidation(base.consolidation, given.consolidation);
  if (given.apiKeys) {
    for (const provider of orchestratorProviders) {
      const value = given.apiKeys[provider];
      if (typeof value === "string") next.apiKeys[provider] = value.trim().length > 0;
    }
  }
  return next;
}

/** Defaults with `overrides` applied; empty or whitespace-only prompt strings mean "use the default". */
export function mergeSettings(overrides: SettingsPatch | null | undefined): Settings {
  return {
    version: 1,
    gitActions: { prompts: mergePrompts(defaultSettings.gitActions.prompts, overrides?.gitActions?.prompts) },
    orchestrator: mergeOrchestrator(defaultSettings.orchestrator, overrides?.orchestrator),
    scripts: mergeScripts(defaultSettings.scripts, overrides?.scripts),
  };
}

/**
 * Only the fields of `settings` that differ from the defaults: what gets written to disk. Returns {}
 * when nothing differs. API keys are not part of the wire form, so they never appear here; the
 * store keeps them alongside these overrides.
 */
export function settingsOverrides(settings: Settings): SettingsPatch {
  const result: SettingsPatch = {};

  const prompts: Partial<Record<GitActionKind, string>> = {};
  let anyPrompt = false;
  for (const kind of gitActionKinds) {
    const value = settings.gitActions.prompts[kind];
    if (value !== defaultSettings.gitActions.prompts[kind]) {
      prompts[kind] = value;
      anyPrompt = true;
    }
  }
  if (anyPrompt) result.gitActions = { prompts };

  const orchestrator: OrchestratorSettingsPatch = {};
  const base = defaultSettings.orchestrator;
  const given = settings.orchestrator;
  if (given.provider !== base.provider) orchestrator.provider = given.provider;
  if (given.model !== base.model) orchestrator.model = given.model;
  if (given.bookkeeping.provider !== base.bookkeeping.provider || given.bookkeeping.model !== base.bookkeeping.model) {
    orchestrator.bookkeeping = { ...given.bookkeeping };
  }
  if (given.intervalMinutes !== base.intervalMinutes) orchestrator.intervalMinutes = given.intervalMinutes;
  if (given.idleIntervalMinutes !== base.idleIntervalMinutes) orchestrator.idleIntervalMinutes = given.idleIntervalMinutes;
  const consolidation: Partial<ConsolidationSettings> = {};
  for (const field of ["nightlyAt", "inboxThreshold", "minIntervalMinutes"] as const) {
    if (given.consolidation[field] !== base.consolidation[field]) (consolidation as Record<string, unknown>)[field] = given.consolidation[field];
  }
  if (Object.keys(consolidation).length > 0) orchestrator.consolidation = consolidation;
  if (Object.keys(orchestrator).length > 0) result.orchestrator = orchestrator;

  const scripts = scriptsOverrides(settings.scripts);
  if (scripts) result.scripts = scripts;

  return result;
}

/**
 * `settings` with `patch` laid on top. A blank prompt in the patch resets that prompt to its
 * default; orchestrator and script fields take the patch's value when present and keep the
 * current one otherwise. Sections the patch does not mention are preserved as they are.
 */
export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  return {
    version: 1,
    gitActions: {
      prompts: mergePrompts(defaultSettings.gitActions.prompts, { ...settings.gitActions.prompts, ...patch.gitActions?.prompts }),
    },
    orchestrator: mergeOrchestrator(settings.orchestrator, patch.orchestrator),
    scripts: mergeScripts(settings.scripts, patch.scripts),
  };
}
