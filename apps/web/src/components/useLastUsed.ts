"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyLastUsed,
  type LastUsedAgents,
  type LastUsedPatch,
} from "@/lib/session-config";

export type UseLastUsed = {
  /** The agent and per-agent settings the user last picked (`GET /api/last-used`); null until loaded. */
  lastUsed: LastUsedAgents | null;
  /** Apply `patch` here at once and `PATCH /api/last-used`; a failed save only costs the memory. */
  save(patch: LastUsedPatch): void;
};

/**
 * The server's record of the last agent and agent settings the user picked, for the start page.
 * Loaded on mount and again whenever `refresh` turns true (opening the start page), since a
 * session's Agent settings dialog updates the record on the server.
 */
export function useLastUsed(refresh: boolean): UseLastUsed {
  const [lastUsed, setLastUsed] = useState<LastUsedAgents | null>(null);
  /** Counts local saves; a load that started before one does not overwrite it. */
  const saves = useRef(0);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current && !refresh) return;
    const controller = new AbortController();
    const at = saves.current;
    void fetch("/api/last-used", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return ((await r.json()) as { lastUsed: LastUsedAgents }).lastUsed;
      })
      .then(
        (next) => {
          loaded.current = true;
          if (saves.current === at) setLastUsed(next);
        },
        () => {
          // Without the record the start page falls back to the defaults; it must not wait forever.
          if (controller.signal.aborted) return;
          loaded.current = true;
          setLastUsed((previous) => previous ?? emptyLastUsed);
        },
      );
    return () => controller.abort();
  }, [refresh]);

  const save = useCallback((patch: LastUsedPatch) => {
    saves.current++;
    setLastUsed((previous) => ({
      agentId: patch.agentId ?? previous?.agentId ?? null,
      settings: { ...previous?.settings, ...patch.settings },
    }));
    void fetch("/api/last-used", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);

  return { lastUsed, save };
}
