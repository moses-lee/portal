/**
 * Preloaded by `pnpm test` (`node --import`): points PORTAL_HOME at a throwaway directory unless the
 * caller chose one. `buildApp()` with the default config reads the Portal home at boot (the server
 * key, the legacy import), and a test must never touch the user's real ~/.portal. Each test-file
 * process gets its own directory (the runner passes the preload on), so two files creating a server
 * key at once never race on one file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.PORTAL_HOME || process.env.PORTAL_HOME === process.env.PORTAL_SCRATCH_HOME) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "portal-test-home-"));
  process.env.PORTAL_HOME = dir;
  process.env.PORTAL_SCRATCH_HOME = dir;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
