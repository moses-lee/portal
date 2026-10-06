// Drafts belong to this browser tab. Keep an in-memory fallback when storage is unavailable.
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
const prefix = "portal.draft.v1:";

/**
 * The draft key of a start page: one per start-page pane (`paneKey` is the key the device renders the
 * pane under, so it survives the server replacing an optimistic id), and `new` for the bare start page
 * of an empty workspace. Also names the pane in the shell's per-pane creating and error state.
 */
export function startKey(paneKey: string | null): string {
  return paneKey === null ? "new" : `new:${paneKey}`;
}

export function readDraft(id: string): string {
  const cached = drafts.get(id);
  if (cached !== undefined) return cached;
  let value = "";
  try {
    value = sessionStorage.getItem(prefix + id) ?? "";
  } catch {
    /* Storage is optional. */
  }
  drafts.set(id, value);
  return value;
}

export function writeDraft(id: string, value: string) {
  drafts.set(id, value);
  try {
    if (value) sessionStorage.setItem(prefix + id, value);
    else sessionStorage.removeItem(prefix + id);
  } catch {
    /* The in-memory draft survives session navigation. */
  }
  for (const listener of listeners) listener();
}

export function clearSubmittedDraft(id: string, submitted: string) {
  // A request may resolve after the user has started writing their next message.
  if (readDraft(id) === submitted) writeDraft(id, "");
}

export function subscribeDrafts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
