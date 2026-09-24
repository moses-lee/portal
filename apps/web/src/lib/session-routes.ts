/**
 * Browser routes. Portal, the orchestrator, is the home: `/` is its main thread, `/threads/<id>` one
 * of the side threads it opened, and `/goals`, `/activity`, `/memory[/<entityId>]`, `/system` its
 * views; `/memory/curation[/<runId>]` is memory curation: its runs, or one run's digest and diff.
 * `/new` is the start page (a new conversation in a project), `/sessions/<id>` opens one session,
 * and `/terminal` is the standalone terminal page (shells that belong to no session).
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

export type PortalView = "chat" | "goals" | "activity" | "memory" | "system";
export const portalViews: readonly PortalView[] = ["chat", "goals", "activity", "memory", "system"];

/** Where a Portal path points; unknown paths land on the main thread. */
export type PortalLocation =
  | { view: "chat"; threadId: string }
  /** `runId` present: the curation pane (null lists the runs, an id shows one). */
  | { view: "memory"; entityId: string | null; runId?: string | null }
  | { view: "goals" | "activity" | "system" };

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function portalLocation(pathname: string): PortalLocation {
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
  if ((head === "goals" || head === "activity" || head === "system") && segments.length === 1) return { view: head };
  return { view: "chat", threadId: "main" };
}

/** The path for a view, a thread (the main thread is the home, `/`), a memory entity, or a curation run. */
export function portalPath(to: PortalLocation | PortalView = "chat"): string {
  const location: PortalLocation =
    typeof to === "string"
      ? to === "chat"
        ? { view: "chat", threadId: "main" }
        : to === "memory"
          ? { view: "memory", entityId: null }
          : { view: to }
      : to;
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
