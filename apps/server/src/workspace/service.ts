/**
 * The workspace service (docs/WORKSPACE.md): every edit of the tab strip, from any device or from
 * the orchestrator's tools, goes through `apply`. It runs the shared reducer inside the store's
 * mutation queue (so two devices' operations never interleave), saves only when something changed,
 * pushes the whole workspace to every page (`{ type: "workspace", workspace }`), and logs the
 * structural operations to the activity view (`workspace.opened`, `workspace.closed`,
 * `workspace.arranged`, `workspace.renamed`; `resize` and `move_tab` are not logged).
 *
 * A deleted session (the route, the orchestrator's `delete_session`, the purge of removed sessions)
 * loses its pane: the service hears of it through `deps.sessions.onDeleted`, the way the tracked
 * list does, and closes the pane without logging (whoever deleted the session logs the delete).
 */
import { randomUUID } from "node:crypto";
import type { ActivityActor, ActivityRefs } from "@portal/contracts/activity";
import type { Tab, Workspace, WorkspaceLocation, WorkspaceOp } from "@portal/contracts/workspace";
import { WorkspaceError, applyWorkspaceOp, defaultTabTitle, findTab, locatePane, locateSession, tabPanes } from "@portal/shared/workspace";
import type { OrchestratorHub } from "../orchestrator/hub.ts";
import { errorMessage } from "../orchestrator/tools/context.ts";
import type { WorkspaceStore } from "./store.ts";

/** Who asked: the routes act as the user, the orchestrator's tools as Portal. */
export type WorkspaceActor = "user" | "portal";

/** Where an operation came from, for its activity entry. */
export type WorkspaceOpContext = {
  runId?: string;
  threadId?: string;
  /** Who the activity entry names; by default the user for `actor: "user"`, else the agent. */
  actor?: ActivityActor;
};

export type WorkspaceApplyResult = { workspace: Workspace; location?: WorkspaceLocation; changed: boolean };

export interface WorkspaceService {
  read(): Promise<Workspace>;
  /**
   * Apply one operation. Throws `WorkspaceError`: `invalid` for malformed input, `not_found` for an
   * unknown tab, pane, split, or session (also one deleted while the operation ran: its pane is
   * closed again, as the delete would have), `refused` when the workspace's rules say no (a cap, a
   * session listed twice, a `portal` rename over a `user` one); see `workspaceErrorStatus`.
   */
  apply(op: WorkspaceOp, actor: WorkspaceActor, context?: WorkspaceOpContext): Promise<WorkspaceApplyResult>;
  /** Close the pane holding `sessionId`, if any (pushed, not logged). */
  onSessionDeleted(sessionId: string): Promise<void>;
  /** Stop listening for deleted sessions. */
  dispose(): void;
}

/** The HTTP status a `WorkspaceError` answers with (400, 404, 409); null for any other error. */
export function workspaceErrorStatus(err: unknown): number | null {
  if (!(err instanceof WorkspaceError)) return null;
  return err.code === "invalid" ? 400 : err.code === "not_found" ? 404 : 409;
}

/** The session ids an operation must find in Portal before it runs. */
function sessionsNamedBy(op: WorkspaceOp): string[] {
  switch (op.op) {
    case "open":
      return op.sessionId === null ? [] : [op.sessionId];
    case "replace_pane":
      return [op.sessionId];
    case "arrange":
      return op.sessionIds.filter((id): id is string => id !== null);
    default:
      return [];
  }
}

