/**
 * The projects store: the listed project folders plus the removed records kept while conversations
 * still point at them. Callers on hot paths (the session list, the SSE meta poll) look projects up
 * synchronously, so every backend keeps the whole set in memory, loaded once at `ready` and updated
 * only after a write has landed. The backend (Postgres, or nothing for the memory store) is the
 * source of truth; the server is its only writer, so the cache never goes stale.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDirectory } from "../lib/fs-paths.ts";
import { displayPath, readGitInfo } from "../lib/git-info.ts";
import type { Project, ProjectSummary, RemovedProject, WorktreeMeta } from "../lib/types.ts";

/** A project operation the caller got wrong; `project` is set on a 409 so the UI can select it. */
export class ProjectError extends Error {
  status: number;
  project?: Project;
  constructor(message: string, status: number, project?: Project) {
    super(message);
    this.name = "ProjectError";
    this.status = status;
    this.project = project;
  }
}

export interface ProjectsStore {
  /** Resolves once the cache is loaded; `get`/`list` answer from it synchronously afterwards. */
  ready: Promise<void>;
  /** Listed projects in the order they were added (restored ones return to their original slot). */
  list(): Project[];
  get(id: string): Project | undefined;
  findByPath(realpath: string): Project | undefined;
  /**
   * Add a folder. A path that matches a removed project brings that project back instead (same id,
   * so its conversations regroup under it), taking the given name and worktree details when present.
   */
  add(input: { path: string; name?: string; worktree?: WorktreeMeta }): Promise<Project>;
  rename(id: string, name: string): Promise<Project>;
  /**
   * Take a project out of the list. With `keep`, a removed record is written so the project can be
   * restored later (for when conversations still reference it); otherwise it is forgotten.
   */
  remove(id: string, opts?: { keep?: boolean }): Promise<void>;
  /** Removed projects, most recently removed first. */
  listRemoved(): RemovedProject[];
  getRemoved(id: string): RemovedProject | undefined;
  /**
   * Bring a removed project back, optionally under corrected worktree details (a re-added parent has
   * a new id). Its folder must exist again; a project already covering it is a 409.
   */
  restore(id: string, patch?: { worktree?: WorktreeMeta }): Promise<Project>;
  /** Drop a removed record for good. Resolves false when there was none. */
  forgetRemoved(id: string): Promise<boolean>;
}

/**
 * Where a store keeps its records. Each call is one atomic change; the store updates its cache only
 * after the returned promise resolves, and runs one call at a time.
 */
export interface ProjectsBackend {
  load(): Promise<{ projects: Project[]; removed: RemovedProject[] }>;
  insert(project: Project): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Delete the project and, when given, write its removed record in the same change. */
  remove(id: string, record: RemovedProject | null): Promise<void>;
  /** Delete the removed record and insert `project` (same id) in the same change. */
  revive(project: Project): Promise<void>;
  forgetRemoved(id: string): Promise<void>;
}

/** Attach the folder's display form and current state for the browser. */
export async function summarizeProject(project: Project): Promise<ProjectSummary> {
  const exists = await stat(project.path).then((info) => info.isDirectory(), () => false);
  // readGitInfo walks up to parent directories, so skip it once the folder itself is gone.
  const git = exists ? await readGitInfo(project.path) : null;
  return { ...project, displayPath: displayPath(project.path), git, exists };
}

/** Only the two known worktree fields, so extra keys a caller passed never reach the backend. */
function cleanWorktree(worktree: WorktreeMeta | undefined): { worktree?: WorktreeMeta } {
  return worktree ? { worktree: { parentId: worktree.parentId, branch: worktree.branch } } : {};
}

/** Listed order: by creation time, ties in insertion order (Array#sort is stable over Map order). */
function byCreation(a: Project, b: Project): number {
  return a.createdAt - b.createdAt;
}

