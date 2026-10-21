/** Invalidation from the app's existing session list stream; no extra per-hook connections. */
const listeners = new Set<() => void>();

export function subscribeProjectChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyProjectChanges(): void {
  for (const listener of listeners) listener();
}
