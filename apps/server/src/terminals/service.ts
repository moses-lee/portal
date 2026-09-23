/**
 * Terminals: PTYs and their Socket.IO transport. Nothing is persisted, because a PTY dies with the
 * process; the registry is the whole service.
 */
import type { AppContext } from "../context.ts";
import { createTerminalRegistry } from "./registry.ts";

export type TerminalsService = ReturnType<typeof createTerminalRegistry>;

export function createTerminalsService(_ctx: Pick<AppContext, "log">): TerminalsService {
  return createTerminalRegistry();
}
