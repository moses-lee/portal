// Drafts belong to this browser tab. Keep an in-memory fallback when storage is unavailable.
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
const prefix = "portal.draft.v1:";

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
