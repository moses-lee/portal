/** Terminals: PTYs and their Socket.IO transport. */
import type { AppContext } from "../context.ts";
import { createTerminalRegistry } from "../lib/terminals-registry.ts";

export type TerminalsService = ReturnType<typeof createTerminalRegistry>;

export function createTerminalsService(_ctx: Pick<AppContext, "log">): TerminalsService {
  return createTerminalRegistry();
}
