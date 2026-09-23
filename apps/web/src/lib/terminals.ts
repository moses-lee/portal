import { createTerminalRegistry } from "./terminals-registry.ts";

// The custom server (Node type-stripping) and Next's bundle each load their own copy of this
// module; the global is the only thing that makes them share one registry. It also survives
// Next.js development hot reloads.
const globals = globalThis as unknown as {
  __portalTerminals?: ReturnType<typeof createTerminalRegistry>;
};

export const terminals = (globals.__portalTerminals ??= createTerminalRegistry());
