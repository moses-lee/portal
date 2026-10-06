"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import type { PaneNode, Tab, Workspace, WorkspaceLocation, WorkspaceOp } from "@portal/contracts/workspace";
import { applyWorkspaceOp, EMPTY_WORKSPACE, locateSession, WorkspaceError } from "@portal/shared/workspace";
import { usePortalEvents } from "./portal/PortalLive";
import { useSessions } from "./SessionsProvider";
import { tabFromPath } from "@/lib/session-routes";
import {
  advancedSessions,
  idAliases,
  signalsOf,
  temporaryIds,
  unreadAfter,
  unreadTabIds,
  visiblePaneIds,
  withoutUnread,
  type SessionSignal,
} from "@/lib/workspace";
import type { FocusScope } from "@/lib/workspace-mobile";

/** What the device is looking at (decision 6: per device, from the URL, never stored). */
export type WorkspaceFocus = {
  tabId: string | null;
  paneId: string | null;
  /** The focused pane's session; on `/sessions/<id>` while it resolves, that id. */
  sessionId: string | null;
  tab: Tab | null;
  pane: PaneNode | null;
  /**
   * Which of the tab's panes the device shows: all of them (`tab`), or only the focused one (`pane`:
   * a phone, or a tablet tab too big for a split). The others count as hidden for unread.
   */
  scope: FocusScope;
};

export const NO_FOCUS: WorkspaceFocus = { tabId: null, paneId: null, sessionId: null, tab: null, pane: null, scope: "tab" };

export type WorkspaceApplied = {
  /** The server's workspace after the op. */
  workspace: Workspace;
  /** Where an `open`, `replace_pane` or `arrange` put things, with the server's ids. */
  location: WorkspaceLocation | null;
};

