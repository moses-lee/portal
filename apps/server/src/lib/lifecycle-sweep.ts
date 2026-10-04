/**
 * The lifecycle sweep (docs/SESSION-LIFECYCLE.md, "Sweep"): rules 1 and 2 of the session lifecycle
 * policy, run inside the server every 5 minutes whether or not a browser is open or the
 * orchestrator is enabled. It is owned by the app wiring next to the sessions service, not by the
 * orchestrator's job worker.
 *
 * Pass 1 untracks every tracked session idle for `sessions.tracked.untrackAfterHours`. Pass 2
 * removes every Portal-created worktree project (`worktree` set, not pinned) whose sessions have all
 * been idle for `sessions.worktrees.removeAfterHours` and none of which has an open Portal terminal,
 * through the same removal path as `DELETE /api/projects/:id?worktree=delete`, unforced and keeping
 * unmerged branches. A dirty tree, or git refusing, keeps the project and records why in
 * `keptReason`; Activity hears of a keep only when the reason changes.
 *
 * Everything the sweep touches comes in through `LifecycleSweepDeps`, so tests drive it with fakes
 * and a fake clock; `liveLifecycleSweepDeps` builds them from the app context.
 */
import type { ActivityInput } from "@portal/contracts/activity";
import type { AppContext } from "../context.ts";
import type { TrackedService } from "../orchestrator/tracked/service.ts";
import { readWorktreeState } from "../orchestrator/worktree-state.ts";
import { liveProjectRemovalIo, removeProject } from "../projects/remove-worktree.ts";
import type { Project, WorktreeMeta } from "./types.ts";

export const SWEEP_EVERY_MS = 5 * 60_000;
export const FIRST_SWEEP_AFTER_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The reason a dirty tree keeps a due worktree, as stored in `keptReason` and shown in the sidebar. */
export const DIRTY_REASON = "uncommitted changes";

export type LifecycleSweepDeps = {
  now(): number;
  /** The two clocks from `settings.sessions`, read at the start of every sweep. */
  settings(): Promise<{ untrackAfterHours: number; removeAfterHours: number }>;
  /** Every session's project and idle clock. */
  sessions(): Promise<Array<{ id: string; projectId: string; idleSince: number | null }>>;
  projects: {
    list(): Promise<Project[]>;
    setKeptReason(id: string, reason: string | null): Promise<unknown>;
  };
  /** The tracked sessions service; null when the orchestrator is not running (nothing is tracked then). */
  tracked: Pick<TrackedService, "list" | "untrack"> | null;
  /** Whether the session has a Portal terminal open. */
  hasOpenTerminal(sessionId: string): boolean;
  /** Whether the worktree project's tree has uncommitted changes (a missing folder is clean). */
  isDirty(project: Project & { worktree: WorktreeMeta }): Promise<boolean>;
  /** Remove the project and its worktree folder: pre-delete script, no force, branch only when merged. */
  removeWorktreeProject(project: Project & { worktree: WorktreeMeta }): Promise<{ branchDeleted: boolean }>;
  /** Where keeps and removals are recorded; null without the orchestrator. */
  activity: { log(input: ActivityInput): Promise<unknown> } | null;
  /** Reports a step that failed unexpectedly; the sweep carries on. */
  logError(err: unknown, message: string): void;
};

