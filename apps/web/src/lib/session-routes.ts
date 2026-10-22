/** Workspace URLs. Non-session surfaces live only in local UI state. The Portal helpers below
 * encode destinations in stored model replies; those strings are dispatched as UI actions and
 * are not public browser routes. */

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const TERMINAL_PATH = /^\/terminal\/?$/;
/** `/new`, and home: `/` opens the start page too (docs/GLASS.md, Home). */
const START_PATH = /^\/(?:new\/?)?$/;
const PALACE_LINK_PATH = /^\/(?:palace\/?)?$/;
const TAB_PATH = /^\/tabs\/([^/]+)\/?$/;
const PANE_PARAM = "pane";

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

/** The start page: a new conversation in a project, at `/new` or home (`/`). */
export function isStartPath(pathname: string): boolean {
  return START_PATH.test(pathname);
}

export function startPath(): string {
  return "/new";
}

/** The tab's path, with the focused pane when given: `/tabs/<tabId>` or `/tabs/<tabId>?pane=<paneId>`. */
export function tabPath(tabId: string, paneId?: string | null): string {
  const path = `/tabs/${encodeURIComponent(tabId)}`;
  return paneId ? `${path}?${new URLSearchParams({ [PANE_PARAM]: paneId })}` : path;
}

export function isTabPath(pathname: string): boolean {
  return TAB_PATH.test(pathname);
}

/** The tab a path names and, from the query string (with or without the `?`), its focused pane; null off a tab path. */
export function tabFromPath(pathname: string, search = ""): { tabId: string; paneId: string | null } | null {
  const match = TAB_PATH.exec(pathname);
  if (!match) return null;
  const tabId = decodeSegment(match[1]);
  if (!tabId) return null;
  return { tabId, paneId: new URLSearchParams(search).get(PANE_PARAM) || null };
}

/**
 * Where a workspace path points: a tab (the focused pane is the query's business, read by the view),
 * or one of the two resolvers, the start page (`/new` or `/`) and a session (`/sessions/<id>`). Null
 * for the stored Portal destinations and the terminal.
 */
export type WorkspaceRoute =
  | { kind: "tab"; tabId: string }
  | { kind: "start" }
  | { kind: "session"; sessionId: string };

export function workspaceRoute(pathname: string): WorkspaceRoute | null {
  const tab = tabFromPath(pathname);
  if (tab) return { kind: "tab", tabId: tab.tabId };
  if (isStartPath(pathname)) return { kind: "start" };
  const sessionId = sessionIdFromPath(pathname);
  return sessionId === null ? null : { kind: "session", sessionId };
}

/**
 * The in-app path a link in a Portal reply points at (`/tabs/<id>` or `/sessions/<id>`, as a path or
 * a URL on `origin`), so the renderer navigates in place instead of opening a new browser tab; null
 * for every other link. With no `origin` known yet (server rendering), only paths qualify.
 */
export function inAppLinkPath(href: string, origin: string | null): string | null {
  let pathname: string;
  let search = "";
  if (href.startsWith("/")) {
    const query = href.indexOf("?");
    pathname = query === -1 ? href : href.slice(0, query);
    search = query === -1 ? "" : href.slice(query);
    const hash = search.indexOf("#");
    if (hash !== -1) search = search.slice(0, hash);
    const pathHash = pathname.indexOf("#");
    if (pathHash !== -1) pathname = pathname.slice(0, pathHash);
  } else {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (origin === null || url.origin !== origin) return null;
    pathname = url.pathname;
    search = url.search;
  }
  if (!isTabPath(pathname) && sessionIdFromPath(pathname) === null && !isSurfaceLinkPath(pathname)) return null;
  return `${pathname}${isTabPath(pathname) ? search : ""}`;
}

/** `/sessions/<id>`, `/new` and `/`: paths the shell rewrites to a tab path once the workspace has loaded (`/` stays while it is empty). */
export function isResolverPath(pathname: string): boolean {
  return isStartPath(pathname) || sessionIdFromPath(pathname) !== null;
}

/** True for every path the workspace view renders: a tab, or one of the resolvers. */
export function isWorkspacePath(pathname: string): boolean {
  return isTabPath(pathname) || isResolverPath(pathname);
}

export type PortalView = "chat" | "attention" | "watches" | "activity" | "memory" | "system" | "monitoring";
export const portalViews: readonly PortalView[] = ["chat", "attention", "watches", "activity", "memory", "system", "monitoring"];

/** Where a Portal path points; unknown paths land on the chat. */
export type PortalLocation =
  | { view: "chat" }
  | { view: "memory"; entityId: string | null; runId?: string | null }
  | { view: "attention" | "watches" | "activity" | "system" | "monitoring" };

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Decode an internal surface destination. These are actions, not browser pages. */
export function portalLocation(pathname: string): PortalLocation {
  return routeOf(pathname);
}

function routeOf(pathname: string): PortalLocation {
  const segments = pathname.split("/").filter(Boolean);
  const [head, second] = segments;
  if (head === "memory" && second === "curation" && segments.length <= 3) {
    return { view: "memory", entityId: null, runId: segments[2] ? decodeSegment(segments[2]) : null };
  }
  if (head === "memory" && segments.length <= 2) return { view: "memory", entityId: second ? decodeSegment(second) : null };
  if ((head === "attention" || head === "watches" || head === "activity" || head === "system" || head === "monitoring") && segments.length === 1) return { view: head };
  return { view: "chat" };
}

/** Encode a destination for stored replies and the surface dispatcher. */
export function portalPath(to: PortalLocation | PortalView = "chat"): string {
  return routePath(to);
}

/** A view's root: Memory is the list. */
function viewLocation(view: PortalView): PortalLocation {
  return view === "memory" ? { view: "memory", entityId: null } : { view };
}

function routePath(to: PortalLocation | PortalView): string {
  const location = typeof to === "string" ? viewLocation(to) : to;
  switch (location.view) {
    case "chat":
      // Not `/`: in stored links that is Palace mode now.
      return "/chat";
    case "memory":
      if (location.runId !== undefined) return location.runId ? `/memory/curation/${encodeURIComponent(location.runId)}` : "/memory/curation";
      return location.entityId ? `/memory/${encodeURIComponent(location.entityId)}` : "/memory";
    default:
      return `/${location.view}`;
  }
}

/**
 * `/` and `/palace` in a stored Agent reply or item body: they opened the Palace page, which became
 * Palace mode (docs/GLASS.md, Home), so the link enters it.
 */
export function isPalaceLinkPath(pathname: string): boolean {
  return PALACE_LINK_PATH.test(pathname);
}

/** Destinations supported in stored Agent replies and item bodies; these never become browser routes. */
export function isSurfaceLinkPath(pathname: string): boolean {
  return /^(?:\/|\/(?:chat|attention|watches|activity|system|monitoring|palace|terminal)\/?|\/memory(?:\/[^/]+|\/curation(?:\/[^/]+)?)?\/?)$/.test(pathname);
}
