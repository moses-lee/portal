/**
 * Postgres-backed settings: the overrides are one `settings` row (`key = 'overrides'`, jsonb body),
 * and each provider API key is one `credentials` row sealed with the server key (see crypto.ts).
 * Nothing is cached: both reads are a primary-key lookup, and reading fresh means a row changed by
 * the importer or by hand is picked up without a restart.
 */
import { eq, inArray } from "drizzle-orm";
import { orchestratorProviders } from "../lib/orchestrator/types.ts";
import type { OrchestratorProvider } from "../lib/orchestrator/types.ts";
import type { SettingsPatch } from "../lib/settings.ts";
import { isOrchestratorProvider } from "../lib/settings.ts";
import { parseStoredOverrides } from "../lib/settings-store.ts";
import type { SettingsStore } from "../lib/settings-store.ts";
import type { Db } from "../db/client.ts";
import { credentials, settings } from "../db/schema.ts";
import { type ServerKey, decryptSecret, encryptSecret } from "./crypto.ts";
import { type ApiKeyChanges, type SettingsBackend, createSettingsStore } from "./store.ts";

/** The `settings` row that holds the overrides. */
export const OVERRIDES_KEY = "overrides";

export type PgSettingsStoreOptions = {
  db: Db;
  /** Loads the server key. Called at most once, on first need, so a store nobody uses touches no files. */
  key: () => Promise<ServerKey>;
  /** Where to report a credential that cannot be opened; defaults to `console.warn`. */
  warn?: (message: string) => void;
};

export function createPgSettingsStore({ db, key, warn = console.warn }: PgSettingsStoreOptions): SettingsStore {
  let loading: Promise<ServerKey> | null = null;
  function serverKey(): Promise<ServerKey> {
    if (!loading) {
      loading = key();
      // Mark the rejection handled here; each caller still sees it through its own await.
      loading.catch(() => {});
    }
    return loading;
  }

  /** Warn once per credential and key, not on every read. */
  const warned = new Set<string>();
  function warnOnce(id: string, message: string) {
    if (warned.has(id)) return;
    warned.add(id);
    warn(message);
  }

  const backend: SettingsBackend = {
    get ready() {
      return serverKey().then(() => {});
    },

    async loadOverrides(): Promise<SettingsPatch> {
      const [row] = await db.select({ body: settings.body }).from(settings).where(eq(settings.key, OVERRIDES_KEY));
      return parseStoredOverrides(row?.body);
    },

    async storedKeys(): Promise<Set<OrchestratorProvider>> {
      const { keyId } = await serverKey();
      const rows = await db
        .select({ name: credentials.name, keyId: credentials.keyId })
        .from(credentials)
        .where(inArray(credentials.name, [...orchestratorProviders]));
      const stored = new Set<OrchestratorProvider>();
      for (const row of rows) {
        if (!isOrchestratorProvider(row.name)) continue;
        // A key sealed under another server key cannot be used; report it as missing so the user re-enters it.
        if (row.keyId === keyId) stored.add(row.name);
        else warnOnce(`${row.name}:${row.keyId}`, staleMessage(row.name, row.keyId, keyId));
      }
      return stored;
    },

    async loadKey(provider: OrchestratorProvider): Promise<string | null> {
      const current = await serverKey();
      const [row] = await db
        .select({ ciphertext: credentials.ciphertext, keyId: credentials.keyId })
        .from(credentials)
        .where(eq(credentials.name, provider));
      if (!row) return null;
      if (row.keyId !== current.keyId) {
        warnOnce(`${provider}:${row.keyId}`, staleMessage(provider, row.keyId, current.keyId));
        return null;
      }
      try {
        return decryptSecret(current, row.ciphertext, provider);
      } catch {
        warnOnce(`${provider}:${row.ciphertext}`, `The stored ${provider} API key failed its integrity check and is ignored; enter it again in Settings.`);
        return null;
      }
    },

    async write(overrides: SettingsPatch, keys: ApiKeyChanges): Promise<void> {
      const current = await serverKey();
      const now = Date.now();
      await db.transaction(async (tx) => {
        await tx
          .insert(settings)
          .values({ key: OVERRIDES_KEY, body: overrides, updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { body: overrides, updatedAt: now } });
        for (const provider of orchestratorProviders) {
          const value = keys[provider];
          if (value === undefined) continue;
          if (!value) {
            await tx.delete(credentials).where(eq(credentials.name, provider));
            continue;
          }
          const sealed = { ciphertext: encryptSecret(current, value, provider), keyId: current.keyId, updatedAt: now };
          await tx
            .insert(credentials)
            .values({ name: provider, ...sealed, createdAt: now })
            .onConflictDoUpdate({ target: credentials.name, set: sealed });
        }
      });
    },
  };

  return createSettingsStore(backend);
}

function staleMessage(provider: string, rowKeyId: string, keyId: string): string {
  return `The stored ${provider} API key was sealed with server key ${rowKeyId}, but the server key is now ${keyId}; ` +
    "it is ignored until entered again in Settings.";
}
