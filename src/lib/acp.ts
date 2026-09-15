import { agents, defaultAgentId } from "./agents";
import { createAcpRuntime } from "./acp-runtime";

export type { Session } from "./acp-runtime";
export type { PortalEvent } from "./types";

// Keep processes and their session event logs alive across Next.js dev HMR.
const globalAcp = globalThis as unknown as {
  __portalMultiAgentAcp?: ReturnType<typeof createAcpRuntime>;
};
const runtime = (globalAcp.__portalMultiAgentAcp ??= createAcpRuntime(agents));

export const listSessions = runtime.listSessions;
export const getSession = runtime.getSession;
export const sendPrompt = runtime.sendPrompt;
export const cancel = runtime.cancel;
export const respondPermission = runtime.respondPermission;
export const setConfigOption = runtime.setConfigOption;
export const setMode = runtime.setMode;

export function createSession(cwd: string, agentId = defaultAgentId) {
  return runtime.createSession(cwd, agentId);
}
