/**
 * Browser routes. Portal, the orchestrator, is the home: `/` is its main thread, `/threads/<id>` one
 * of the side threads it opened, and `/attention`, `/watches`, `/activity`, `/memory[/<entityId>]`, `/system` its
 * views; `/memory/curation[/<runId>]` is memory curation: its runs, or one run's digest and diff.
 * `/new` is the start page (a new conversation in a project), `/sessions/<id>` opens one session,
 * and `/terminal` is the standalone terminal page (shells that belong to no session).
 *
 * Any Portal path may carry `?session=<id>`: the session the tracked-sessions panel shows beside the
 * view. Switching Portal views keeps it; leaving Portal (a session page, the terminal, `/new`) drops it.
 */

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const TERMINAL_PATH = /^\/terminal\/?$/;
const START_PATH = /^\/new\/?$/;

export function sessionIdFromPath(pathname: string): string | null {
  const match = SESSION_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

export function isTerminalPath(pathname: string): boolean {
  return TERMINAL_PATH.test(pathname);
}

export function terminalPath(): string {
  return "/terminal";
}

/** The start page: a new conversation in a project. */
export function isStartPath(pathname: string): boolean {
  return START_PATH.test(pathname);
}

export function startPath(): string {
  return "/new";
}

/** Every path that is not a session, the terminal, or the start page is Portal's: a view, or the main thread. */
export function isPortalPath(pathname: string): boolean {
  return sessionIdFromPath(pathname) === null && !isTerminalPath(pathname) && !isStartPath(pathname);
}

export type PortalView = "chat" | "attention" | "watches" | "activity" | "memory" | "system";
export const portalViews: readonly PortalView[] = ["chat", "attention", "watches", "activity", "memory", "system"];

/** Where a Portal path points; unknown paths land on the main thread. */
export type PortalLocation = (
  | { view: "chat"; threadId: string }
  /** `runId` present: the curation pane (null lists the runs, an id shows one). */
  | { view: "memory"; entityId: string | null; runId?: string | null }
  | { view: "attention" | "watches" | "activity" | "system" }
) & {
  /** The session the tracked panel shows (`?session=`); absent or null when it shows its list. */
  session?: string | null;
};

const PANEL_SESSION_PARAM = "session";

/** The panel's session from a query string (`?session=<id>`, with or without the `?`); null when absent or empty. */
export function panelSessionFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(PANEL_SESSION_PARAM) || null;
}

/** `pathname` with the panel's session set (an id) or cleared (null); other query params are not kept. */
export function withPanelSession(pathname: string, sessionId: string | null): string {
  return sessionId ? `${pathname}?${new URLSearchParams({ [PANEL_SESSION_PARAM]: sessionId })}` : pathname;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Where a Portal path points; `search` (the query string) adds the panel's session when it names one. */
export function portalLocation(pathname: string, search = ""): PortalLocation {
  const location = routeOf(pathname);
  const session = panelSessionFromSearch(search);
  return session ? { ...location, session } : location;
}

function routeOf(pathname: string): PortalLocation {
  const segments = pathname.split("/").filter(Boolean);
  const [head, second] = segments;
  if (head === "threads" && second && segments.length === 2) {
    const id = decodeSegment(second);
    if (id) return { view: "chat", threadId: id };
  }
  if (head === "memory" && second === "curation" && segments.length <= 3) {
    return { view: "memory", entityId: null, runId: segments[2] ? decodeSegment(segments[2]) : null };
  }
  if (head === "memory" && segments.length <= 2) return { view: "memory", entityId: second ? decodeSegment(second) : null };
  if ((head === "attention" || head === "watches" || head === "activity" || head === "system") && segments.length === 1) return { view: head };
  // Watches were "Goals" until 2026-10-04; old links and bookmarks still land there.
  if (head === "goals" && segments.length === 1) return { view: "watches" };
  return { view: "chat", threadId: "main" };
}

/**
 * The path for a view, a thread (the main thread is the home, `/`), a memory entity, or a curation
 * run; with `?session=` when the location names the panel's session.
 */
export function portalPath(to: PortalLocation | PortalView = "chat"): string {
  const path = routePath(to);
  return typeof to === "string" ? path : withPanelSession(path, to.session ?? null);
}

/**
 * `portalPath(to)`, keeping the panel's session named by `search` (the current query string) unless
 * `to` says otherwise (`session` set, or null to close it). Switching Portal views goes through this.
 */
export function portalPathKeepingPanel(to: PortalLocation | PortalView, search: string): string {
  const location = typeof to === "string" ? viewLocation(to) : to;
  return portalPath(location.session !== undefined ? location : { ...location, session: panelSessionFromSearch(search) });
}

/** A view's root: Chat is the main thread, Memory the list. */
function viewLocation(view: PortalView): PortalLocation {
  return view === "chat" ? { view: "chat", threadId: "main" } : view === "memory" ? { view: "memory", entityId: null } : { view };
}

function routePath(to: PortalLocation | PortalView): string {
  const location = typeof to === "string" ? viewLocation(to) : to;
  switch (location.view) {
    case "chat":
      return location.threadId === "main" ? "/" : `/threads/${encodeURIComponent(location.threadId)}`;
    case "memory":
      if (location.runId !== undefined) return location.runId ? `/memory/curation/${encodeURIComponent(location.runId)}` : "/memory/curation";
      return location.entityId ? `/memory/${encodeURIComponent(location.entityId)}` : "/memory";
    default:
      return `/${location.view}`;
  }
}
