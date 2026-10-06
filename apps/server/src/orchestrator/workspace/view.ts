/**
 * What the device that sent a chat message is looking at (docs/WORKSPACE.md, decision 16): the
 * `view` beside the message, validated here, and the "You are looking at" line the turn's prompt
 * and `get_workspace` describe it with.
 */
import type { SessionMeta } from "../../lib/types.ts";
import type { Workspace, WorkspaceView } from "@portal/contracts/workspace";
import { defaultTabTitle, findTab, tabPanes } from "@portal/shared/workspace";
import { httpError } from "../../http/errors.ts";
import { clip, shortId } from "../world/render.ts";

/** Session titles and tab names are the user's (or an agent's) text: clipped in the sentence as the World section clips them. */
const TITLE_MAX = 60;
const TAB_NAME_MAX = 50;

/** `view` from a message body, or a 400: each of `sessionId`, `tabId`, `paneId` a non-empty string or null (absent counts as null). */
export function parseView(input: unknown): WorkspaceView {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError("Expected view: { sessionId, tabId, paneId }, each a string or null.", 400);
  const record = input as Record<string, unknown>;
  const field = (key: "sessionId" | "tabId" | "paneId"): string | null => {
    const value = record[key] ?? null;
    if (value !== null && (typeof value !== "string" || value === "")) throw httpError(`view.${key} must be a non-empty string or null.`, 400);
    return value;
  };
  return { sessionId: field("sessionId"), tabId: field("tabId"), paneId: field("paneId") };
}

export type ViewDescription = {
  sessionId: string | null;
  title: string | null;
  tabId: string | null;
  tabName: string | null;
  paneId: string | null;
  /** The sentence the prompt carries after "You are looking at: ". */
  text: string;
};

/**
 * The view in words. `titleOf` answers a session's title, null for an untitled one, and undefined
 * for a session Portal no longer has. The tab clause is left out when the view names no tab
 * (the tracked panel) or a tab the workspace no longer holds.
 */
export function describeView(view: WorkspaceView, workspace: Workspace | null, titleOf: (sessionId: string) => string | null | undefined): ViewDescription {
  if (view.sessionId === null) return { sessionId: null, title: null, tabId: null, tabName: null, paneId: null, text: "the Portal page, no session." };
  const found = titleOf(view.sessionId);
  const title = found === undefined ? "no longer exists" : found?.trim() || "Untitled";
  const tab = view.tabId && workspace ? findTab(workspace, view.tabId) : null;
  const tabName = tab ? defaultTabTitle(tab, (id) => titleOf(id)?.trim() || null) : null;
  const text = `session ${shortId(view.sessionId)} (${clip(title, TITLE_MAX)})${tabName === null ? "" : `, in tab "${clip(tabName, TAB_NAME_MAX)}"`}.`;
  return { sessionId: view.sessionId, title: found?.trim() || null, tabId: tab?.id ?? null, tabName, paneId: view.paneId, text };
}

/** The prompt's line for `view`, with the session titles it needs read from `sessions`. */
export async function lookingAtLine(view: WorkspaceView, workspace: Workspace | null, sessions: { get(id: string): Promise<SessionMeta | null> }): Promise<string> {
  const ids = new Set<string>();
  if (view.sessionId) ids.add(view.sessionId);
  const tab = view.tabId && workspace ? findTab(workspace, view.tabId) : null;
  for (const pane of tab ? tabPanes(tab) : []) if (pane.sessionId) ids.add(pane.sessionId);
  const titles = new Map<string, string | null | undefined>();
  await Promise.all([...ids].map(async (id) => {
    const meta = await sessions.get(id).catch(() => null);
    titles.set(id, meta ? meta.title : undefined);
  }));
  return `You are looking at: ${describeView(view, workspace, (id) => titles.get(id)).text}`;
}
