/** User settings and provider credentials, stored in Postgres with keys sealed under the server key. */
import type { AppContext } from "../context.ts";
import type { SettingsStore } from "../lib/settings-store.ts";
import { loadServerKey } from "./crypto.ts";
import { createPgSettingsStore } from "./pg-settings-store.ts";

export type SettingsService = SettingsStore;

/**
 * The server key is read (or created) from `<portalHome>/server.key` on first use. Await `ready`
 * at boot to surface a missing or unreadable key immediately rather than on the first request.
 */
export function createSettingsService(ctx: Pick<AppContext, "db" | "log" | "config">): SettingsService {
  return createPgSettingsStore({
    db: ctx.db,
    key: () => loadServerKey(ctx.config.portalHome),
    warn: (message) => ctx.log.warn(message),
  });
}
