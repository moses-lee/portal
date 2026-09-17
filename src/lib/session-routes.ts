/** Browser routes: `/` is the start page and `/sessions/<id>` opens one session. */

const SESSION_PATH = /^\/sessions\/([^/]+)\/?$/;

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
