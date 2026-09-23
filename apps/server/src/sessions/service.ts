/** Sessions: the ACP runtime over the Postgres event log. */
import type { AppContext } from "../context.ts";
import { type AcpRuntime, createAcpRuntime } from "../lib/acp-runtime.ts";
import { agents } from "../lib/agents.ts";
import { createPgSessionStore } from "./pg-session-store.ts";

export type SessionsService = AcpRuntime;

export function createSessionsService(ctx: Pick<AppContext, "db" | "log">): SessionsService {
  return createAcpRuntime(agents, { store: createPgSessionStore({ db: ctx.db }) });
}