export type LifecycleSweepResult = {
  /** Tracked sessions untracked for being idle. */
  untracked: number;
  /** Worktree projects removed for being idle. */
  removed: number;
  /** Due worktree projects kept (dirty tree, or git refused). */
  kept: number;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const hoursLabel = (hours: number) => `${hours}h`;

/** One sweep at `now`: pass 1 (tracked) then pass 2 (worktrees). Never throws for one bad row. */
export async function runLifecycleSweep(deps: LifecycleSweepDeps, now = deps.now()): Promise<LifecycleSweepResult> {
  const { untrackAfterHours, removeAfterHours } = await deps.settings();
  const sessions = await deps.sessions();
  const result: LifecycleSweepResult = { untracked: 0, removed: 0, kept: 0 };

  // Pass 1: untrack sessions idle past the threshold. A session that is doing anything has no clock.
  if (deps.tracked) {
    const idleSince = new Map(sessions.map((session) => [session.id, session.idleSince]));
    const cutoff = now - untrackAfterHours * HOUR_MS;
    const reason = `idle for ${hoursLabel(untrackAfterHours)}`;
    for (const row of await deps.tracked.list()) {
      const since = idleSince.get(row.sessionId);
      if (since === null || since === undefined || since > cutoff) continue;
      try {
        if (await deps.tracked.untrack(row.sessionId, "portal", { reason })) result.untracked++;
      } catch (err) {
        deps.logError(err, `Could not untrack idle session ${row.sessionId}`);
      }
    }
  }

  // Pass 2: remove idle worktree projects Portal created.
  const byProject = new Map<string, typeof sessions>();
  for (const session of sessions) {
    const bucket = byProject.get(session.projectId) ?? [];
    bucket.push(session);
    byProject.set(session.projectId, bucket);
  }
  const removeCutoff = now - removeAfterHours * HOUR_MS;
  for (const project of await deps.projects.list()) {
    if (!project.worktree) continue;
    const worktreeProject = { ...project, worktree: project.worktree };
    try {
      const own = byProject.get(project.id) ?? [];
      const due = project.pinnedAt === null
        && own.every((session) => session.idleSince !== null && !deps.hasOpenTerminal(session.id))
        && (own.length ? Math.max(...own.map((session) => session.idleSince as number)) : project.createdAt) <= removeCutoff;
      if (!due) {
        // Whatever kept it no longer applies while it is not due; the next due sweep decides again.
        if (project.keptReason !== null) await deps.projects.setKeptReason(project.id, null);
        continue;
      }
      if (await deps.isDirty(worktreeProject)) {
        await keep(deps, project, DIRTY_REASON);
        result.kept++;
        continue;
      }
      let branchDeleted: boolean;
      try {
        ({ branchDeleted } = await deps.removeWorktreeProject(worktreeProject));
      } catch (err) {
        // Git refused (the tree changed since the check), or the pre-delete script aborted.
        await keep(deps, project, errorText(err));
        result.kept++;
        continue;
      }
      result.removed++;
      const idle = hoursLabel(removeAfterHours);
      const branch = project.worktree.branch;
      await deps.activity?.log({
        actor: "system", kind: "worktree.removed_idle",
        summary: `Removed the worktree for ${project.name} after ${idle} idle${branchDeleted ? `, and its merged branch ${branch}` : `; the branch ${branch} stays`}`,
        refs: { projectId: project.id }, detail: { branch, branchDeleted, path: project.path, removeAfterHours },
      });
    } catch (err) {
      deps.logError(err, `Could not sweep worktree project ${project.name}`);
    }
  }
  return result;
}

/** Record why a due worktree was kept; Activity hears of it only when the reason changes. */
async function keep(deps: LifecycleSweepDeps, project: Project, reason: string): Promise<void> {
  if (project.keptReason === reason) return;
  // Stored before the log, so a failed write is retried (and logged) by the next sweep rather than logged twice.
  await deps.projects.setKeptReason(project.id, reason);
  await deps.activity?.log({
    actor: "system", kind: "worktree.kept",
    summary: `Kept the idle worktree for ${project.name}: ${reason}`,
    refs: { projectId: project.id }, detail: { reason, path: project.path },
  });
}

export type LifecycleSweeper = {
  /** Sweep now; a call while a sweep runs gets that sweep's result instead of starting another. */
  run(): Promise<LifecycleSweepResult>;
  /** Stop the timer and wait for a running sweep to finish. */
  dispose(): Promise<void>;
};

/** Timers the sweeper runs on; tests pass fakes. */
export type SweepTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const nodeTimers: SweepTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * The scheduled sweep: first 60 seconds after `start`, then every 5 minutes, never two at once. The
 * timers are unref'd so they never keep the process alive.
 */
export function createLifecycleSweeper(
  deps: LifecycleSweepDeps,
  { everyMs = SWEEP_EVERY_MS, firstAfterMs = FIRST_SWEEP_AFTER_MS, timers = nodeTimers, start = true }: {
    everyMs?: number; firstAfterMs?: number; timers?: SweepTimers; start?: boolean;
  } = {},
): LifecycleSweeper {
  let running: Promise<LifecycleSweepResult> | null = null;
  let disposed = false;
  const handles: unknown[] = [];

  function run(): Promise<LifecycleSweepResult> {
    if (running) return running;
    running = runLifecycleSweep(deps).finally(() => { running = null; });
    return running;
  }

  const tick = () => {
    if (disposed) return;
    void run().catch((err: unknown) => deps.logError(err, "The lifecycle sweep failed"));
  };

  if (start) {
    handles.push(timers.setTimeout(() => {
      tick();
      if (!disposed) handles.push(timers.setInterval(tick, everyMs));
    }, firstAfterMs));
  }

  return {
    run() {
      if (disposed) return Promise.reject(new Error("Portal is shutting down."));
      return run();
    },
    async dispose() {
      disposed = true;
      for (const handle of handles) timers.clear(handle);
      await running?.catch(() => {});
    },
  };
}

/** The sweep's deps over the app's services, looked up on every call. */
export function liveLifecycleSweepDeps(
  ctx: Pick<AppContext, "projects" | "sessions" | "settings" | "terminals" | "log"> & { orchestrator?: AppContext["orchestrator"] },
): LifecycleSweepDeps {
  const removalIo = liveProjectRemovalIo(ctx);
  return {
    now: Date.now,
    async settings() {
      const { sessions } = await ctx.settings.read();
      return { untrackAfterHours: sessions.tracked.untrackAfterHours, removeAfterHours: sessions.worktrees.removeAfterHours };
    },
    async sessions() {
      await ctx.sessions.ready;
      return ctx.sessions.listSessions().map(({ id, projectId, idleSince }) => ({ id, projectId, idleSince }));
    },
    projects: {
      async list() {
        await ctx.projects.ready;
        return ctx.projects.list();
      },
      setKeptReason: (id, reason) => ctx.projects.setKeptReason(id, reason),
    },
    get tracked() {
      return ctx.orchestrator?.hub.tracked ?? null;
    },
    hasOpenTerminal: (sessionId) => ctx.terminals.listBySession(sessionId).length > 0,
    async isDirty(project) {
      // `git status` in any folder of the worktree reports the whole tree; merged-ness is not needed.
      const state = await readWorktreeState({ repoRoot: project.path, path: project.path, branch: project.worktree.branch, defaultBranch: null });
      return state.dirty;
    },
    removeWorktreeProject: (project) => removeProject(removalIo, project, { deleteWorktree: true, force: false, deleteBranch: "merged" }),
    get activity() {
      return ctx.orchestrator?.hub.activity ?? null;
    },
    logError: (err, message) => ctx.log.error({ err }, message),
  };
}
