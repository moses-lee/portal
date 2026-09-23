/** User settings and provider credentials. TODO(phase 1): Postgres store + encrypted credentials. */
import type { AppContext } from "../context.ts";
import { type SettingsStore, createSettingsStore, defaultSettingsFile } from "../lib/settings-store.ts";

export type SettingsService = SettingsStore;

export function createSettingsService(_ctx: Pick<AppContext, "db" | "log">): SettingsService {
  return createSettingsStore({ file: defaultSettingsFile() });
}
