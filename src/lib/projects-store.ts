import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDirectory } from "./fs-paths.ts";
import { displayPath, readGitInfo } from "./git-info.ts";
import type { Project, ProjectSummary, WorktreeMeta } from "./types.ts";

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

type ProjectsFile = { version: 1; projects: Project[] };

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

function parseProjectsFile(text: string): Project[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const file = parsed as Partial<ProjectsFile> | null;
  if (!file || typeof file !== "object" || file.version !== 1 || !Array.isArray(file.projects)) return null;
  return file.projects.every(isProject) ? file.projects : null;
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
  let corrupt = false;

  async function load() {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    const loaded = parseProjectsFile(text);
    if (!loaded) {
      console.warn(`Ignoring unreadable projects file ${file}; it will be backed up on the next change.`);
      corrupt = true;
      return;
    }
    projects = new Map(loaded.map((project) => [project.id, project]));
  }
  const ready = load();

  async function save(next: Map<string, Project>) {
    await mkdir(path.dirname(file), { recursive: true });
    if (corrupt) {
      // Keep the unreadable file for the user instead of silently overwriting it.
      await rename(file, `${file}.bad-${Date.now()}`).catch(() => {});
      corrupt = false;
    }
    const tmp = `${file}.tmp-${randomUUID().slice(0, 8)}`;
    const body: ProjectsFile = { version: 1, projects: [...next.values()] };
    try {
      await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    projects = next;
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

  function add({ path: input, name, worktree }: { path: string; name?: string; worktree?: WorktreeMeta }): Promise<Project> {
    return mutate(async () => {
      const real = await resolveDirectory(input, home);
      const existing = findByPath(real);
      if (existing) throw new ProjectError(`Already added as "${existing.name}".`, 409, existing);
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

  function remove(id: string): Promise<void> {
    return mutate(async () => {
      require(id);
      const next = new Map(projects);
      next.delete(id);
      await save(next);
    });
  }

  return { ready, list, get, findByPath, add, rename: renameProject, remove };
}

export type ProjectsStore = ReturnType<typeof createProjectsStore>;
