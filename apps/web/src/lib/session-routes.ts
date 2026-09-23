/**
 * Browser routes: `/` is the start page, `/sessions/<id>` opens one session, `/terminal` is the
 * standalone terminal page (shells that belong to no session), and `/portal` is Talk to Portal
 * (the orchestrator's one thread).
 */

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const TERMINAL_PATH = /^\/terminal\/?$/;
const PORTAL_PATH = /^\/portal\/?$/;

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

export function portalPath(): string {
  return "/portal";
}