export type WorkspaceContextValue = {
  /** The workspace every device shares, as last heard from the server (or as this device just edited it). */
  workspace: Workspace;
  /** True once `GET /api/workspace` or the stream has answered; the resolvers wait for it. */
  loaded: boolean;
  /** The last refused or failed op's message, until dismissed or the next op succeeds. */
  error: string | null;
  dismissError: () => void;
  /**
   * Apply one op: the shared reducer runs at once with temporary ids (the view updates), the op is
   * posted, and the server's copy replaces the guess. A refusal rolls the guess back, sets `error`
   * and rejects with the server's message.
   */
  apply: (op: WorkspaceOp) => Promise<WorkspaceApplied>;
  /** Where a session is open, or null. */
  locate: (sessionId: string) => WorkspaceLocation | null;
  /** What the workspace view reports it is showing; `NO_FOCUS` off the workspace (Portal, the terminal). */
  focus: WorkspaceFocus;
  /** The workspace view's business: it reads the URL and reports here for the shell (sidebar, inspector, title). */
  setFocus: (focus: WorkspaceFocus) => void;
  /** Tabs with news since they were last focused (decision 10 and 30); in memory only. */
  unread: ReadonlySet<string>;
  /** The panes with news since the device last showed them: the source of `unread`, and the sheet's row markers on a phone. */
  unreadPanes: ReadonlySet<string>;
  markRead: (tabId: string) => void;
  /**
   * The key to render a tab, split or pane under: the id this device first saw it with. A pane opened
   * here keeps its optimistic key once the server's id lands, so it does not remount.
   */
  keyOf: (id: string) => string;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const OPS_URL = "/api/workspace/ops";

/**
 * The workspace for the whole app (docs/WORKSPACE.md, "Web / State"): one REST read so it does not
 * wait for the stream, the portal stream's `workspace` event to keep it current (the stream's copy
 * wins over a slower read, the tracked pattern), optimistic `apply`, the focus the view reports, and
 * unread tabs derived from the session list's patches. Needs `PortalLiveProvider` and
 * `SessionsProvider` above it.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { sessions } = useSessions();
  const [workspace, setWorkspaceState] = useState<Workspace>(EMPTY_WORKSPACE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<WorkspaceFocus>(NO_FOCUS);
  const [unreadPanes, setUnreadPanes] = useState<ReadonlySet<string>>(() => new Set());
  /** The current workspace, for handlers that must not close over a stale render. */
  const workspaceRef = useRef(workspace);
  /** Set once the stream has delivered a copy: a slower REST read must not overwrite it then. */
  const fromStreamRef = useRef(false);
  /** The optimistic workspace of the op in flight, to pair the server's ids with its temporary ones. */
  const pendingRef = useRef<Workspace | null>(null);
  /** Server id to the key this device first rendered the node under (see `keyOf`); only grows. */
  const aliasesRef = useRef(new Map<string, string>());
  const [nextTemporaryId] = useState(temporaryIds);

  const setWorkspace = useCallback((next: Workspace) => {
    workspaceRef.current = next;
    setWorkspaceState(next);
  }, []);

  /** Take a copy from the server (the stream or an op's answer), unless a newer one is already held. */
  const adopt = useCallback(
    (server: Workspace) => {
      const pending = pendingRef.current;
      if (pending) for (const [serverId, key] of idAliases(pending, server)) aliasesRef.current.set(serverId, key);
      if (server.version < workspaceRef.current.version) return;
      setWorkspace(server);
    },
    [setWorkspace],
  );

  // One REST read; the stream's copy, when it got here first, is the fresher one. A server without
  // the route answers 404: the workspace then stays empty until the stream says otherwise.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/workspace", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) return;
        const { workspace: fetched } = (await r.json()) as { workspace: Workspace };
        if (controller.signal.aborted || fromStreamRef.current) return;
        adopt(fetched);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    return () => controller.abort();
  }, [adopt]);
  usePortalEvents((event) => {
    if (event.type !== "workspace") return;
    fromStreamRef.current = true;
    adopt(event.workspace);
    setLoaded(true);
  });

  const apply = useCallback(
    async (op: WorkspaceOp): Promise<WorkspaceApplied> => {
      const base = workspaceRef.current;
      let guess: ReturnType<typeof applyWorkspaceOp>;
      try {
        guess = applyWorkspaceOp(base, op, nextTemporaryId);
      } catch (e) {
        const message = e instanceof WorkspaceError ? e.message : "Could not change the workspace.";
        setError(message);
        throw new Error(message);
      }
      // Nothing to change (a rename to the same title, a resize to the same sizes): no round trip.
      if (!guess.changed) return { workspace: base, location: guess.location ?? null };
      pendingRef.current = guess.workspace;
      setWorkspace(guess.workspace);
      const rollback = () => {
        // Only undo our own guess: a copy the stream delivered since stays.
        if (workspaceRef.current === guess.workspace) setWorkspace(base);
      };
      let r: Response;
      try {
        r = await fetch(OPS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(op),
        });
      } catch {
        rollback();
        pendingRef.current = null;
        const message = "Could not reach the server. Check the connection and try again.";
        setError(message);
        throw new Error(message);
      }
      if (!r.ok) {
        rollback();
        pendingRef.current = null;
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        const message = j.error ?? "Could not change the workspace. Try again.";
        setError(message);
        throw new Error(message);
      }
      const answer = (await r.json()) as { workspace: Workspace; location?: WorkspaceLocation | null };
      adopt(answer.workspace);
      pendingRef.current = null;
      setError(null);
      return { workspace: answer.workspace, location: answer.location ?? guess.location ?? null };
    },
    [adopt, nextTemporaryId, setWorkspace],
  );

  const locate = useCallback((sessionId: string) => locateSession(workspace, sessionId), [workspace]);
  const keyOf = useCallback((id: string) => aliasesRef.current.get(id) ?? id, []);
  const dismissError = useCallback(() => setError(null), []);
  const markRead = useCallback(
    (tabId: string) =>
      setUnreadPanes((prev) => withoutUnread(prev, visiblePaneIds(workspaceRef.current, tabId, null))),
    [],
  );

  // Unread (decision 30): the session list's patches say when a turn ended or a permission request
  // appeared; the pane holding that session is marked unless the device shows it. The tab comes
  // from the URL, not from the reported focus, so the mark is never set for the tab being looked
  // at; which of its panes show (all, or only the focused one on a phone) is the view's report.
  const focusedTabId = useMemo(() => tabFromPath(pathname ?? "/")?.tabId ?? null, [pathname]);
  const onePane = focus.scope === "pane";
  const reportedTabId = focus.tabId;
  const reportedPaneId = focus.paneId;
  const visible = useMemo(() => {
    if (!onePane) return visiblePaneIds(workspace, focusedTabId, null);
    // The report lags the URL by a render; while they disagree, nothing is shown for certain (so no mark is cleared early).
    return reportedTabId === focusedTabId ? visiblePaneIds(workspace, focusedTabId, reportedPaneId) : new Set<string>();
  }, [workspace, focusedTabId, onePane, reportedTabId, reportedPaneId]);
  const signalsRef = useRef<ReadonlyMap<string, SessionSignal> | null>(null);
  useEffect(() => {
    const next = signalsOf(sessions);
    const previous = signalsRef.current;
    signalsRef.current = next;
    if (!previous) return;
    const advanced = advancedSessions(previous, next);
    if (advanced.length === 0) return;
    setUnreadPanes((prev) => unreadAfter(prev, workspaceRef.current, advanced, visible));
  }, [sessions, visible]);
  // Showing a pane reads it: derived during render, the way the Portal page clears a thread's mark.
  const read = withoutUnread(unreadPanes, visible);
  if (read !== unreadPanes) setUnreadPanes(read);
  const unread = useMemo(() => unreadTabIds(workspace, unreadPanes), [workspace, unreadPanes]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspace, loaded, error, dismissError, apply, locate, focus, setFocus, unread, unreadPanes, markRead, keyOf }),
    [workspace, loaded, error, dismissError, apply, locate, focus, unread, unreadPanes, markRead, keyOf],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace needs a WorkspaceProvider above it.");
  return value;
}
