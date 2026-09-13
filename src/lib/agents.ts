import "server-only";
import path from "node:path";
import type { AgentInfo } from "./types";

export type AgentDefinition = AgentInfo & {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  authHint: string;
};

function packageEntry(packageName: string): string {
  // Plain paths keep Turbopack from rewriting subprocess entry points.
  return path.join(process.cwd(), "node_modules", "@agentclientprotocol", packageName, "dist", "index.js");
}

export const agents: readonly AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: process.execPath,
    args: [packageEntry("claude-agent-acp")],
    authHint: "Run `claude` and sign in on the machine running Portal, then create a new session.",
  },
  {
    id: "codex",
    name: "Codex",
    command: process.execPath,
    args: [packageEntry("codex-acp")],
    authHint: "Run `codex login` on the machine running Portal, then create a new session.",
  },
];

export const defaultAgentId = agents[0].id;

export function getAgent(id: string): AgentDefinition | undefined {
  return agents.find((agent) => agent.id === id);
}

export function listAgents(): AgentInfo[] {
  return agents.map(({ id, name }) => ({ id, name }));
}
