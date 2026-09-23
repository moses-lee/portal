"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, ProjectSummary } from "@/lib/types";

export type AddProjectInput = { path: string; name?: string };

/** Options for removing a worktree project; ignored for other projects. */
export type RemoveProjectOptions = {
  /** Run `git worktree remove` (and delete the branch when fully merged) before dropping the record. */
  deleteWorktree?: boolean;
  /** Remove the worktree even when it has uncommitted changes. */
  force?: boolean;
};

/** A failed project request, with the server's status and its `dirty` flag for a worktree that refused removal. */
export class ProjectRequestError extends Error {
  status: number;
  dirty: boolean;
  constructor(message: string, status: number, dirty = false) {
    super(message);
    this.name = "ProjectRequestError";
    this.status = status;
    this.dirty = dirty;
  }
}

export type UseProjects = {
  /** Creation order, as served by `GET /api/projects`. */
  projects: ProjectSummary[];
  /** True until the first fetch settles. */
  loading: boolean;
  /** Message from the last failed list fetch; cleared by a successful one. */
  error: string | null;
  /**
   * `POST /api/projects`. Resolves with the created project, or with the existing one when the
   * server answers 409 for a duplicate path (merged into state either way). Rejects with an Error
   * carrying the server's message on any other failure.
   */
  addProject: (input: AddProjectInput) => Promise<Project>;
  /** `PATCH /api/projects/[id]`. Rejects with the server's message. */
  renameProject: (id: string, name: string) => Promise<Project>;
  /**
   * `DELETE /api/projects/[id]`, with `?worktree=delete[&force=1]` per `opts`. Sessions stay.
   * Rejects with a `ProjectRequestError` carrying the server's message (and `dirty` for a 409).
   */
  removeProject: (id: string, opts?: RemoveProjectOptions) => Promise<void>;
  /** Refetch the list. Never rejects; failures land in `error`. */
  refresh: () => Promise<void>;
};

const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";

/** A freshly created/renamed project until `refresh` fills in the presentation fields. */
function placeholder(project: Project, previous?: ProjectSummary): ProjectSummary {
  return { ...previous, ...project, displayPath: previous?.displayPath ?? project.path, git: previous?.git ?? null, exists: previous?.exists ?? true };
}

async function readError(r: Response, fallback: string) {
  const j = (await r.json().catch(() => ({}))) as { error?: string; dirty?: boolean };
  return new ProjectRequestError(j.error ?? fallback, r.status, j.dirty === true);
}

/** The project list and its mutations; refetches when the tab becomes visible again. */
export function useProjects(): UseProjects {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    let next: ProjectSummary[] | null = null;
    let message: string | null = null;
    try {
      const r = await fetch("/api/projects");
      if (!r.ok) throw await readError(r, "Could not load projects. Reload the page to retry.");
      next = ((await r.json()) as { projects: ProjectSummary[] }).projects;
    } catch (e) {
      message = e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not load projects. Check the server and reload the page to retry.";
    }
    // A newer refresh already answered; let it win.
    if (!mountedRef.current || request !== requestRef.current) return;
    if (next) setProjects(next);
    setError(message);
    setLoading(false);
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

  const merge = useCallback((project: Project) => {
    setProjects((prev) => {
      const index = prev.findIndex((p) => p.id === project.id);
      if (index === -1) return [...prev, placeholder(project)];
      return prev.map((p, i) => (i === index ? placeholder(project, p) : p));
    });
  }, []);

  const addProject = useCallback(async (input: AddProjectInput) => {
    let r: Response;
    try {
      r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch {
      throw new Error(NETWORK_ERROR);
    }
    if (r.status === 409) {
      const j = (await r.json().catch(() => ({}))) as { error?: string; project?: Project };
      if (!j.project) throw new Error(j.error ?? "That folder is already a project.");
      merge(j.project);
      await refresh();
      return j.project;
    }
    if (!r.ok) throw await readError(r, "Could not add the project. Try again.");
    const project = (await r.json()) as Project;
    merge(project);
    await refresh();
    return project;
  }, [merge, refresh]);

  const renameProject = useCallback(async (id: string, name: string) => {
    let r: Response;
    try {
      r = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch {
      throw new Error(NETWORK_ERROR);
    }
    if (!r.ok) throw await readError(r, "Could not rename the project. Try again.");
    const project = (await r.json()) as Project;
    merge(project);
    await refresh();
    return project;
  }, [merge, refresh]);

  const removeProject = useCallback(async (id: string, opts: RemoveProjectOptions = {}) => {
    const params = new URLSearchParams();
    if (opts.deleteWorktree) {
      params.set("worktree", "delete");
      if (opts.force) params.set("force", "1");
    }
    const query = params.size ? `?${params}` : "";
    let r: Response;
    try {
      r = await fetch(`/api/projects/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
    } catch {
      throw new Error(NETWORK_ERROR);
    }
    if (!r.ok && r.status !== 404) throw await readError(r, "Could not remove the project. Try again.");
    setProjects((prev) => prev.filter((p) => p.id !== id));
    await refresh();
  }, [refresh]);

  return { projects, loading, error, addProject, renameProject, removeProject, refresh };
}
