import { createSettingsStore, defaultSettingsFile } from "./settings-store";
import type { SettingsStore } from "./settings-store";

// Keep one store (and its write queue) alive across Next.js dev HMR, as projects.ts does for projects.
const globalSettings = globalThis as unknown as {
  __portalSettings?: SettingsStore;
};

export function getSettingsStore(): SettingsStore {
  return (globalSettings.__portalSettings ??= createSettingsStore({ file: defaultSettingsFile() }));
}
