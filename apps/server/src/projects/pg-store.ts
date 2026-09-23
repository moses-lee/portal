/**
 * Postgres backend for the projects store: one row per listed project, one per removed record.
 * Moves between the two tables (remove with a record, revive) happen in one transaction so a
 * project is never in both or neither.
 */
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { projects, removedProjects } from "../db/schema.ts";
import type { Project, RemovedProject } from "../lib/types.ts";
import { type ProjectsBackend, type ProjectsStore, createProjectsStoreOn } from "./store.ts";

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    ...(row.worktree ? { worktree: row.worktree } : {}),
  };
}

function toRemoved(row: typeof removedProjects.$inferSelect): RemovedProject {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    ...(row.worktree ? { worktree: row.worktree } : {}),
    removedAt: row.removedAt,
    ...(row.parentPath !== null ? { parentPath: row.parentPath } : {}),
  };
}

function projectRow(project: Project): typeof projects.$inferInsert {
  return { id: project.id, name: project.name, path: project.path, createdAt: project.createdAt, worktree: project.worktree ?? null };
}

export function createPgProjectsBackend(db: Db): ProjectsBackend {
  return {
    async load() {
      const [listed, gone] = await Promise.all([
        db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.ordinal)),
        db.select().from(removedProjects),
      ]);
      return { projects: listed.map(toProject), removed: gone.map(toRemoved) };
    },
    async insert(project) {
      await db.insert(projects).values(projectRow(project));
    },
    async rename(id, name) {
      await db.update(projects).set({ name }).where(eq(projects.id, id));
    },
    async remove(id, record) {
      await db.transaction(async (tx) => {
        await tx.delete(projects).where(eq(projects.id, id));
        if (!record) return;
        const row = { ...projectRow(record), removedAt: record.removedAt, parentPath: record.parentPath ?? null };
        await tx.insert(removedProjects).values(row).onConflictDoUpdate({ target: removedProjects.id, set: row });
      });
    },
    async revive(project) {
      await db.transaction(async (tx) => {
        await tx.delete(removedProjects).where(eq(removedProjects.id, project.id));
        await tx.insert(projects).values(projectRow(project));
      });
    },
    async forgetRemoved(id) {
      await db.delete(removedProjects).where(eq(removedProjects.id, id));
    },
  };
}

export function createPgProjectsStore({ db, home }: { db: Db; home?: string }): ProjectsStore {
  return createProjectsStoreOn(createPgProjectsBackend(db), { home });
}
