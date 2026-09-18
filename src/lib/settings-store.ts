import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applySettingsPatch, gitActionKinds, mergeSettings, settingsOverrides } from "./settings.ts";
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

type SettingsFile = { version: 1 } & SettingsPatch;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check a PATCH body from the network. Unknown keys beside `gitActions`/`prompts` are ignored, but the
 * prompt kinds must be known and the values strings; each is trimmed and capped at MAX_PROMPT_LENGTH.
 */
export function parseSettingsPatch(input: unknown): SettingsPatch {
  if (!isPlainObject(input)) throw new SettingsError("Expected a JSON object.", 400);
  if (input.gitActions === undefined) return {};
  if (!isPlainObject(input.gitActions)) throw new SettingsError("gitActions must be an object.", 400);
  if (input.gitActions.prompts === undefined) return { gitActions: {} };
  const given = input.gitActions.prompts;
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
  return { gitActions: { prompts } };
}

/** The overrides in a settings file, or null when it is not a version-1 settings file. Unknown keys and non-string prompts are ignored. */
function parseSettingsFile(text: string): SettingsPatch | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(parsed) || parsed.version !== 1) return null;
  if (parsed.gitActions === undefined) return {};
  if (!isPlainObject(parsed.gitActions)) return null;
  const given = parsed.gitActions.prompts;
  if (given === undefined) return {};
  if (!isPlainObject(given)) return null;
  const prompts: Partial<Record<GitActionKind, string>> = {};
  for (const kind of gitActionKinds) if (typeof given[kind] === "string") prompts[kind] = given[kind];
  return { gitActions: { prompts } };
}

export type SettingsStore = {
  /** Merged settings (defaults + overrides on disk). A missing file means defaults. */
  read(): Promise<Settings>;
  /**
   * Validate `patch` (unknown input from the network), apply on top of the current overrides, write only
   * the overrides that differ from defaults (atomic tmp+rename, mkdir -p the parent), return the merged result.
   */
  patch(patch: unknown): Promise<Settings>;
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

  async function loadOverrides(): Promise<SettingsPatch> {
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

  async function save(overrides: SettingsPatch) {
    await mkdir(path.dirname(file), { recursive: true });
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

  async function patch(input: unknown): Promise<Settings> {
    // Validate before queueing so a bad request never waits behind a write.
    const parsed = parseSettingsPatch(input);
    return mutate(async () => {
      const next = applySettingsPatch(mergeSettings(await loadOverrides()), parsed);
      await save(settingsOverrides(next));
      return next;
    });
  }

  return { read, patch };
}