export function createWorkspaceService(hub: OrchestratorHub, store: WorkspaceStore): WorkspaceService {
  const ids = () => randomUUID();

  function push(workspace: Workspace): void {
    hub.emit({ type: "workspace", workspace });
  }

  /** The session's name for the log (its title, else its agent and short id) and its project. */
  async function describe(sessionId: string): Promise<{ name: string; projectId?: string }> {
    const session = await hub.deps.sessions.get(sessionId).catch(() => null);
    if (!session) return { name: `session ${sessionId.slice(0, 8)}` };
    return { name: session.title?.trim() || `${session.agentName} session ${sessionId.slice(0, 8)}`, projectId: session.projectId || undefined };
  }

  /** A tab's name as the UI shows it, with the real session titles. */
  async function tabName(tab: Tab): Promise<string> {
    const titles = new Map<string, string | null>();
    for (const pane of tabPanes(tab)) {
      if (pane.sessionId !== null && !titles.has(pane.sessionId)) {
        const session = await hub.deps.sessions.get(pane.sessionId).catch(() => null);
        titles.set(pane.sessionId, session?.title?.trim() || null);
      }
    }
    return defaultTabTitle(tab, (id) => titles.get(id) ?? null);
  }

  /** The only session a tab holds, or null when it holds none or several. */
  function soleSession(tab: Tab | null): string | null {
    const sessions = tab ? tabPanes(tab).flatMap((pane) => (pane.sessionId === null ? [] : [pane.sessionId])) : [];
    return sessions.length === 1 ? sessions[0] : null;
  }

  type Entry = { kind: string; summary: string; sessionId: string | null; detail: Record<string, unknown> };

  /** The activity entry for a structural operation that changed `before` into `after`; null for the ones not logged. */
  async function entryFor(op: WorkspaceOp, before: Workspace, after: Workspace, location: WorkspaceLocation | undefined): Promise<Entry | null> {
    switch (op.op) {
      case "open": {
        const tabId = location?.tabId ?? null;
        const where = op.target ? "beside another pane" : "a new tab";
        if (op.sessionId === null) return { kind: "workspace.opened", summary: `Opened a new-session pane in ${where}`, sessionId: null, detail: { tabId, paneId: location?.paneId ?? null, startPage: true } };
        const { name } = await describe(op.sessionId);
        return { kind: "workspace.opened", summary: `Opened "${name}" in ${where}`, sessionId: op.sessionId, detail: { tabId, paneId: location?.paneId ?? null } };
      }
      case "replace_pane": {
        const { name } = await describe(op.sessionId);
        return { kind: "workspace.opened", summary: `Opened "${name}" in a pane`, sessionId: op.sessionId, detail: { tabId: location?.tabId ?? null, paneId: op.paneId } };
      }
      case "arrange": {
        const listed = op.sessionIds.filter((id): id is string => id !== null);
        const tabId = location?.tabId ?? null;
        const tab = tabId ? findTab(after, tabId) : null;
        const named = tab?.title ? ` in tab "${tab.title}"` : "";
        const count = listed.length === 1 ? `"${(await describe(listed[0])).name}"` : `${listed.length} sessions`;
        return {
          kind: "workspace.arranged", summary: `Arranged ${count} as ${op.preset}${named}`, sessionId: listed.length === 1 ? listed[0] : null,
          detail: { tabId, preset: op.preset, sessionIds: op.sessionIds },
        };
      }
      case "close_tab": {
        const tab = findTab(before, op.tabId);
        const name = tab ? await tabName(tab) : op.tabId;
        return { kind: "workspace.closed", summary: `Closed tab "${name}"`, sessionId: soleSession(tab), detail: { tabId: op.tabId, what: "tab" } };
      }
      case "close_pane": {
        const hit = locatePane(before, op.paneId);
        const sessionId = hit?.pane.sessionId ?? null;
        const summary = sessionId === null ? "Closed a new-session pane" : `Closed the pane of "${(await describe(sessionId)).name}"`;
        return { kind: "workspace.closed", summary, sessionId, detail: { tabId: hit?.tabId ?? null, paneId: op.paneId, what: "pane" } };
      }
      case "rename_tab": {
        const from = findTab(before, op.tabId)?.title ?? null;
        const to = findTab(after, op.tabId)?.title ?? null;
        const summary = to === null ? `Cleared the name of tab "${from ?? op.tabId}"` : `Renamed tab "${from ?? "(default name)"}" to "${to}"`;
        return { kind: "workspace.renamed", summary, sessionId: soleSession(findTab(after, op.tabId)), detail: { tabId: op.tabId, from, to } };
      }
      case "move_tab":
      case "resize":
        return null;
    }
  }

  async function log(entry: Entry, actor: WorkspaceActor, context: WorkspaceOpContext): Promise<void> {
    const projectId = entry.sessionId ? (await describe(entry.sessionId)).projectId : undefined;
    const refs: ActivityRefs = {
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(projectId ? { projectId } : {}),
      ...(context.runId ? { runId: context.runId } : {}), ...(context.threadId ? { threadId: context.threadId } : {}),
    };
    await hub.activity.log({
      actor: context.actor ?? (actor === "user" ? "user" : "agent"), kind: entry.kind, summary: entry.summary, refs,
      detail: { actor, ...entry.detail },
    });
  }

  const unsubscribe = hub.deps.sessions.onDeleted?.((sessionId) => {
    void onSessionDeleted(sessionId).catch((err: unknown) => console.error(`Could not close the pane of deleted session ${sessionId}: ${errorMessage(err)}`));
  }) ?? (() => {});

  async function onSessionDeleted(sessionId: string): Promise<void> {
    let changed = false;
    const workspace = await store.mutate((current) => {
      const at = locateSession(current, sessionId);
      if (!at) return null;
      const result = applyWorkspaceOp(current, { op: "close_pane", paneId: at.paneId }, ids, hub.timers.now());
      changed = result.changed;
      return result.changed ? result.workspace : null;
    });
    if (changed) push(workspace);
  }

  return {
    read: () => store.read(),
    async apply(op, actor, context = {}) {
      // The reducer knows tabs and panes; whether a session exists is Portal's to say.
      const named = sessionsNamedBy(op);
      const missing = async () => {
        const gone: string[] = [];
        for (const sessionId of named) if (!(await hub.deps.sessions.get(sessionId).catch(() => null))) gone.push(sessionId);
        return gone;
      };
      const [unknown] = await missing();
      if (unknown) throw new WorkspaceError("not_found", `No session has id "${unknown}".`);
      let before: Workspace | null = null;
      let location: WorkspaceLocation | undefined;
      let changed = false;
      const workspace = await store.mutate((current) => {
        before = current;
        const result = applyWorkspaceOp(current, op, ids, hub.timers.now());
        location = result.location;
        changed = result.changed;
        return result.changed ? result.workspace : null;
      });
      // A session deleted between that check and the write: its delete event ran the cascade
      // before the pane existed, so the pane would stay, with nothing left to close it by session
      // (the tracked service rechecks the same way). Close it now as the delete would have, one
      // push and no entry, and answer as the check would have a moment earlier.
      const vanished = await missing();
      if (vanished.length > 0) {
        for (const sessionId of vanished) await onSessionDeleted(sessionId);
        throw new WorkspaceError("not_found", `No session has id "${vanished[0]}".`);
      }
      if (changed) {
        push(workspace);
        const entry = await entryFor(op, before ?? workspace, workspace, location);
        if (entry) await log(entry, actor, context);
      }
      return { workspace, ...(location ? { location } : {}), changed };
    },
    onSessionDeleted,
    dispose: unsubscribe,
  };
}
