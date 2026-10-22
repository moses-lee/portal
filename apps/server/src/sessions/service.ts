/** Sessions: the ACP runtime over the Postgres event log, plus the agents it can launch. */
import path from "node:path";
import type { AgentInfo } from "@portal/contracts/types";
import type { AppContext } from "../context.ts";
import { type AcpRuntime, createAcpRuntime } from "../lib/acp-runtime.ts";
import { createAdapterGroupFile } from "../lib/adapter-groups.ts";
import { type AgentDefinition, agents as builtInAgents } from "../lib/agents.ts";
import { type BlobStore, createBlobStore } from "../lib/blobs.ts";
import { createPgSessionStore } from "./pg-session-store.ts";

export type SessionsOptions = {
  /** The agents sessions can run; defaults to the bundled ACP adapters. Tests pass a fake. */
  agents?: readonly AgentDefinition[];
  /** Forwarded to the runtime (tests shorten them). */
  initializeTimeoutMs?: number;
  recentEvents?: number;
  /** Where tool-result images are kept; defaults to `<portalHome>/blobs`. Null keeps them inline (tests). */
  blobsDir?: string | null;
  /** Where the adapters' process groups are listed; defaults to `<portalHome>/run/adapters.json`. Null keeps no list. */
  adapterGroupsFile?: string | null;
};

export type SessionsService = AcpRuntime & {
  /** The agent a session gets when the request names none. */
  defaultAgentId: string;
  getAgent(id: string): AgentDefinition | undefined;
  listAgents(): AgentInfo[];
  /** The files `GET /api/blobs/:name` serves; null when images stay inline. */
  blobs: BlobStore | null;
};

export function createSessionsService(ctx: Pick<AppContext, "db" | "log"> & Partial<Pick<AppContext, "config">>, options: SessionsOptions = {}): SessionsService {
  const agents = options.agents ?? builtInAgents;
  const blobsDir = options.blobsDir === undefined ? (ctx.config ? path.join(ctx.config.portalHome, "blobs") : null) : options.blobsDir;
  const blobs = blobsDir ? createBlobStore(blobsDir) : null;
  const groupsFile = options.adapterGroupsFile === undefined
    ? (ctx.config ? path.join(ctx.config.portalHome, "run", "adapters.json") : null)
    : options.adapterGroupsFile;
  const runtime = createAcpRuntime(agents, {
    store: createPgSessionStore({ db: ctx.db }),
    initializeTimeoutMs: options.initializeTimeoutMs,
    recentEvents: options.recentEvents,
    blobs,
    adapterGroups: groupsFile ? createAdapterGroupFile(groupsFile, (message) => ctx.log.warn(message)) : null,
  });
  return {
    ...runtime,
    defaultAgentId: agents[0]?.id ?? "",
    getAgent: (id) => agents.find((agent) => agent.id === id),
    listAgents: () => agents.map(({ id, name }) => ({ id, name })),
    blobs,
  };
}
