import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDirectory } from "./fs-paths.ts";
import { displayPath, readGitInfo } from "./git-info.ts";
import type { Project, ProjectSummary, RemovedProject, WorktreeMeta } from "./types.ts";

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

export function defaultProjectsFile() {
  return path.join(process.env.PORTAL_HOME || path.join(os.homedir(), ".portal"), "projects.json");
}

/** `removed` holds projects taken out of the list while conversations still referenced them. */
type ProjectsFile = { version: 1; projects: Project[]; removed?: RemovedProject[] };

function isWorktreeMeta(value: unknown): value is WorktreeMeta {
  const w = value as Record<string, unknown> | null;
  return !!w && typeof w === "object" && typeof w.parentId === "string" && typeof w.branch === "string";
}

function isProject(value: unknown): value is Project {
  const p = value as Record<string, unknown> | null;
  return !!p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string"
    && typeof p.path === "string" && typeof p.createdAt === "number"
    && (p.worktree === undefined || isWorktreeMeta(p.worktree));
}

function isRemovedProject(value: unknown): value is RemovedProject {
  const r = value as Partial<RemovedProject>;
  return isProject(value) && typeof r.removedAt === "number" && (r.parentPath === undefined || typeof r.parentPath === "string");
}

/**
 * The listed projects, or null when the file is unreadable. Removed records are optional and
 * checked one by one: a bad one is dropped with a warning rather than taking the list down with it.
 */
function parseProjectsFile(text: string, file: string): { projects: Project[]; removed: RemovedProject[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const data = parsed as Partial<ProjectsFile> | null;
  if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.projects)) return null;
  if (!data.projects.every(isProject)) return null;
  const removed: RemovedProject[] = [];
  for (const entry of Array.isArray(data.removed) ? data.removed : []) {
    if (isRemovedProject(entry)) removed.push(entry);
    else console.warn(`Dropping an unreadable removed project from ${file}.`);
  }
  return { projects: data.projects, removed };
}

/**
 * Worktree projects used to be named "<parent> · <branch>"; the sidebar now marks them with a badge
 * naming the parent, so that prefix is redundant. Rename the ones that still carry the exact old
 * name to their branch (a name the user changed is left alone). Returns null when nothing changed.
 */
export function dropLegacyWorktreeNames(projects: Project[]): Project[] | null {
  const byId = new Map(projects.map((project) => [project.id, project]));
  let changed = false;
  const next = projects.map((project) => {
    if (!project.worktree) return project;
    const parent = byId.get(project.worktree.parentId);
    if (!parent || project.name !== `${parent.name} · ${project.worktree.branch}`) return project;
    changed = true;
    return { ...project, name: project.worktree.branch };
  });
  return changed ? next : null;
}

/** Attach the folder's display form and current state for the browser. */
export async function summarizeProject(project: Project): Promise<ProjectSummary> {
  const exists = await stat(project.path).then((info) => info.isDirectory(), () => false);
  // readGitInfo walks up to parent directories, so skip it once the folder itself is gone.
  const git = exists ? await readGitInfo(project.path) : null;
  return { ...project, displayPath: displayPath(project.path), git, exists };
}

/**
 * Persisted list of project folders. The whole file is rewritten atomically on every
 * change; memory is only updated after the write lands so the two never disagree.
 */
