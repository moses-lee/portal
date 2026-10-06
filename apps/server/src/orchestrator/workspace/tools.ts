/**
 * The workspace tools a chat turn always has (the `workspace` tool group), none on background turns:
 * `get_workspace` (read-only), `open_in_workspace`, `arrange_tab`, `close_in_workspace`, and
 * `rename_tab`. A background turn that names its tools (a helper, a scheduled job) can get
 * `get_workspace`, never the four writers (decision 14). Every edit goes through the workspace service as `portal`, which logs it with the
 * turn's run and thread and pushes the new workspace to every page. Session ids resolve through
 * `requireSession` (a full id or a unique 4+ character prefix); tab ids the same way through
 * `pickById`. Results that open or arrange carry the tab's id and its path (`/tabs/<id>`), which the
 * reply should link; nothing here changes what any device shows (decision 23).
 */
import { z } from "zod";
import type { LayoutNode, Tab, Workspace } from "@portal/contracts/workspace";
import { WORKSPACE_TAB_TITLE_MAX } from "@portal/contracts/workspace";
import { defaultTabTitle, findTab, locateSession, presetOf, tabPanes } from "@portal/shared/workspace";
import type { SessionMeta } from "../../lib/types.ts";
import type { DomainToolContext, ToolSet } from "../hub.ts";
import { pickById } from "../ids.ts";
import { requireSession } from "../ops.ts";
import { define } from "../tools/context.ts";
import { sessionRow } from "../tools/sessions.ts";
import { shortId } from "../world/render.ts";
import { describeView } from "./view.ts";

const sessionId = z.string().min(1);
const tabId = z.string().min(1);
const tabTitle = z.string().trim().min(1).max(WORKSPACE_TAB_TITLE_MAX);
const preset = z.enum(["single", "columns-2", "columns-3", "rows-2", "grid-2x2", "one-beside-two"]);
const edge = z.enum(["left", "right", "top", "bottom"]);

const tabPath = (id: string) => `/tabs/${id}`;

/** A layout as one line: `pane`, `row[pane, column[pane, pane]]`. */
export function shapeOf(node: LayoutNode): string {
  return node.kind === "pane" ? "pane" : `${node.direction}[${node.children.map(shapeOf).join(", ")}]`;
}

