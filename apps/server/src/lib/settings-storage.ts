/** Transitional: the settings service as the module the Next.js app exposed. Delete once nothing imports it. */
import { context } from "../context.ts";
import type { SettingsService } from "../settings/service.ts";

export function getSettingsStore(): SettingsService {
  return context().settings;
}
