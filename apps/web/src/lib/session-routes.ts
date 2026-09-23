/**
 * Browser routes: `/` is the start page, `/sessions/<id>` opens one session, `/terminal` is the
 * standalone terminal page (shells that belong to no session), and `/portal/**` is Talk to Portal:
 * `/portal` the main thread, `/portal/threads/<id>` one of the agent's side threads, and
 * `/portal/goals`, `/portal/activity`, `/portal/memory[/<entityId>]`, `/portal/system` its views;
 * `/portal/memory/curation[/<runId>]` is memory curation: its runs, or one run's digest and diff.
 */

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const TERMINAL_PATH = /^\/terminal\/?$/;
const PORTAL_PATH = /^\/portal(?:\/.*)?$/;

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

export function isPortalPath(pathname: string): boolean {
  return PORTAL_PATH.test(pathname);
}

export type PortalView = "chat" | "goals" | "activity" | "memory" | "system";
export const portalViews: readonly PortalView[] = ["chat", "goals", "activity", "memory", "system"];

/** Where a Talk to Portal path points; unknown sub-paths land on the main thread. */
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
  const segments = pathname.replace(/^\/portal\/?/, "").split("/").filter(Boolean);
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

/** The path for a view, a thread (the main thread is plain `/portal`), a memory entity, or a curation run. */
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
      return location.threadId === "main" ? "/portal" : `/portal/threads/${encodeURIComponent(location.threadId)}`;
    case "memory":
      if (location.runId !== undefined) return location.runId ? `/portal/memory/curation/${encodeURIComponent(location.runId)}` : "/portal/memory/curation";
      return location.entityId ? `/portal/memory/${encodeURIComponent(location.entityId)}` : "/portal/memory";
    default:
      return `/portal/${location.view}`;
  }
}
