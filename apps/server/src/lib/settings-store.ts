import os from "node:os";
import path from "node:path";
import { orchestratorProviders } from "./orchestrator/types.ts";
import type { OrchestratorProvider, OrchestratorSettings, OrchestratorSettingsPatch } from "./orchestrator/types.ts";
import { gitActionKinds, isOrchestratorProvider, orchestratorLimits } from "@portal/shared/settings";
import type { GitActionKind, Settings, SettingsPatch } from "@portal/shared/settings";
import { isScriptKind, scriptFields, scriptKinds, scriptLimits } from "@portal/shared/scripts";
import type { ScriptKind, ScriptSettingsPatch, ScriptsPatch } from "@portal/shared/scripts";

/** A settings change the caller got wrong; `status` is the HTTP status to answer with. */
export class SettingsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
  }
}

/**
 * The settings file the web app kept. The server stores settings in Postgres; this path remains for
 * the one-time importer and for the orchestrator's guard that refuses to read it (it holds keys).
 */
export function defaultSettingsFile() {
  return path.join(process.env.PORTAL_HOME || path.join(os.homedir(), ".portal"), "settings.json");
}

/**
 * Which of Portal's secret files `file` is, or null: the settings file and every sibling named after
 * it, since all may hold API keys in plain text (the importer's `settings.json.imported-*` backups,
 * and the old store's `.bad-*` and `.tmp-*` leftovers), or the server key (which opens every stored
 * credential). Compared case-insensitively, since macOS volumes usually are.
 */
export function portalSecretFile(file: string, home = path.dirname(defaultSettingsFile())): "settings" | "server-key" | null {
  const resolved = path.resolve(file).toLowerCase();
  if (path.dirname(resolved) !== path.resolve(home).toLowerCase()) return null;
  const name = path.basename(resolved);
  if (name.startsWith("settings.json")) return "settings";
  return name === "server.key" ? "server-key" : null;
}

/** The longest prompt accepted, after trimming. */
export const MAX_PROMPT_LENGTH = 4000;
const { modelLength: MAX_MODEL_LENGTH, apiKeyLength: MAX_API_KEY_LENGTH } = orchestratorLimits;
const { intervalMinutes: MAX_INTERVAL_MINUTES, idleIntervalMinutes: MAX_IDLE_INTERVAL_MINUTES } = orchestratorLimits;

/**
 * What `settings.json` holds: the overrides that differ from the defaults, plus the real API keys
 * under `orchestrator.apiKeys.<provider>`. This is deliberately not the wire `Settings` type: the
 * browser only ever sees whether a key is stored (see `read()`), never the key itself.
 */
export type SettingsFile = {
  version: 1;
  gitActions?: { prompts?: Partial<Record<GitActionKind, string>> };
  orchestrator?: {
    provider?: OrchestratorProvider;
    model?: string;
    intervalMinutes?: number;
    idleIntervalMinutes?: number;
    apiKeys?: Partial<Record<OrchestratorProvider, string>>;
  };
  scripts?: ScriptsPatch;
};

/** The overrides read from a file, without the version marker. */
type FileOverrides = Omit<SettingsFile, "version">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/*
 * Field validators shared by the PATCH parser (which reports the problem) and the file parser
 * (which falls back to the default). Each returns the normalised value or a message.
 */
type Checked<T> = { value: T } | { error: string };

function checkProvider(value: unknown): Checked<OrchestratorProvider> {
  if (isOrchestratorProvider(value)) return { value };
  return { error: `Unknown provider ${JSON.stringify(value)}; expected one of ${orchestratorProviders.join(", ")}.` };
}

function checkModel(value: unknown): Checked<string> {
  if (typeof value !== "string") return { error: "The model must be a string." };
  const trimmed = value.trim();
  if (!trimmed) return { error: "The model must not be empty." };
  if (trimmed.length > MAX_MODEL_LENGTH) {
    return { error: `The model is too long (${trimmed.length} characters; the limit is ${MAX_MODEL_LENGTH}).` };
  }
  return { value: trimmed };
}

