/**
 * `/api/projects/**` and `/api/fs/dirs`, with the URLs, validation, statuses and JSON shapes the web
 * app's Next.js routes had.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.ts";
import { errorMessage, errorStatus } from "../http/errors.ts";
import { rejectCrossOrigin } from "../http/origin.ts";
import { listDirectories, resolveDirectory } from "../lib/fs-paths.ts";
import { displayPath, readGitInfo } from "../lib/git-info.ts";
import { pullFastForward, readCommitPage, readGithubSummary } from "../lib/github-summary.ts";
import { type ProjectLookup, type RemovedFacts, parentOf, projectIdOfRow, summarizeOrphans, summarizeRemoved } from "../lib/removed-projects.ts";
import { preWorktreeDeleteRun, runConfiguredScript } from "../lib/script-runner.ts";
import type { BranchListing, Project, RemovedProject, RemovedProjectSummary, WorktreeMeta } from "../lib/types.ts";
import {
  WorktreeError, ensureWorktree, getPull, hasBranch, listBranches, listPulls, mainWorktreeOf, removeWorktree, repoRootOf,
} from "../lib/worktrees.ts";
import { type ProjectError, summarizeProject } from "./store.ts";

type IdParams = { Params: { id: string } };

/** The first value of a query parameter, as `URLSearchParams#get` gave the web routes. */
function query(req: FastifyRequest, name: string): string | null {
  const value = (req.query as Record<string, string | string[] | undefined>)[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** The parsed JSON body as a plain object, or null (absent, or not an object) for the caller's 400. */
function bodyObject(req: FastifyRequest): Record<string, unknown> | null {
  const body = req.body;
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function fail(reply: FastifyReply, err: unknown) {
  return reply.code(errorStatus(err) ?? 500).send({ error: errorMessage(err) });
}

const isDirectory = (dir: string) => stat(dir).then((info) => info.isDirectory(), () => false);

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const worktreesDir = () => path.join(ctx.config.portalHome, "worktrees");
  const lookup: ProjectLookup & { displayPath: typeof displayPath } = {
    project: (id) => ctx.projects.get(id),
    projectByPath: (realpath) => ctx.projects.findByPath(realpath),
    removed: (id) => ctx.projects.getRemoved(id),
    displayPath,
  };

  /** Directory browser backend for the add-project dialog; only subdirectories are exposed. */
  app.get("/api/fs/dirs", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const input = (query(req, "path") ?? "").trim() || "~";
    const hidden = query(req, "hidden") === "1";
    try {
      return await listDirectories(await resolveDirectory(input), { hidden });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/projects", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    return { projects: await Promise.all(ctx.projects.list().map(summarizeProject)) };
  });

  app.post("/api/projects", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const body = bodyObject(req);
    if (!body) return reply.code(400).send({ error: "Expected a JSON object." });
    const { path: dir, name } = body;
    if (typeof dir !== "string" || !dir.trim()) return reply.code(400).send({ error: "Path is required." });
    if (name !== undefined && typeof name !== "string") return reply.code(400).send({ error: "Name must be a string." });
    try {
      return reply.code(201).send(await ctx.projects.add({ path: dir.trim(), name }));
    } catch (err) {
      const project = err instanceof Error ? (err as Partial<ProjectError>).project : undefined;
      return reply.code(errorStatus(err) ?? 500).send(project ? { error: errorMessage(err), project } : { error: errorMessage(err) });
    }
  });

  // Static `removed` segments win over `:id` in Fastify's router, as the Next.js folders did.
  /** Removed projects (most recent first) followed by conversations whose project left no record. */
  app.get("/api/projects/removed", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await Promise.all([ctx.projects.ready, ctx.sessions.ready]);
    const sessions = ctx.sessions.listSessions();
    const removed: RemovedProjectSummary[] = await Promise.all(
      ctx.projects.listRemoved().map(async (record) =>
        summarizeRemoved(record, await gatherFacts(record), sessions.filter((s) => s.projectId === record.id), lookup),
      ),
    );
    const orphans = summarizeOrphans(
      sessions,
      (projectId) => !!ctx.projects.get(projectId) || !!ctx.projects.getRemoved(projectId),
      displayPath,
    );
    return { removed: [...removed, ...orphans] };
  });

  /** Delete every conversation still pointing at a removed project, then forget the project. */
  app.delete<IdParams>("/api/projects/removed/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await Promise.all([ctx.projects.ready, ctx.sessions.ready]);
    const { id } = req.params;
    if (ctx.projects.get(id)) return reply.code(409).send({ error: "This project is still listed." });
    const projectId = projectIdOfRow(id);
    try {
      for (const session of ctx.sessions.listSessions().filter((s) => s.projectId === projectId)) {
        if (await ctx.sessions.deleteSession(session.id)) ctx.terminals.closeSession(session.id);
      }
      await ctx.projects.forgetRemoved(id);
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
    return reply.code(204).send();
  });

  /** Bring a removed project back, recreating its worktree first when the folder is gone. */
  app.post<IdParams>("/api/projects/removed/:id/restore", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const { id } = req.params;
    const record = ctx.projects.getRemoved(id);
    if (!record) return reply.code(404).send({ error: "Unknown removed project." });
    try {
      const exists = await isDirectory(record.path);
      let worktree = record.worktree;
      if (worktree) {
        // A parent that was re-added since has a new id; the restored project should point at it.
        const parent = exists ? parentOf({ ...record, worktree }, lookup) : requireParent({ ...record, worktree });
        if (parent && parent.id !== worktree.parentId) worktree = { parentId: parent.id, branch: worktree.branch };
        if (!exists) await recreateWorktree({ ...record, worktree }, parent!);
      } else if (!exists) {
        return reply.code(409).send({ error: `Project folder is missing: ${displayPath(record.path)}` });
      }
      const project = await ctx.projects.restore(id, worktree && worktree !== record.worktree ? { worktree } : {});
      return { project: await summarizeProject(project) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<IdParams>("/api/projects/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const name = bodyObject(req)?.name;
    if (typeof name !== "string") return reply.code(400).send({ error: "Expected {name}." });
    try {
      return await ctx.projects.rename(req.params.id, name);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<IdParams>("/api/projects/:id", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const { id } = req.params;
    const deleteWorktree = query(req, "worktree") === "delete";
    const force = query(req, "force") === "1";
    const project = ctx.projects.get(id);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    try {
      if (deleteWorktree) {
        if (!project.worktree) return reply.code(400).send({ error: "This project is not a worktree." });
        await deleteWorktreeFolder({ ...project, worktree: project.worktree }, force);
      }
      // Sessions created from this project keep running. While any exist, the project is kept as a
      // removed record so the Removed view can bring it (and them) back; otherwise it is forgotten.
      await ctx.sessions.ready;
      const keep = ctx.sessions.listSessions().some((session) => session.projectId === id);
      await ctx.projects.remove(id, { keep });
      return reply.code(204).send();
    } catch (err) {
      const dirty = err instanceof Error && (err as { dirty?: unknown }).dirty === true;
      return reply.code(errorStatus(err) ?? 500).send(dirty ? { error: errorMessage(err), dirty: true } : { error: errorMessage(err) });
    }
  });

  app.get<IdParams>("/api/projects/:id/branches", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const project = ctx.projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    try {
      const root = await repoRootOf(project.path);
      // Listing never fetches; it reports what the repository already knows plus gh's view of open PRs.
      const [branches, pulls, main] = await Promise.all([listBranches(root), listPulls(root), mainWorktreeOf(root)]);
      // New worktrees are filed under the main checkout's name even when listing from a worktree.
      const repoWorktreesDir = displayPath(path.join(worktreesDir(), path.basename(main)));
      const listing: BranchListing = { ...branches, ...pulls, repoWorktreesDir };
      return listing;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string; number: string } }>("/api/projects/:id/pulls/:number", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const { id, number: raw } = req.params;
    const number = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(number) || number <= 0) return reply.code(400).send({ error: "PR number must be a positive integer." });
    const project = ctx.projects.get(id);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    try {
      return { pull: await getPull(await repoRootOf(project.path), number) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** The GitHub panel's snapshot for a project; `?fetch=1` runs `git fetch origin --prune` first. */
  app.get<IdParams>("/api/projects/:id/github", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const project = ctx.projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    const fetch = query(req, "fetch") === "1";
    try {
      // Large snapshots are gzipped by the global compress plugin.
      return { summary: await readGithubSummary(project.path, { fetch }) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** One page of older commits from `?before=<cursor>`, a cursor handed out by the summary or a previous page. */
  app.get<IdParams>("/api/projects/:id/github/log", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const before = query(req, "before");
    if (!before) return reply.code(400).send({ error: "before must be a log cursor from a previous page." });
    const project = ctx.projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    try {
      return await readCommitPage(project.path, before);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** `git pull --ff-only` in the project's checkout; git's refusal comes back as a 409 `{error}`. */
  app.post<IdParams>("/api/projects/:id/github/pull", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const project = ctx.projects.get(req.params.id);
    if (!project) return reply.code(404).send({ error: "Unknown project." });
    try {
      return { summary: await pullFastForward(project.path) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Find or create a worktree of the project's repository for `branch` and return the project that
   * lives in it (201 when the project is new, 200 when one already covered that folder). Works from
   * the main checkout and from any worktree project of the same repository; the new project points
   * at the original project either way.
   */
  app.post<IdParams>("/api/projects/:id/worktrees", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    await ctx.projects.ready;
    const body = bodyObject(req);
    if (!body) return reply.code(400).send({ error: "Expected a JSON object." });
    const { branch, create } = body;
    if (typeof branch !== "string" || !branch.trim()) return reply.code(400).send({ error: "Branch is required." });
    if (create !== undefined && typeof create !== "boolean") return reply.code(400).send({ error: "create must be a boolean." });
    const from = ctx.projects.get(req.params.id);
    if (!from) return reply.code(404).send({ error: "Unknown project." });
    // Worktrees of a worktree belong to the original project while it is still listed.
    const parentId = from.worktree && ctx.projects.get(from.worktree.parentId) ? from.worktree.parentId : from.id;
    try {
      const root = await repoRootOf(from.path);
      // Worktree folders are named after the main checkout, wherever the request started.
      const worktree = await ensureWorktree({ repoRoot: await mainWorktreeOf(root), branch: branch.trim(), create: create === true, worktreesDir: worktreesDir() });
      // A project rooted in a subfolder of the repo gets the same subfolder inside the worktree.
      const projectPath = path.join(worktree.path, path.relative(root, from.path));
      const existing = ctx.projects.findByPath(projectPath);
      if (existing) return { project: await summarizeProject(existing) };
      let project: Project;
      try {
        project = await ctx.projects.add({ path: projectPath, name: branch.trim(), worktree: { parentId, branch: branch.trim() } });
      } catch (err) {
        // Lost a race with a concurrent request for the same branch: that project is the answer.
        const raced = err instanceof Error ? (err as Partial<ProjectError>).project : undefined;
        if (raced) return { project: await summarizeProject(raced) };
        if (errorStatus(err) === 404) return reply.code(409).send({ error: `The worktree has no ${displayPath(projectPath)} folder.` });
        throw err;
      }
      return reply.code(201).send({ project: await summarizeProject(project) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** What restoring `record` would need: its folder, or (for a worktree) the parent's repository and the branch. */
  async function gatherFacts(record: RemovedProject): Promise<RemovedFacts> {
    const exists = await isDirectory(record.path);
    if (exists || !record.worktree) return { exists, branchExists: null, parentExists: null };
    const parent = parentOf(record, lookup);
    if (!parent) return { exists, branchExists: null, parentExists: null };
    const parentExists = await isDirectory(parent.path);
    if (!parentExists) return { exists, branchExists: null, parentExists };
    const root = (await readGitInfo(parent.path))?.root;
    const branchExists = root ? await hasBranch(root, record.worktree.branch).catch(() => false) : false;
    return { exists, branchExists, parentExists };
  }

  /** The listed parent of a removed worktree project, or the 409 that explains its absence. */
  function requireParent(record: RemovedProject & { worktree: WorktreeMeta }): Project {
    const parent = parentOf(record, lookup);
    if (parent) return parent;
    const parentRecord = ctx.projects.getRemoved(record.worktree.parentId);
    throw new WorktreeError(parentRecord ? `Restore ${parentRecord.name} first.` : "Its original project was removed from Portal.", 409);
  }

  /**
   * Recreate the worktree behind a removed worktree project at the folder its conversations expect.
   * `ensureWorktree` puts a branch back under `worktrees/<repo>/<branch>`, which is where the project
   * was created, so the recorded path reappears unless the branch is checked out elsewhere by now or
   * the repository folder was renamed; a checkout created somewhere else is removed again rather than
   * left behind untracked.
   */
  async function recreateWorktree(record: RemovedProject & { worktree: WorktreeMeta }, parent: Project) {
    const root = await repoRootOf(parent.path);
    const repoRoot = await mainWorktreeOf(root);
    const worktree = await ensureWorktree({ repoRoot, branch: record.worktree.branch, worktreesDir: worktreesDir() });
    if (await isDirectory(record.path)) return;
    if (worktree.created) {
      await removeWorktree({ repoRoot, path: worktree.path, branch: "", force: true }).catch(() => {});
    }
    throw new WorktreeError(
      `Branch ${record.worktree.branch} ${worktree.created ? "would be checked out" : "is checked out"} at ${displayPath(worktree.path)}, not at ${displayPath(record.path)} where its conversations ran.`,
      409,
    );
  }

  /**
   * Remove the worktree folder behind a worktree project. The git commands run in the main checkout,
   * found through the parent project or, when that is gone, through the worktree's own `.git` file.
   * A folder that has already disappeared only needs its registration pruned.
   */
  async function deleteWorktreeFolder(project: Project & { worktree: WorktreeMeta }, force: boolean) {
    const exists = await stat(project.path).then(() => true, () => false);
    // The project may sit in a subfolder of the worktree; git needs the worktree's root.
    const worktreeRoot = exists ? (await readGitInfo(project.path))?.root ?? null : null;
    const parent = ctx.projects.get(project.worktree.parentId);
    let repoRoot: string | null = null;
    if (parent && await stat(parent.path).then(() => true, () => false)) {
      repoRoot = (await readGitInfo(parent.path))?.root ?? null;
    }
    if (!repoRoot && worktreeRoot) repoRoot = await mainWorktreeOf(worktreeRoot);
    // Without a folder and without a repository there is nothing left for git to clean up.
    if (!repoRoot) return;
    const worktreePath = worktreeRoot ?? project.path;
    // The user's pre-deletion script runs first, while the folder is still there; a forced retry runs it again.
    if (exists) await runConfiguredScript("preWorktreeDelete", preWorktreeDeleteRun(project, { worktreePath, repoRoot }), ctx.settings);
    await removeWorktree({ repoRoot, path: worktreePath, branch: project.worktree.branch, force });
  }
}