export function createProjectsStore({ file = defaultProjectsFile(), home = os.homedir() } = {}) {
  let projects = new Map<string, Project>();
  let removed = new Map<string, RemovedProject>();
  let corrupt = false;

  async function load() {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    const loaded = parseProjectsFile(text, file);
    if (!loaded) {
      console.warn(`Ignoring unreadable projects file ${file}; it will be backed up on the next change.`);
      corrupt = true;
      return;
    }
    projects = new Map(loaded.projects.map((project) => [project.id, project]));
    removed = new Map(loaded.removed.map((project) => [project.id, project]));
    const migrated = dropLegacyWorktreeNames(loaded.projects);
    if (!migrated) return;
    try {
      await save(new Map(migrated.map((project) => [project.id, project])), removed);
    } catch (err) {
      // Keep the new names for this run even if the file could not be rewritten.
      projects = new Map(migrated.map((project) => [project.id, project]));
      console.warn(`Could not rewrite ${file} with renamed worktree projects: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ready = load();

  async function save(next: Map<string, Project>, nextRemoved: Map<string, RemovedProject> = removed) {
    await mkdir(path.dirname(file), { recursive: true });
    if (corrupt) {
      // Keep the unreadable file for the user instead of silently overwriting it.
      await rename(file, `${file}.bad-${Date.now()}`).catch(() => {});
      corrupt = false;
    }
    const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
    const body: ProjectsFile = { version: 1, projects: [...next.values()] };
    if (nextRemoved.size > 0) body.removed = [...nextRemoved.values()];
    try {
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    projects = next;
    removed = nextRemoved;
  }

  // One chain for every mutation so concurrent adds never interleave their writes.
  let queue: Promise<unknown> = ready;
  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  function list(): Project[] {
    return [...projects.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  function get(id: string): Project | undefined {
    return projects.get(id);
  }

  function findByPath(realpath: string): Project | undefined {
    for (const project of projects.values()) if (project.path === realpath) return project;
    return undefined;
  }

  function require(id: string): Project {
    const project = projects.get(id);
    if (!project) throw new ProjectError("Unknown project.", 404);
    return project;
  }

  /** Removed projects, most recently removed first. */
  function listRemoved(): RemovedProject[] {
    return [...removed.values()].sort((a, b) => b.removedAt - a.removedAt);
  }

  function getRemoved(id: string): RemovedProject | undefined {
    return removed.get(id);
  }

  function findRemovedByPath(realpath: string): RemovedProject | undefined {
    for (const project of removed.values()) if (project.path === realpath) return project;
    return undefined;
  }

  /** Move a removed record back into the list, under its original id. Callers hold the mutation lock. */
  async function revive(record: RemovedProject, patch: { name?: string; worktree?: WorktreeMeta } = {}): Promise<Project> {
    const worktree = patch.worktree ?? record.worktree;
    const project: Project = {
      id: record.id,
      name: patch.name?.trim() || record.name,
      path: record.path,
      createdAt: record.createdAt,
      ...(worktree ? { worktree: { parentId: worktree.parentId, branch: worktree.branch } } : {}),
    };
    const nextRemoved = new Map(removed);
    nextRemoved.delete(project.id);
    await save(new Map(projects).set(project.id, project), nextRemoved);
    return project;
  }

  /**
   * Add a folder. A path that matches a removed project brings that project back instead (same id,
   * so its conversations regroup under it), taking the given name and worktree details when present.
   */
  function add({ path: input, name, worktree }: { path: string; name?: string; worktree?: WorktreeMeta }): Promise<Project> {
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
        ...(worktree ? { worktree: { parentId: worktree.parentId, branch: worktree.branch } } : {}),
      };
      await save(new Map(projects).set(project.id, project));
      return project;
    });
  }

  function renameProject(id: string, name: string): Promise<Project> {
    return mutate(async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new ProjectError("Project name cannot be empty.", 400);
      const project = { ...require(id), name: trimmed };
      await save(new Map(projects).set(id, project));
      return project;
    });
  }

  /**
   * Take a project out of the list. With `keep`, a removed record is written so the project can be
   * restored later (for when conversations still reference it); otherwise it is forgotten.
   */
  function remove(id: string, { keep = false } = {}): Promise<void> {
    return mutate(async () => {
      const project = require(id);
      const next = new Map(projects);
      next.delete(id);
      const nextRemoved = new Map(removed);
      if (keep) {
        const parent = project.worktree ? projects.get(project.worktree.parentId) : undefined;
        nextRemoved.set(id, { ...project, removedAt: Date.now(), ...(parent ? { parentPath: parent.path } : {}) });
      }
      await save(next, nextRemoved);
    });
  }

  /**
   * Bring a removed project back, optionally under corrected worktree details (a re-added parent has
   * a new id). Its folder must exist again; a project already covering it is a 409.
   */
  function restore(id: string, patch: { worktree?: WorktreeMeta } = {}): Promise<Project> {
    return mutate(async () => {
      const record = removed.get(id);
      if (!record) throw new ProjectError("Unknown removed project.", 404);
      const exists = await stat(record.path).then((info) => info.isDirectory(), () => false);
      if (!exists) throw new ProjectError(`Project folder is missing: ${displayPath(record.path)}`, 409);
      const existing = findByPath(record.path);
      if (existing) throw new ProjectError(`Already added as "${existing.name}".`, 409, existing);
      return revive(record, patch);
    });
  }

  /** Drop a removed record for good. Resolves false when there was none. */
  function forgetRemoved(id: string): Promise<boolean> {
    return mutate(async () => {
      if (!removed.has(id)) return false;
      const nextRemoved = new Map(removed);
      nextRemoved.delete(id);
      await save(projects, nextRemoved);
      return true;
    });
  }

  return { ready, list, get, findByPath, add, rename: renameProject, remove, listRemoved, getRemoved, restore, forgetRemoved };
}

export type ProjectsStore = ReturnType<typeof createProjectsStore>;
