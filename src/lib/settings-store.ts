import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { orchestratorProviders } from "./orchestrator/types.ts";
import type { OrchestratorProvider, OrchestratorSettings, OrchestratorSettingsPatch } from "./orchestrator/types.ts";
import {
  applySettingsPatch,
  gitActionKinds,
  isOrchestratorProvider,
  mergeSettings,
  orchestratorLimits,
  settingsOverrides,
} from "./settings.ts";
import type { GitActionKind, Settings, SettingsPatch } from "./settings.ts";

/** A settings change the caller got wrong; `status` is the HTTP status to answer with. */
export class SettingsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
  }
}

export function defaultSettingsFile() {
  return path.join(process.env.PORTAL_HOME || path.join(os.homedir(), ".portal"), "settings.json");
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
 * ignored, but prompt kinds and API key providers must be known, and every value must have the
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
  return patch;
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

/**
 * The overrides in a settings file, or null only when the file is not a JSON object at all. Every
 * section and field is read on its own and dropped when it does not fit, including an unexpected
 * `version`: a "corrupt" verdict makes the next `save()` move the file aside and write fresh
 * overrides, which would silently lose the API keys, so the file is only given up on when there is
 * nothing in it to carry over.
 */
export function parseSettingsFile(text: string): FileOverrides | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  const overrides: FileOverrides = {};
  const gitActions = parseGitActionsFile(parsed.gitActions);
  if (gitActions) overrides.gitActions = gitActions;
  const orchestrator = parseOrchestratorFile(parsed.orchestrator);
  if (orchestrator) overrides.orchestrator = orchestrator;
  return overrides;
}

export type SettingsStore = {
  /** Merged settings (defaults + overrides on disk) in the wire form: API keys masked to booleans. A missing file means defaults. */
  read(): Promise<Settings>;
  /** The merged orchestrator section of `read()`. */
  orchestrator(): Promise<OrchestratorSettings>;
  /** The stored API key for `provider`, or null when none is. For server code only; never send it to the browser. */
  apiKey(provider: OrchestratorProvider): Promise<string | null>;
  /**
   * Validate `patch` (unknown input from the network), apply on top of the current overrides, write only
   * the overrides that differ from defaults (atomic tmp+rename, mkdir -p the parent), return the merged result.
   */
  patch(patch: unknown): Promise<Settings>;
  /** Called with the merged settings after every successful `patch`. Returns the unsubscribe function. */
  subscribe(listener: (settings: Settings) => void): () => void;
};

/**
 * Persisted user settings. Only the values that differ from the defaults are kept on disk, so a
 * change to a default reaches every user who has not customised that field. The file is read on
 * every call (it is tiny, and may be edited by hand) and rewritten atomically on every change.
 */
export function createSettingsStore({ file }: { file: string }): SettingsStore {
  /** The file could not be parsed on the last read; it is backed up rather than overwritten on the next change. */
  let corrupt = false;
  let warned = false;
  const listeners = new Set<(settings: Settings) => void>();

  async function loadOverrides(): Promise<FileOverrides> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return {};
      throw err;
    }
    const loaded = parseSettingsFile(text);
    if (loaded) {
      corrupt = false;
      return loaded;
    }
    corrupt = true;
    if (!warned) {
      warned = true;
      console.warn(`Ignoring unreadable settings file ${file}; using defaults. It will be backed up on the next change.`);
    }
    return {};
  }

  async function save(overrides: FileOverrides) {
    // The file holds API keys, so a freshly created PORTAL_HOME is private like the orchestrator's directory.
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (corrupt) {
      // Keep the unreadable file for the user instead of silently overwriting it.
      await rename(file, `${file}.bad-${Date.now()}`).catch(() => {});
      corrupt = false;
      warned = false;
    }
    const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
    const body: SettingsFile = { version: 1, ...overrides };
    try {
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  // One chain for every change so concurrent patches never interleave their read-modify-write.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function read(): Promise<Settings> {
    return mergeSettings(await loadOverrides());
  }

  async function orchestrator(): Promise<OrchestratorSettings> {
    return (await read()).orchestrator;
  }

  async function apiKey(provider: OrchestratorProvider): Promise<string | null> {
    if (!isOrchestratorProvider(provider)) return null;
    return (await loadOverrides()).orchestrator?.apiKeys?.[provider] ?? null;
  }

  /**
   * The keys to write: the stored ones with the patch's changes applied. Keys live outside the
   * wire form, so they are carried over here rather than through settingsOverrides().
   */
  function nextApiKeys(stored: FileOverrides, patch: SettingsPatch): Partial<Record<OrchestratorProvider, string>> {
    const keys = { ...stored.orchestrator?.apiKeys };
    for (const provider of orchestratorProviders) {
      const value = patch.orchestrator?.apiKeys?.[provider];
      if (value === undefined) continue;
      if (value) keys[provider] = value;
      else delete keys[provider];
    }
    return keys;
  }

  async function patch(input: unknown): Promise<Settings> {
    // Validate before queueing so a bad request never waits behind a write.
    const parsed = parseSettingsPatch(input);
    const next = await mutate(async () => {
      const stored = await loadOverrides();
      const merged = applySettingsPatch(mergeSettings(stored), parsed);
      const overrides: FileOverrides = settingsOverrides(merged);
      const apiKeys = nextApiKeys(stored, parsed);
      if (Object.keys(apiKeys).length > 0) overrides.orchestrator = { ...overrides.orchestrator, apiKeys };
      await save(overrides);
      return merged;
    });
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (err) {
        // A listener's bug must not fail the caller's request or starve the other listeners.
        console.error("Settings listener failed:", err);
      }
    }
    return next;
  }

  function subscribe(listener: (settings: Settings) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { read, orchestrator, apiKey, patch, subscribe };
}
