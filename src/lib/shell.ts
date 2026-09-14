import { createShellRuntime } from "./shell-runtime.ts";

// Shared by all tabs/devices and preserved across Next.js development hot reloads.
const globals = globalThis as unknown as {
  __portalShell?: ReturnType<typeof createShellRuntime>;
};

export const shell = (globals.__portalShell ??= createShellRuntime());
