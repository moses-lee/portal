/**
 * How many browsers currently hold a Portal event stream open. Every long-lived SSE route
 * (`/api/sessions/stream`, `/api/portal/stream`) registers itself here so the orchestrator's
 * scheduler can tell an attended Portal from an idle one. Process-wide, HMR-safe.
 */
type Listener = (count: number) => void;

type PresenceState = { count: number; listeners: Set<Listener> };

const globalPresence = globalThis as unknown as { __portalPresence?: PresenceState };
const state: PresenceState = (globalPresence.__portalPresence ??= { count: 0, listeners: new Set() });

function notify() {
  for (const listener of state.listeners) {
    try { listener(state.count); } catch {}
  }
}

export const presence = {
  count(): number {
    return state.count;
  },
  /** Marks one connection open; call the returned function exactly once when it closes. */
  open(): () => void {
    state.count += 1;
    notify();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      state.count = Math.max(0, state.count - 1);
      notify();
    };
  },
  subscribe(listener: Listener): () => void {
    state.listeners.add(listener);
    return () => { state.listeners.delete(listener); };
  },
};