function checkInterval(field: "intervalMinutes" | "idleIntervalMinutes", value: unknown, max: number): Checked<number> {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    return { error: `${field} must be a whole number of minutes between 1 and ${max}.` };
  }
  return { value: value as number };
}

/** An API key from a PATCH: trimmed; "" means "clear". */
function checkApiKey(provider: string, value: unknown): Checked<string> {
  if (typeof value !== "string") return { error: `The ${provider} API key must be a string.` };
  const trimmed = value.trim();
  if (trimmed.length > MAX_API_KEY_LENGTH) {
    return { error: `The ${provider} API key is too long (${trimmed.length} characters; the limit is ${MAX_API_KEY_LENGTH}).` };
  }
  return { value: trimmed };
}

/** One script's fields from a PATCH or a file: each checked on its own, a message for the first bad one. */
function checkScriptField(kind: ScriptKind, field: keyof ScriptSettingsPatch, value: unknown): Checked<string | number | boolean> {
  switch (field) {
    case "command": {
      if (typeof value !== "string") return { error: `The ${kind} script command must be a string.` };
      const trimmed = value.trim();
      if (trimmed.length > scriptLimits.commandLength) {
        return { error: `The ${kind} script command is too long (${trimmed.length} characters; the limit is ${scriptLimits.commandLength}).` };
      }
      // A NUL makes spawn() throw synchronously; other control characters have no place in a command either.
      if (CONTROL_CHARACTERS.test(trimmed)) return { error: `The ${kind} script command must not contain control characters.` };
      return { value: trimmed };
    }
    case "abortOnFailure":
      if (typeof value !== "boolean") return { error: `${kind}.abortOnFailure must be a boolean.` };
      return { value };
    case "timeoutSeconds":
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > scriptLimits.timeoutSeconds) {
        return { error: `${kind}.timeoutSeconds must be a whole number of seconds between 1 and ${scriptLimits.timeoutSeconds}.` };
      }
      return { value: value as number };
  }
}

/** Control characters other than newline, carriage return, and tab. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function parseScriptsPatch(given: unknown): ScriptsPatch {
  if (!isPlainObject(given)) throw new SettingsError("scripts must be an object.", 400);
  const scripts: ScriptsPatch = {};
  for (const [kind, fields] of Object.entries(given)) {
    if (!isScriptKind(kind)) throw new SettingsError(`Unknown script "${kind}"; expected one of ${scriptKinds.join(", ")}.`, 400);
    if (!isPlainObject(fields)) throw new SettingsError(`scripts.${kind} must be an object.`, 400);
    const patch: ScriptSettingsPatch = {};
    for (const field of scriptFields) {
      if (fields[field] === undefined) continue;
      (patch as Record<string, unknown>)[field] = required(checkScriptField(kind, field, fields[field]));
    }
    scripts[kind] = patch;
  }
  return scripts;
}

function parsePromptsPatch(given: unknown): Partial<Record<GitActionKind, string>> {
  if (!isPlainObject(given)) throw new SettingsError("gitActions.prompts must be an object.", 400);
  const prompts: Partial<Record<GitActionKind, string>> = {};
  for (const [key, value] of Object.entries(given)) {
    if (!(gitActionKinds as readonly string[]).includes(key)) {
      throw new SettingsError(`Unknown git action "${key}"; expected one of ${gitActionKinds.join(", ")}.`, 400);
    }
    if (typeof value !== "string") throw new SettingsError(`The ${key} prompt must be a string.`, 400);
    const trimmed = value.trim();
    if (trimmed.length > MAX_PROMPT_LENGTH) {
      throw new SettingsError(`The ${key} prompt is too long (${trimmed.length} characters; the limit is ${MAX_PROMPT_LENGTH}).`, 400);
    }
    prompts[key as GitActionKind] = trimmed;
  }
  return prompts;
}

function required<T>(checked: Checked<T>): T {
  if ("error" in checked) throw new SettingsError(checked.error, 400);
  return checked.value;
}

function parseOrchestratorPatch(given: unknown): OrchestratorSettingsPatch {
  if (!isPlainObject(given)) throw new SettingsError("orchestrator must be an object.", 400);
  const patch: OrchestratorSettingsPatch = {};
  if (given.provider !== undefined) patch.provider = required(checkProvider(given.provider));
  if (given.model !== undefined) patch.model = required(checkModel(given.model));
  if (given.intervalMinutes !== undefined) {
    patch.intervalMinutes = required(checkInterval("intervalMinutes", given.intervalMinutes, MAX_INTERVAL_MINUTES));
  }
  if (given.idleIntervalMinutes !== undefined) {
    patch.idleIntervalMinutes = required(checkInterval("idleIntervalMinutes", given.idleIntervalMinutes, MAX_IDLE_INTERVAL_MINUTES));
  }
  if (given.apiKeys !== undefined) {
    if (!isPlainObject(given.apiKeys)) throw new SettingsError("orchestrator.apiKeys must be an object.", 400);
    const apiKeys: Partial<Record<OrchestratorProvider, string>> = {};
    for (const [key, value] of Object.entries(given.apiKeys)) {
      if (!isOrchestratorProvider(key)) {
        throw new SettingsError(`Unknown provider "${key}"; expected one of ${orchestratorProviders.join(", ")}.`, 400);
      }
      apiKeys[key] = required(checkApiKey(key, value));
    }
    patch.apiKeys = apiKeys;
  }
  return patch;
}

/**
 * Check a PATCH body from the network. Unknown keys beside the known sections and fields are
 * ignored, but prompt kinds, script kinds, and API key providers must be known, and every value must have the
 * right type and size. Strings are trimmed. Only the sections present in `input` appear in the result.
 */
