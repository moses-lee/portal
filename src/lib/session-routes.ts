/**
 * Browser routes: `/` is the start page, `/sessions/<id>` opens one session, and `/terminal` is
 * the standalone terminal page (shells that belong to no session).
 */

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;
const TERMINAL_PATH = /^\/terminal\/?$/;

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
