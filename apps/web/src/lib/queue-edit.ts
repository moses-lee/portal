// Which queued prompt a session's composer is editing, kept beside the draft (see `./drafts`): it
// belongs to this browser tab and survives a reload, so the edit (and the server's pause) is not
// orphaned by a refresh. Keyed by session id; every view of the session in this tab shares it.
const edits = new Map<string, string | null>();
const listeners = new Set<() => void>();
const prefix = "portal.queue-edit.v1:";

/** The id of the queued prompt being edited in `sessionId`'s composer, or null. */
export function readEditing(sessionId: string): string | null {
  const cached = edits.get(sessionId);
  if (cached !== undefined) return cached;
  let value: string | null = null;
  try {
    value = sessionStorage.getItem(prefix + sessionId);
  } catch {
    /* Storage is optional. */
  }
  edits.set(sessionId, value);
  return value;
}

export function writeEditing(sessionId: string, itemId: string | null) {
  if (readEditing(sessionId) === itemId) return;
  edits.set(sessionId, itemId);
  try {
    if (itemId) sessionStorage.setItem(prefix + sessionId, itemId);
    else sessionStorage.removeItem(prefix + sessionId);
  } catch {
    /* The in-memory copy survives session navigation. */
  }
  for (const listener of listeners) listener();
}

export function subscribeEditing(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
