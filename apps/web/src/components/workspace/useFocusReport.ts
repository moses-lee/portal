"use client";

import { useEffect, useState } from "react";

/** How often a device repeats what it shows; the server forgets a report after 90 s. */
export const FOCUS_HEARTBEAT_MS = 30_000;

/**
 * Tell the server which session this browser tab shows in its focused pane, and whether the tab is
 * visible (`POST /api/workspace/focus`), on every change and as a heartbeat. A watch does not
 * report a session event the user watched happen (docs/WATCHES.md). Each tab is its own device.
 */
export function useFocusReport(sessionId: string | null): void {
  const [deviceId] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
  useEffect(() => {
    const report = () => {
      void fetch("/api/workspace/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, sessionId, visible: document.visibilityState === "visible" }),
        keepalive: true,
      }).catch(() => {});
    };
    report();
    const timer = window.setInterval(report, FOCUS_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", report);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
    };
  }, [deviceId, sessionId]);
}
