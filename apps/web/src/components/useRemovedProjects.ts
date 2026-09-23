"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary, RemovedProjectSummary } from "@/lib/types";

const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";

async function readError(r: Response, fallback: string) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error ?? fallback);
}

export type UseRemovedProjects = {
  /** Removed projects most recent first, then conversations whose project left no record. */
  removed: RemovedProjectSummary[];
  /** Message from the last failed list fetch; cleared by a successful one. */
  error: string | null;
  /** Refetch the list. Never rejects; failures land in `error`. */
  refresh: () => Promise<void>;
  /** `POST /api/projects/removed/[id]/restore`. Resolves with the restored project; rejects with the server's message. */
  restore: (id: string) => Promise<ProjectSummary>;
  /** `DELETE /api/projects/removed/[id]`: deletes the row's conversations and forgets the project. */
  discard: (id: string) => Promise<void>;
};

/** The Removed view's rows and their two actions; refetches when the tab becomes visible again. */
export function useRemovedProjects(): UseRemovedProjects {
  const [removed, setRemoved] = useState<RemovedProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    let next: RemovedProjectSummary[] | null = null;
    let message: string | null = null;
    try {
      const r = await fetch("/api/projects/removed");
      if (!r.ok) throw await readError(r, "Could not load removed projects.");
      next = ((await r.json()) as { removed: RemovedProjectSummary[] }).removed;
    } catch (e) {
      message = e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not load removed projects. Check the server and try again.";
    }
    if (!mountedRef.current || request !== requestRef.current) return;
    if (next) setRemoved(next);
    setError(message);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const load = async () => {
      await refresh();
    };
    void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const restore = useCallback(async (id: string) => {
    let r: Response;
    try {
      r = await fetch(`/api/projects/removed/${encodeURIComponent(id)}/restore`, { method: "POST" });
    } catch {
      throw new Error(NETWORK_ERROR);
    }
    if (!r.ok) throw await readError(r, "Could not restore the project. Try again.");
    const { project } = (await r.json()) as { project: ProjectSummary };
    setRemoved((prev) => prev.filter((row) => row.id !== id));
    return project;
  }, []);

  const discard = useCallback(async (id: string) => {
    let r: Response;
    try {
      r = await fetch(`/api/projects/removed/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      throw new Error(NETWORK_ERROR);
    }
    if (!r.ok && r.status !== 404) throw await readError(r, "Could not delete the conversations. Try again.");
    setRemoved((prev) => prev.filter((row) => row.id !== id));
  }, []);

  return { removed, error, refresh, restore, discard };
}
