import { createRequire } from "node:module";
import path from "node:path";
import type { AgentInfo } from "./types.ts";

export type AgentDefinition = AgentInfo & {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  authHint: string;
};

const require = createRequire(import.meta.url);

/**
 * The adapters are dependencies of this package, so resolve them from here rather than from the
 * working directory (which is the repo root under `pnpm --filter`, where they are not hoisted).
 */
function packageEntry(packageName: string): string {
  return path.join(path.dirname(require.resolve(`@agentclientprotocol/${packageName}/package.json`)), "dist", "index.js");
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