export function parseSettingsPatch(input: unknown): SettingsPatch {
  if (!isPlainObject(input)) throw new SettingsError("Expected a JSON object.", 400);
  const patch: SettingsPatch = {};
  if (input.gitActions !== undefined) {
    if (!isPlainObject(input.gitActions)) throw new SettingsError("gitActions must be an object.", 400);
    patch.gitActions = input.gitActions.prompts === undefined ? {} : { prompts: parsePromptsPatch(input.gitActions.prompts) };
  }
  if (input.orchestrator !== undefined) patch.orchestrator = parseOrchestratorPatch(input.orchestrator);
  if (input.scripts !== undefined) patch.scripts = parseScriptsPatch(input.scripts);
  return patch;
}

/** The scripts section of a settings file, field by field like the others; a bad value falls back to its default. */
function parseScriptsFile(given: unknown): SettingsFile["scripts"] {
  if (!isPlainObject(given)) return undefined;
  const scripts: ScriptsPatch = {};
  for (const kind of scriptKinds) {
    const fields = given[kind];
    if (!isPlainObject(fields)) continue;
    const patch: ScriptSettingsPatch = {};
    for (const field of scriptFields) {
      const checked = checkScriptField(kind, field, fields[field]);
      if ("value" in checked) (patch as Record<string, unknown>)[field] = checked.value;
    }
    if (Object.keys(patch).length > 0) scripts[kind] = patch;
  }
  return Object.keys(scripts).length > 0 ? scripts : undefined;
}

/**
 * The orchestrator section of a settings file. Every field is checked on its own: an invalid value
 * is dropped (so the default applies) rather than failing the whole file, since the user may have
 * edited it by hand. Keys that are not non-empty strings are treated as absent.
 */
