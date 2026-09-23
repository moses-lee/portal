/** Transitional: the sessions service as the module the Next.js app exposed. Delete once nothing imports it. */
import { context, whenContext } from "../context.ts";
import type { SessionsService } from "../sessions/service.ts";

export type { Session, SessionListChange } from "./acp-runtime.ts";
export { toMeta } from "./acp-runtime.ts";

const s = () => context().sessions;
export const ready: Promise<void> = whenContext().then((ctx) => ctx.sessions.ready);
export const listSessions: SessionsService["listSessions"] = () => s().listSessions();
export const getSession: SessionsService["getSession"] = (id) => s().getSession(id);
export const attach: SessionsService["attach"] = (id) => s().attach(id);
export const sendPrompt: SessionsService["sendPrompt"] = (id, text) => s().sendPrompt(id, text);
export const cancel: SessionsService["cancel"] = (id) => s().cancel(id);
export const respondPermission: SessionsService["respondPermission"] = (id, requestId, optionId) => s().respondPermission(id, requestId, optionId);
export const setConfigOption: SessionsService["setConfigOption"] = (id, configId, value) => s().setConfigOption(id, configId, value);
export const setMode: SessionsService["setMode"] = (id, modeId) => s().setMode(id, modeId);
export const readEvents: SessionsService["readEvents"] = (id, opts) => s().readEvents(id, opts);
export const eventsSince: SessionsService["eventsSince"] = (id, since) => s().eventsSince(id, since);
export const deleteSession: SessionsService["deleteSession"] = (id) => s().deleteSession(id);
export const onSessionsChange: SessionsService["onSessionsChange"] = (listener) => s().onSessionsChange(listener);
export const createSession: SessionsService["createSession"] = (cwd, agentId, projectId) => s().createSession(cwd, agentId, projectId);
