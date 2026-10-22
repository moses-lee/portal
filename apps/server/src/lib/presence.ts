/**
 * How many browsers currently hold a Portal event stream open. Every long-lived SSE route
 * (`/api/sessions/stream`, `/api/portal/stream`) registers itself here so the orchestrator's
 * scheduler can tell an attended Portal from an idle one. One counter per app, created in
 * `buildApp` and kept on the context, so apps built side by side (tests) keep their own counts.
 */
type Listener = (count: number) => void;

/** How long a device's report of what it shows holds without a heartbeat. */
export const FOCUS_TTL_MS = 90_000;

/** What one device shows: the session in its focused pane (null for none) and whether its window is visible. */
export type DeviceFocus = { sessionId: string | null; visible: boolean };

export type Presence = {
  count(): number;
  /** Marks one connection open; call the returned function exactly once when it closes. */
  open(): () => void;
  subscribe(listener: Listener): () => void;
  /** A device reports what it shows (on every change and as a heartbeat). */
  focus(deviceId: string, focus: DeviceFocus): void;
  /** Whether some device shows `sessionId` in its focused pane, visible, as of a report still fresh. */
  watching(sessionId: string): boolean;
};

export function createPresence({ now = Date.now }: { now?: () => number } = {}): Presence {
  let count = 0;
  const listeners = new Set<Listener>();
  const devices = new Map<string, DeviceFocus & { at: number }>();

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
    focus(deviceId, focus) {
      devices.set(deviceId, { ...focus, at: now() });
    },
    watching(sessionId) {
      const t = now();
      for (const [deviceId, device] of devices) {
        if (t - device.at > FOCUS_TTL_MS) {
          devices.delete(deviceId);
          continue;
        }
        if (device.visible && device.sessionId === sessionId) return true;
      }
      return false;
    },
  };
}