export function workspaceTools(ctx: DomainToolContext): ToolSet {
  if (!ctx.interactive) return {};
  const { deps, hub } = ctx;
  const context = () => ({ runId: ctx.turn.runId, ...(ctx.turn.threadId ? { threadId: ctx.turn.threadId } : {}) });
  const pickTab = (workspace: Workspace, id: string): Tab => pickById(workspace.tabs, id, "tab", (tab) => tab.title, "tabId");

  const reading: ToolSet = {
    get_workspace: define(
      "The workspace: the user's tabs in order, each with its name, shape (row[pane, column[pane, pane]]) and panes (session short id, title, live state; a pane with no session is the start page), plus what the user is looking at as they sent this message. Read-only.",
      z.object({}),
      async () => {
        const [workspace, sessions] = await Promise.all([hub.workspace.read(), deps.sessions.list()]);
        const byId = new Map<string, SessionMeta>(sessions.map((meta) => [meta.id, meta]));
        const titleOf = (id: string) => (byId.has(id) ? byId.get(id)!.title : undefined);
        const tabs = workspace.tabs.map((tab) => ({
          id: tab.id,
          name: defaultTabTitle(tab, (id) => titleOf(id)?.trim() || null),
          namedBy: tab.titleSource,
          preset: presetOf(tab.root),
          shape: shapeOf(tab.root),
          path: tabPath(tab.id),
          panes: tabPanes(tab).map((pane) => {
            if (pane.sessionId === null) return { paneId: pane.id, sessionId: null, title: "New session" };
            const meta = byId.get(pane.sessionId);
            if (!meta) return { paneId: pane.id, sessionId: shortId(pane.sessionId), title: null, state: "unknown" };
            const row = sessionRow(meta);
            return { paneId: pane.id, sessionId: shortId(meta.id), title: meta.title, state: row.liveness ?? row.activity, ...(row.status ? { status: row.status } : {}) };
          }),
        }));
        const view = ctx.turn.view ?? null;
        return {
          tabs,
          lookingAt: view ? describeView(view, workspace, titleOf) : null,
          ...(view ? {} : { note: "This message carried no view of what the user is looking at." }),
        };
      },
    ),
  };
  // Decision 14: only the conversation where the user asked edits the workspace. `interactive` is
  // overridden to true for a turn that names its tools (a helper, a scheduled job), so the writers
  // hang on the turn's real origin; such a turn may still read.
  if (ctx.turn.origin !== "chat") return reading;

  return {
    ...reading,
    open_in_workspace: define(
      "Open a session in the workspace: in a new tab at the end, or (besideSessionId) split the pane that holds that session, on its right unless edge says otherwise. A session already open is left where it is. Returns the tab and its path; link the path in your reply, the user decides when to look.",
      z.object({ sessionId, besideSessionId: sessionId.optional(), edge: edge.optional() }),
      async (input) => {
        if (input.edge && !input.besideSessionId) throw new Error("edge says where to split beside a session; pass besideSessionId with it, or leave edge out to open a new tab.");
        const id = (await requireSession(deps, input.sessionId)).id;
        let target: { tabId: string; paneId: string; edge: z.infer<typeof edge> } | undefined;
        if (input.besideSessionId) {
          const beside = (await requireSession(deps, input.besideSessionId)).id;
          const at = locateSession(await hub.workspace.read(), beside);
          if (!at) throw new Error(`Session ${shortId(beside)} is not open in the workspace; open it first, or leave besideSessionId out.`);
          target = { ...at, edge: input.edge ?? "right" };
        }
        const result = await hub.workspace.apply({ op: "open", sessionId: id, ...(target ? { target } : {}) }, "portal", context());
        const location = result.location!;
        return {
          sessionId: id, tabId: location.tabId, paneId: location.paneId, path: tabPath(location.tabId), opened: result.changed,
          ...(result.changed ? {} : { note: "It was already open in the workspace; nothing changed." }),
        };
      },
    ),
    arrange_tab: define(
      "Arrange sessions into a layout preset (single, columns-2, columns-3, rows-2, grid-2x2, one-beside-two) in a new tab, or rebuild tabId in place. sessionIds fill the slots in reading order (null for a start page; slots past the list are start pages); a session open elsewhere moves here. title names the tab. Returns the tab and its path.",
      z.object({ sessionIds: z.array(sessionId.nullable()).max(4), preset, tabId: tabId.optional(), title: tabTitle.optional() }),
      async (input) => {
        const sessionIds = await Promise.all(input.sessionIds.map(async (id) => (id === null ? null : (await requireSession(deps, id)).id)));
        const tab = input.tabId ? pickTab(await hub.workspace.read(), input.tabId) : null;
        const result = await hub.workspace.apply({
          op: "arrange", sessionIds, preset: input.preset, ...(tab ? { tabId: tab.id } : {}),
          ...(input.title !== undefined ? { title: input.title, titleSource: "portal" } : {}),
        }, "portal", context());
        const location = result.location!;
        return { tabId: location.tabId, path: tabPath(location.tabId), preset: input.preset, sessionIds, rebuilt: tab !== null };
      },
    ),
    close_in_workspace: define(
      "Close a tab (tabId) or the pane holding a session (sessionId); pass one of the two. The session itself is untouched. A split left with one pane collapses; a tab left empty goes away.",
      z.object({ tabId: tabId.optional(), sessionId: sessionId.optional() }),
      async (input) => {
        if (!!input.tabId === !!input.sessionId) throw new Error("Pass exactly one of tabId or sessionId.");
        const workspace = await hub.workspace.read();
        if (input.tabId) {
          const tab = pickTab(workspace, input.tabId);
          await hub.workspace.apply({ op: "close_tab", tabId: tab.id }, "portal", context());
          return { closed: "tab", tabId: tab.id };
        }
        const id = (await requireSession(deps, input.sessionId!)).id;
        const at = locateSession(workspace, id);
        if (!at) return { closed: false, sessionId: id, note: "That session is not open in the workspace." };
        await hub.workspace.apply({ op: "close_pane", paneId: at.paneId }, "portal", context());
        return { closed: "pane", sessionId: id, tabId: at.tabId, paneId: at.paneId };
      },
    ),
    rename_tab: define(
      "Name a tab (1 to 60 characters). Refused when the user named it themselves: their name stays.",
      z.object({ tabId, title: tabTitle }),
      async (input) => {
        const tab = pickTab(await hub.workspace.read(), input.tabId);
        const result = await hub.workspace.apply({ op: "rename_tab", tabId: tab.id, title: input.title, source: "portal" }, "portal", context());
        return { tabId: tab.id, title: findTab(result.workspace, tab.id)?.title ?? null, path: tabPath(tab.id), ...(result.changed ? {} : { note: "It already had that name." }) };
      },
    ),
  };
}
