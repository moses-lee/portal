import { agents, defaultAgentId } from "./agents";
import { createAcpRuntime } from "./acp-runtime";
import { sessionStore } from "./session-storage";

export type { Session, SessionListChange } from "./acp-runtime";
export { toMeta } from "./acp-runtime";
export type { PortalEvent } from "./types";

// Keep processes and their session event logs alive across Next.js dev HMR.
const globalAcp = globalThis as unknown as {
  __portalMultiAgentAcp?: ReturnType<typeof createAcpRuntime>;
};
const runtime = (globalAcp.__portalMultiAgentAcp ??= createAcpRuntime(agents, { store: sessionStore }));

/** Resolves once sessions persisted by earlier runs are loaded. Routes await it before listing or looking up sessions. */
export const ready = runtime.ready;
export const listSessions = runtime.listSessions;
export const getSession = runtime.getSession;
export const attach = runtime.attach;
export const sendPrompt = runtime.sendPrompt;
export const cancel = runtime.cancel;
export const respondPermission = runtime.respondPermission;
export const setConfigOption = runtime.setConfigOption;
export const setMode = runtime.setMode;
export const readEvents = runtime.readEvents;
export const eventsSince = runtime.eventsSince;
export const deleteSession = runtime.deleteSession;
export const onSessionsChange = runtime.onSessionsChange;

export function createSession(cwd: string, agentId = defaultAgentId, projectId = "") {
  return runtime.createSession(cwd, agentId, projectId);
}
