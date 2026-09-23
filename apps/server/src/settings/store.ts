/**
 * The settings store's behaviour, independent of where the bytes live. A backend persists two
 * things: the overrides (every setting that differs from its default, never a secret) and the
 * provider API keys. This module owns validation, merging, masking, write ordering and change
 * notification, so the Postgres and in-memory stores cannot drift apart.
 */
import { orchestratorProviders } from "../lib/orchestrator/types.ts";
import type { OrchestratorProvider, OrchestratorSettings } from "../lib/orchestrator/types.ts";
import { applySettingsPatch, isOrchestratorProvider, mergeSettings, settingsOverrides } from "../lib/settings.ts";
import type { Settings, SettingsPatch } from "../lib/settings.ts";
import { parseSettingsPatch } from "../lib/settings-store.ts";
import type { SettingsStore } from "../lib/settings-store.ts";

/** Key changes from one patch: a non-empty string stores that key, "" removes it. */
export type ApiKeyChanges = Partial<Record<OrchestratorProvider, string>>;

export interface SettingsBackend {
  /** Settles when the backend can serve calls; rejects when it never will. */
  readonly ready: Promise<void>;
  /** The stored overrides, without API keys; {} when nothing is stored. */
  loadOverrides(): Promise<SettingsPatch>;
  /** The providers that have a usable key stored. */
  storedKeys(): Promise<Set<OrchestratorProvider>>;
  loadKey(provider: OrchestratorProvider): Promise<string | null>;
  /** Replace the overrides and apply `keys`, together (one transaction where the backend has them). */
  write(overrides: SettingsPatch, keys: ApiKeyChanges): Promise<void>;
}

/** `settings` with the wire form's key booleans taken from what is actually stored. */
function withStoredKeys(settings: Settings, stored: Set<OrchestratorProvider>): Settings {
  const apiKeys = { ...settings.orchestrator.apiKeys };
  for (const provider of orchestratorProviders) apiKeys[provider] = stored.has(provider);
  return { ...settings, orchestrator: { ...settings.orchestrator, apiKeys } };
}

export function createSettingsStore(backend: SettingsBackend): SettingsStore {
  const listeners = new Set<(settings: Settings) => void>();

  // One chain for every change so concurrent patches never interleave their read-modify-write.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function read(): Promise<Settings> {
    await backend.ready;
    const [overrides, stored] = await Promise.all([backend.loadOverrides(), backend.storedKeys()]);
    return withStoredKeys(mergeSettings(overrides), stored);
  }

  async function orchestrator(): Promise<OrchestratorSettings> {
    return (await read()).orchestrator;
  }

  async function apiKey(provider: OrchestratorProvider): Promise<string | null> {
    if (!isOrchestratorProvider(provider)) return null;
    await backend.ready;
    return backend.loadKey(provider);
  }

  async function patch(input: unknown): Promise<Settings> {
    // Validate before queueing so a bad request never waits behind a write.
    const parsed = parseSettingsPatch(input);
    const next = await mutate(async () => {
      const merged = applySettingsPatch(await read(), parsed);
      // Keys live outside the overrides: settingsOverrides() never carries them, the backend gets them separately.
      await backend.write(settingsOverrides(merged), parsed.orchestrator?.apiKeys ?? {});
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

  return {
    // A getter, so a backend that loads lazily (the server key) only starts when someone asks.
    get ready() {
      return backend.ready;
    },
    read,
    orchestrator,
    apiKey,
    patch,
    subscribe,
  };
}

/** An in-memory backend whose state tests can inspect; see `createMemorySettingsStore`. */
export type MemorySettingsBackend = SettingsBackend & {
  overrides: SettingsPatch;
  keys: Map<OrchestratorProvider, string>;
};

export function createMemorySettingsBackend(seed: { overrides?: SettingsPatch; apiKeys?: ApiKeyChanges } = {}): MemorySettingsBackend {
  const backend: MemorySettingsBackend = {
    ready: Promise.resolve(),
    overrides: structuredClone(seed.overrides ?? {}),
    keys: new Map(),
    async loadOverrides() {
      return structuredClone(backend.overrides);
    },
    async storedKeys() {
      return new Set(backend.keys.keys());
    },
    async loadKey(provider) {
      return backend.keys.get(provider) ?? null;
    },
    async write(overrides, keys) {
      backend.overrides = structuredClone(overrides);
      applyKeyChanges(backend.keys, keys);
    },
  };
  applyKeyChanges(backend.keys, seed.apiKeys ?? {});
  return backend;
}

function applyKeyChanges(target: Map<OrchestratorProvider, string>, keys: ApiKeyChanges) {
  for (const provider of orchestratorProviders) {
    const value = keys[provider];
    if (value === undefined) continue;
    if (value) target.set(provider, value);
    else target.delete(provider);
  }
}

/**
 * A settings store that keeps everything in memory, for tests of code that reads settings (the
 * orchestrator, script runner, routes). `seed` is applied as-is, without validation.
 */
export function createMemorySettingsStore(seed?: { overrides?: SettingsPatch; apiKeys?: ApiKeyChanges }): SettingsStore {
  return createSettingsStore(createMemorySettingsBackend(seed));
}