function parseOrchestratorFile(given: unknown): SettingsFile["orchestrator"] {
  if (!isPlainObject(given)) return undefined;
  const section: NonNullable<SettingsFile["orchestrator"]> = {};
  const provider = checkProvider(given.provider);
  if ("value" in provider) section.provider = provider.value;
  const model = checkModel(given.model);
  if ("value" in model) section.model = model.value;
  const interval = checkInterval("intervalMinutes", given.intervalMinutes, MAX_INTERVAL_MINUTES);
  if ("value" in interval) section.intervalMinutes = interval.value;
  const idle = checkInterval("idleIntervalMinutes", given.idleIntervalMinutes, MAX_IDLE_INTERVAL_MINUTES);
  if ("value" in idle) section.idleIntervalMinutes = idle.value;
  if (isPlainObject(given.apiKeys)) {
    const apiKeys: Partial<Record<OrchestratorProvider, string>> = {};
    for (const provider of orchestratorProviders) {
      const key = checkApiKey(provider, given.apiKeys[provider]);
      if ("value" in key && key.value) apiKeys[provider] = key.value;
    }
    if (Object.keys(apiKeys).length > 0) section.apiKeys = apiKeys;
  }
  return Object.keys(section).length > 0 ? section : undefined;
}

/** The gitActions section of a settings file, read field by field like the orchestrator one; anything that is not a known prompt string is dropped. */
function parseGitActionsFile(given: unknown): SettingsFile["gitActions"] {
  const prompts = isPlainObject(given) ? given.prompts : undefined;
  if (!isPlainObject(prompts)) return undefined;
  const kept: Partial<Record<GitActionKind, string>> = {};
  for (const kind of gitActionKinds) if (typeof prompts[kind] === "string") kept[kind] = prompts[kind];
  return { prompts: kept };
}

/** Every section of a parsed settings document, each read on its own and dropped when it does not fit. */
function parseOverridesObject(parsed: Record<string, unknown>): FileOverrides {
  const overrides: FileOverrides = {};
  const gitActions = parseGitActionsFile(parsed.gitActions);
  if (gitActions) overrides.gitActions = gitActions;
  const orchestrator = parseOrchestratorFile(parsed.orchestrator);
  if (orchestrator) overrides.orchestrator = orchestrator;
  const scripts = parseScriptsFile(parsed.scripts);
  if (scripts) overrides.scripts = scripts;
  return overrides;
}

/**
 * The overrides in a settings file, or null only when the file is not a JSON object at all. Every
 * section and field is read on its own and dropped when it does not fit, including an unexpected
 * `version`, so a file from a newer Portal still yields its API keys. The importer that moves
 * `settings.json` into Postgres reads it with this.
 */
export function parseSettingsFile(text: string): FileOverrides | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  return parseOverridesObject(parsed);
}

/**
 * Stored overrides (the `settings` row's jsonb) read as leniently as the file was: a bad field
 * falls back to its default instead of failing every read. API keys never belong here, so any
 * found are dropped.
 */
export function parseStoredOverrides(value: unknown): SettingsPatch {
  if (!isPlainObject(value)) return {};
  const overrides = parseOverridesObject(value);
  if (overrides.orchestrator?.apiKeys) {
    const { apiKeys: _dropped, ...rest } = overrides.orchestrator;
    if (Object.keys(rest).length > 0) overrides.orchestrator = rest;
    else delete overrides.orchestrator;
  }
  return overrides;
}

export type SettingsStore = {
  /** Settles once the store can serve calls (the server key is loaded); every method waits for it anyway. */
  ready: Promise<void>;
  /** Merged settings (defaults + stored overrides) in the wire form: API keys masked to booleans. Nothing stored means defaults. */
  read(): Promise<Settings>;
  /** The merged orchestrator section of `read()`. */
  orchestrator(): Promise<OrchestratorSettings>;
  /** The stored API key for `provider`, or null when none is. For server code only; never send it to the browser. */
  apiKey(provider: OrchestratorProvider): Promise<string | null>;
  /**
   * Validate `patch` (unknown input from the network), apply it on top of the current overrides,
   * store only the overrides that differ from defaults plus the key changes, and return the merged result.
   */
  patch(patch: unknown): Promise<Settings>;
  /** Called with the merged settings after every successful `patch`. Returns the unsubscribe function. */
  subscribe(listener: (settings: Settings) => void): () => void;
};