/** The store logic over any backend. `home` is what a leading `~` in an added path expands to. */
export function createProjectsStoreOn(backend: ProjectsBackend, { home = os.homedir() }: { home?: string } = {}): ProjectsStore {
  let projects = new Map<string, Project>();
  let removed = new Map<string, RemovedProject>();

  const ready = backend.load().then((loaded) => {
    projects = new Map([...loaded.projects].sort(byCreation).map((project) => [project.id, project]));
    removed = new Map(loaded.removed.map((record) => [record.id, record]));
  });
  // Awaiters of `ready` still see a failed load; this only keeps an unobserved one from crashing the process.
  ready.catch(() => {});

  // One chain for every mutation so a path check and the write it guards never interleave with another add.
  let queue: Promise<unknown> = ready;
  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  function findByPath(realpath: string): Project | undefined {
    for (const project of projects.values()) if (project.path === realpath) return project;
    return undefined;
  }

  function findRemovedByPath(realpath: string): RemovedProject | undefined {
    for (const record of removed.values()) if (record.path === realpath) return record;
    return undefined;
  }

  function require(id: string): Project {
    const project = projects.get(id);
    if (!project) throw new ProjectError("Unknown project.", 404);
    return project;
  }

  /** Move a removed record back into the list, under its original id. Callers hold the mutation lock. */
  async function revive(record: RemovedProject, patch: { name?: string; worktree?: WorktreeMeta } = {}): Promise<Project> {
    const project: Project = {
      id: record.id,
      name: patch.name?.trim() || record.name,
      path: record.path,
      createdAt: record.createdAt,
      ...cleanWorktree(patch.worktree ?? record.worktree),
    };
    await backend.revive(project);
    removed.delete(project.id);
    projects.set(project.id, project);
    projects = new Map([...projects.values()].sort(byCreation).map((p) => [p.id, p]));
    return project;
  }

  return {
    ready,
    list: () => [...projects.values()],
    get: (id) => projects.get(id),
    findByPath,
    add({ path: input, name, worktree }) {
      return mutate(async () => {
        const real = await resolveDirectory(input, home);
        const existing = findByPath(real);
        if (existing) throw new ProjectError(`Already added as "${existing.name}".`, 409, existing);
        const tombstone = findRemovedByPath(real);
        if (tombstone) return revive(tombstone, { name, worktree });
        const project: Project = {
          id: randomUUID(),
          name: name?.trim() || path.basename(real) || real,
          path: real,
          createdAt: Date.now(),
          ...cleanWorktree(worktree),
        };
        await backend.insert(project);
        projects.set(project.id, project);
        return project;
      });
    },
    rename(id, name) {
      return mutate(async () => {
        const trimmed = name.trim();
        if (!trimmed) throw new ProjectError("Project name cannot be empty.", 400);
        const project = { ...require(id), name: trimmed };
        await backend.rename(id, trimmed);
        // Replacing the value keeps the key's position, so the list order is unchanged.
        projects.set(id, project);
        return project;
      });
    },
    remove(id, { keep = false } = {}) {
      return mutate(async () => {
        const project = require(id);
        let record: RemovedProject | null = null;
        if (keep) {
          const parent = project.worktree ? projects.get(project.worktree.parentId) : undefined;
          record = { ...project, removedAt: Date.now(), ...(parent ? { parentPath: parent.path } : {}) };
        }
        await backend.remove(id, record);
        projects.delete(id);
        if (record) removed.set(id, record);
      });
    },
    listRemoved: () => [...removed.values()].sort((a, b) => b.removedAt - a.removedAt),
    getRemoved: (id) => removed.get(id),
    restore(id, patch = {}) {
      return mutate(async () => {
        const record = removed.get(id);
        if (!record) throw new ProjectError("Unknown removed project.", 404);
        const exists = await stat(record.path).then((info) => info.isDirectory(), () => false);
        if (!exists) throw new ProjectError(`Project folder is missing: ${displayPath(record.path)}`, 409);
        const existing = findByPath(record.path);
        if (existing) throw new ProjectError(`Already added as "${existing.name}".`, 409, existing);
        return revive(record, patch);
      });
    },
    forgetRemoved(id) {
      return mutate(async () => {
        if (!removed.has(id)) return false;
        await backend.forgetRemoved(id);
        removed.delete(id);
        return true;
      });
    },
  };
}

/** A store that keeps everything in memory, optionally seeded; for tests of code that needs projects. */
export function createMemoryProjectsStore(
  { projects = [], removed = [], home }: { projects?: Project[]; removed?: RemovedProject[]; home?: string } = {},
): ProjectsStore {
  const noop = async () => {};
  return createProjectsStoreOn({
    load: async () => ({ projects, removed }),
    insert: noop,
    rename: noop,
    remove: noop,
    revive: noop,
    forgetRemoved: noop,
  }, { home });
}
