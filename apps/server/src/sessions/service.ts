/** Sessions: the ACP runtime over the Postgres event log, plus the agents it can launch. */
import type { AgentInfo } from "@portal/contracts/types";
import type { AppContext } from "../context.ts";
import { type AcpRuntime, createAcpRuntime } from "../lib/acp-runtime.ts";
import { type AgentDefinition, agents as builtInAgents } from "../lib/agents.ts";
import { createPgSessionStore } from "./pg-session-store.ts";

export type SessionsOptions = {
  /** The agents sessions can run; defaults to the bundled ACP adapters. Tests pass a fake. */
  agents?: readonly AgentDefinition[];
  /** Forwarded to the runtime (tests shorten them). */
  initializeTimeoutMs?: number;
  recentEvents?: number;
};

export type SessionsService = AcpRuntime & {
  /** The agent a session gets when the request names none. */
  defaultAgentId: string;
  getAgent(id: string): AgentDefinition | undefined;
  listAgents(): AgentInfo[];
};

export function createSessionsService(ctx: Pick<AppContext, "db" | "log">, options: SessionsOptions = {}): SessionsService {
  const agents = options.agents ?? builtInAgents;
  const runtime = createAcpRuntime(agents, {
    store: createPgSessionStore({ db: ctx.db }),
    initializeTimeoutMs: options.initializeTimeoutMs,
    recentEvents: options.recentEvents,
  });
  return {
    ...runtime,
    defaultAgentId: agents[0]?.id ?? "",
    getAgent: (id) => agents.find((agent) => agent.id === id),
    listAgents: () => agents.map(({ id, name }) => ({ id, name })),
  };
}
