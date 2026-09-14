import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// node-pty 1.1.0's macOS prebuild ships spawn-helper without its executable bit.
// Keep fresh pnpm installs usable, including installs restored from the store.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("node-pty/package.json"));
  for (const directory of [`prebuilds/darwin-${process.arch}`, "build/Release"]) {
    const helper = path.join(root, directory, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
