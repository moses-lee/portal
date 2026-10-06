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
  opIds,
  replayIds,
  rewriteOpIds,
  signalsOf,
  temporaryIds,
  unreadAfter,
  unreadTabIds,
  visiblePaneIds,
  withoutUnread,
  type OpOutcome,
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
  /**
   * True while an op this device applied is in flight: the workspace shows the guess, and the
   * caller's navigation to the result is still to come. The resolvers wait for it too, or a start
   * page that just opened a session would see a workspace without a start pane and open another.
   */
  pending: boolean;
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
  /**
   * The key to render a tab, split or pane under: the id this device first saw it with. A pane opened
   * here keeps its optimistic key once the server's id lands, so it does not remount.
   */
  keyOf: (id: string) => string;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const OPS_URL = "/api/workspace/ops";
const isTemporaryId = (id: string) => id.startsWith("tmp-");

/** One op on its way to the server: what it was applied to, the ids it made up (in the order it drew them) and its guess. */
type InFlight = { op: WorkspaceOp; base: Workspace; made: string[]; guess: OpOutcome };

/**
 * The workspace for the whole app (docs/WORKSPACE.md, "Web / State"): one REST read so it does not
 * wait for the stream, the portal stream's `workspace` event to keep it current (the stream's copy
 * wins over a slower read, the tracked pattern), optimistic `apply`, the focus the view reports, and
 * unread tabs derived from the session list's patches. Needs `PortalLiveProvider` and
 * `SessionsProvider` above it.
 *
 * Optimistic ids: the shown workspace is the last copy the server gave (`truthRef`) with the ops in
 * flight replayed on it, each with the temporary ids it first drew. An op's answer pairs those ids
 * with the server's from the answer's own `location` (`idAliases`), so `keyOf` keeps the node's first
 * key and nothing remounts. The server pushes its stream copy before it answers the POST, so a copy
 * that lands while an op is in flight is held (newest wins) and adopted when the last op settles: shown
 * at once, its real ids would be keyed before the answer could pair them. An op that names an id
 * another op made up waits for that op's answer and posts the real id.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { sessions } = useSessions();
  const [workspace, setWorkspaceState] = useState<Workspace>(EMPTY_WORKSPACE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<WorkspaceFocus>(NO_FOCUS);
  const [unreadPanes, setUnreadPanes] = useState<ReadonlySet<string>>(() => new Set());
  /** Ops posted and not yet answered (`pending` is any). */
  const [inFlight, setInFlight] = useState(0);
  const inFlightRef = useRef(0);
  /** The current workspace, for handlers that must not close over a stale render. */
  const workspaceRef = useRef(workspace);
  /** The last copy the server gave (an answer, the stream, the REST read): what the guesses replay on. */
  const truthRef = useRef<Workspace>(EMPTY_WORKSPACE);
  /** A server copy that landed while an op was in flight, adopted once none is. */
  const heldRef = useRef<Workspace | null>(null);
  /** Set once the stream has delivered a copy: a slower REST read must not overwrite it then. */
  const fromStreamRef = useRef(false);
  /** The ops whose guesses still show, oldest first; an answer drops the answered op and every older one (the server applied those before it). */
  const replayRef = useRef<InFlight[]>([]);
  /** The last op posted: ops go out one at a time so the server applies them in the order they were made. */
  const lastPostRef = useRef<Promise<unknown>>(Promise.resolve());
  /** Server id to the key this device first rendered the node under (see `keyOf`); only grows. */
  const aliasesRef = useRef(new Map<string, string>());
  /** The reverse: a temporary id to the server's, once the answer said; for ops that name a temporary id. */
  const realIdsRef = useRef(new Map<string, string>());
  /** Each temporary id still unanswered to the op that made it, so an op naming it can wait for the real one. */
  const makersRef = useRef(new Map<string, Promise<unknown>>());
  const [nextTemporaryId] = useState(temporaryIds);

  const setWorkspace = useCallback((next: Workspace) => {
    workspaceRef.current = next;
    setWorkspaceState(next);
  }, []);

  const realOf = useCallback((id: string) => realIdsRef.current.get(id) ?? id, []);

  /** Show the truth with the guesses still in flight replayed on it; a replay the reducer refuses is left to its answer. */
  const render = useCallback(() => {
    let next = truthRef.current;
    for (const entry of replayRef.current) {
      try {
        next = applyWorkspaceOp(next, rewriteOpIds(entry.op, realOf), replayIds(entry.made, nextTemporaryId)).workspace;
      } catch {
        // Refused on the newer copy (its pane closed elsewhere): the server will say so, and the answer settles it.
      }
    }
    setWorkspace(next);
  }, [nextTemporaryId, realOf, setWorkspace]);

  /** Take a server copy as the truth unless a newer one is held already, and show it. */
  const adopt = useCallback(
    (server: Workspace) => {
      if (server.version < truthRef.current.version) return;
      truthRef.current = server;
      render();
    },
    [render],
  );

  /** A copy from the stream or the REST read: adopted now, or held until this device's ops have answered. */
  const receive = useCallback(
    (server: Workspace) => {
      if (inFlightRef.current === 0) return adopt(server);
      if (!heldRef.current || server.version > heldRef.current.version) heldRef.current = server;
    },
    [adopt],
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
        receive(fetched);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    return () => controller.abort();
  }, [receive]);
  usePortalEvents((event) => {
    if (event.type !== "workspace") return;
    fromStreamRef.current = true;
    receive(event.workspace);
    setLoaded(true);
  });

  const apply = useCallback(
    async (op: WorkspaceOp): Promise<WorkspaceApplied> => {
      const base = workspaceRef.current;
      const made: string[] = [];
      const drawIds = () => {
        const id = nextTemporaryId();
        made.push(id);
        return id;
      };
      let guess: ReturnType<typeof applyWorkspaceOp>;
      try {
        guess = applyWorkspaceOp(base, op, drawIds);
      } catch (e) {
        const message = e instanceof WorkspaceError ? e.message : "Could not change the workspace.";
        setError(message);
        throw new Error(message);
      }
      // Nothing to change (a rename to the same title, a resize to the same sizes): no round trip.
      if (!guess.changed) return { workspace: base, location: guess.location ?? null };
      const entry: InFlight = { op, base, made, guess: { workspace: guess.workspace, location: guess.location ?? null } };
      replayRef.current = [...replayRef.current, entry];
      setWorkspace(guess.workspace);
      inFlightRef.current += 1;
      setInFlight((n) => n + 1);
      const fail = (message: string): never => {
        // Only this op's guess goes: the others in flight, and a copy the stream delivered since, stay.
        replayRef.current = replayRef.current.filter((e) => e !== entry);
        render();
        setError(message);
        throw new Error(message);
      };
      const run = async (): Promise<WorkspaceApplied> => {
        try {
          // Ops post one at a time: the answer to an op stands in for every older one, which only
          // holds if the server applied them in order. An id another op made up: wait for that op's
          // answer, then post the server's id for it.
          await previous.catch(() => {});
          for (const id of opIds(op)) await makersRef.current.get(id)?.catch(() => {});
          const posted = rewriteOpIds(op, realOf);
          if (opIds(posted).some(isTemporaryId)) return fail("The pane this change needs was not created.");
          let r: Response;
          try {
            r = await fetch(OPS_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(posted),
            });
          } catch {
            return fail("Could not reach the server. Check the connection and try again.");
          }
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string };
            return fail(j.error ?? "Could not change the workspace. Try again.");
          }
          let answer: { workspace: Workspace; location?: WorkspaceLocation | null };
          try {
            answer = (await r.json()) as typeof answer;
            if (!answer || typeof answer !== "object" || !Array.isArray(answer.workspace?.tabs)) throw new Error("bad answer");
          } catch {
            // A 2xx with an unreadable body: the op may have landed; the next copy from the stream says.
            return fail("The server's answer could not be read. The workspace will catch up.");
          }
          const location = answer.location ?? null;
          const known = (id: string) => aliasesRef.current.has(id) || realIdsRef.current.has(id);
          for (const [serverId, key] of idAliases(base, entry.guess, { workspace: answer.workspace, location }, known)) {
            aliasesRef.current.set(serverId, key);
            realIdsRef.current.set(key, serverId);
          }
          // The answer holds this op and every older one; the newer ones replay on it.
          const index = replayRef.current.indexOf(entry);
          if (index >= 0) replayRef.current = replayRef.current.slice(index + 1);
          adopt(answer.workspace);
          setError(null);
          return { workspace: answer.workspace, location: location ?? entry.guess.location };
        } finally {
          for (const id of made) makersRef.current.delete(id);
          inFlightRef.current -= 1;
          setInFlight((n) => n - 1);
          if (inFlightRef.current === 0 && heldRef.current) {
            const held = heldRef.current;
            heldRef.current = null;
            adopt(held);
          }
        }
      };
      const previous = lastPostRef.current;
      const promise = run();
      lastPostRef.current = promise;
      for (const id of made) makersRef.current.set(id, promise);
      return promise;
    },
    [adopt, nextTemporaryId, realOf, render, setWorkspace],
  );

  const locate = useCallback((sessionId: string) => locateSession(workspace, sessionId), [workspace]);
  const keyOf = useCallback((id: string) => aliasesRef.current.get(id) ?? id, []);
  const dismissError = useCallback(() => setError(null), []);

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

  const pending = inFlight > 0;
  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspace, loaded, pending, error, dismissError, apply, locate, focus, setFocus, unread, unreadPanes, keyOf }),
    [workspace, loaded, pending, error, dismissError, apply, locate, focus, unread, unreadPanes, keyOf],
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace needs a WorkspaceProvider above it.");
  return value;
}
