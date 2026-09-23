/**
 * How many browsers currently hold a Portal event stream open. Every long-lived SSE route
 * (`/api/sessions/stream`, `/api/portal/stream`) registers itself here so the orchestrator's
 * scheduler can tell an attended Portal from an idle one. One counter per app, created in
 * `buildApp` and kept on the context, so apps built side by side (tests) keep their own counts.
 */
type Listener = (count: number) => void;

export type Presence = {
  count(): number;
  /** Marks one connection open; call the returned function exactly once when it closes. */
  open(): () => void;
  subscribe(listener: Listener): () => void;
};

export function createPresence(): Presence {
  let count = 0;
  const listeners = new Set<Listener>();

  function notify() {
    for (const listener of listeners) {
      try { listener(count); } catch {}
    }
  }

  return {
    count: () => count,
    open() {
      count += 1;
      notify();
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        count = Math.max(0, count - 1);
        notify();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
