/**
 * The lifecycle sweep (docs/SESSION-LIFECYCLE.md, "Sweep"): rules 1 and 2 of the session lifecycle
 * policy, run inside the server every 5 minutes whether or not a browser is open or the
 * orchestrator is enabled. It is owned by the app wiring next to the sessions service, not by the
 * orchestrator's job worker.
 *
 * Pass 1 untracks every tracked session idle for `sessions.tracked.untrackAfterHours`, counted from
 * the later of its idle clock and when it was tracked. Pass 2 removes every Portal-created worktree
 * project (`worktree` set, not pinned) whose sessions have all been idle for
 * `sessions.worktrees.removeAfterHours` (counted from no earlier than its last restore) and none of
 * which has an open Portal terminal, through the same removal path as
 * `DELETE /api/projects/:id?worktree=delete`, unforced and keeping unmerged branches. Projects in
 * one worktree folder (a repo root project and a subfolder project of the same branch) are judged
 * and removed together: the folder goes only when every one of them is due. Each folder is judged
 * again on live data right before its removal and once more after the pre-delete script. A dirty
 * tree, an unreadable `git status`, an open terminal, or git refusing keeps the project and records
 * why in `keptReason`; Activity hears of a keep only when the reason changes. A keep that is not a
 * dirty tree (a script abort, git refusing) is not retried until the folder's clock moves.
 *
 * Everything the sweep touches comes in through `LifecycleSweepDeps`, so tests drive it with fakes
 * and a fake clock; `liveLifecycleSweepDeps` builds them from the app context.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ActivityInput } from "@portal/contracts/activity";
import type { AppContext } from "../context.ts";
import type { TrackedService } from "../orchestrator/tracked/service.ts";
import { RemovalSkipped, liveProjectRemovalIo, removeProject } from "../projects/remove-worktree.ts";
import { readGitInfo } from "./git-info.ts";
import type { Project, WorktreeMeta } from "./types.ts";
import { gitMaybe } from "./worktrees.ts";

export const SWEEP_EVERY_MS = 5 * 60_000;
export const FIRST_SWEEP_AFTER_MS = 60_000;
const HOUR_MS = 3_600_000;
const REASON_MAX = 200;

/** The reason a dirty tree keeps a due worktree, as stored in `keptReason` and shown in the sidebar. */
export const DIRTY_REASON = "uncommitted changes";
/** The reason when `git status` failed (a timeout, a held `index.lock`): the tree may be dirty. */
export const STATUS_FAILED_REASON = "could not read git status";
/** The reason when nothing but an open Portal terminal holds an idle worktree. */
export const OPEN_TERMINAL_REASON = "open terminal";

type WorktreeProject = Project & { worktree: WorktreeMeta };
type SweepSession = { id: string; projectId: string; idleSince: number | null };

export type LifecycleSweepDeps = {
  now(): number;
  /** The two clocks from `settings.sessions`, read at the start of every sweep. */
  settings(): Promise<{ untrackAfterHours: number; removeAfterHours: number }>;
  /** Every session's project and idle clock, as they are now. */
  sessions(): Promise<SweepSession[]>;
  projects: {
    /** The listed projects, as they are now. */
    list(): Promise<Project[]>;
    setKeptReason(id: string, reason: string | null): Promise<unknown>;
  };
  /** The tracked sessions service; null when the orchestrator is not running (nothing is tracked then). */
  tracked: Pick<TrackedService, "list" | "untrack"> | null;
  /** Whether the session has a Portal terminal open. */
  hasOpenTerminal(sessionId: string): boolean;
  /** The root of the worktree folder the project sits in, shared by every project in it; null when the folder is gone. */
  worktreeRoot(project: WorktreeProject): Promise<string | null>;
  /** Whether the project's tree has uncommitted changes (a missing folder is clean); null when `git status` failed. */
  isDirty(project: WorktreeProject): Promise<boolean | null>;
  /**
   * Remove the projects of one worktree folder, the first with the folder (pre-delete script, no
   * force, branch only when merged), the rest as list entries only. `recheck` runs after the script
   * and before git; when it answers false the removal throws `RemovalSkipped`.
   */
  removeWorktreeProjects(projects: WorktreeProject[], recheck: () => Promise<boolean>): Promise<{ branchDeleted: boolean }>;
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
  /** Due worktree projects kept (dirty tree, open terminal, a shared folder held, or git refused). */
  kept: number;
};

export type LifecycleSweepOptions = {
  now?: number;
  /** Aborted at shutdown: the sweep stops before the next project and before running a script. */
  signal?: AbortSignal;
  /**
   * Non-dirty keeps (a script abort, git refusing) by worktree folder, with the clock they happened
   * at; the folder is not tried again until its clock moves. The sweeper keeps one across sweeps.
   */
  failedAt?: Map<string, number>;
};

/** The first line of a failure, short enough for the sidebar. */
function failureReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "the removal failed";
  return line.slice(0, REASON_MAX);
}

const hoursLabel = (hours: number) => `${hours}h`;

function byProjectOf(sessions: SweepSession[]): Map<string, SweepSession[]> {
  const byProject = new Map<string, SweepSession[]>();
  for (const session of sessions) {
    const bucket = byProject.get(session.projectId) ?? [];
    bucket.push(session);
    byProject.set(session.projectId, bucket);
  }
  return byProject;
}

/** A project's idle clock: its newest session's (its creation without sessions), restarted by a restore. */
function clockOf(project: Project, own: SweepSession[]): number {
  const idle = own.length ? Math.max(...own.map((session) => session.idleSince ?? Infinity)) : project.createdAt;
  return Math.max(idle, project.revivedAt ?? 0);
}

/** What holds a worktree project back from removal. */
type Hold = "pinned" | "busy" | "recent" | "terminal";

function holdOf(project: Project, own: SweepSession[], cutoff: number, hasOpenTerminal: (id: string) => boolean): Hold | null {
  if (project.pinnedAt !== null) return "pinned";
  if (own.some((session) => session.idleSince === null)) return "busy";
  if (clockOf(project, own) > cutoff) return "recent";
  if (own.some((session) => hasOpenTerminal(session.id))) return "terminal";
  return null;
}

const holdPhrase: Record<Hold | "plain", string> = {
  pinned: "is pinned", busy: "is in use", recent: "is not idle long enough", terminal: "has an open terminal",
  plain: "is not a worktree project",
};

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);

/** One sweep: pass 1 (tracked) then pass 2 (worktrees). Never throws for one bad row. */
export async function runLifecycleSweep(
  deps: LifecycleSweepDeps,
  { now = deps.now(), signal, failedAt = new Map() }: LifecycleSweepOptions = {},
): Promise<LifecycleSweepResult> {
  const { untrackAfterHours, removeAfterHours } = await deps.settings();
  const sessions = await deps.sessions();
  const result: LifecycleSweepResult = { untracked: 0, removed: 0, kept: 0 };

  // Pass 1: untrack sessions idle past the threshold, counted from no earlier than when they were
  // tracked. A session that is doing anything has no clock.
  if (deps.tracked) {
    const idleSince = new Map(sessions.map((session) => [session.id, session.idleSince]));
    const cutoff = now - untrackAfterHours * HOUR_MS;
    const reason = `idle for ${hoursLabel(untrackAfterHours)}`;
    for (const row of await deps.tracked.list()) {
      if (signal?.aborted) return result;
      const since = idleSince.get(row.sessionId);
      if (since === null || since === undefined || Math.max(since, row.trackedAt) > cutoff) continue;
      try {
        if (await deps.tracked.untrack(row.sessionId, "portal", { reason, actor: "system" })) result.untracked++;
      } catch (err) {
        deps.logError(err, `Could not untrack idle session ${row.sessionId}`);
      }
    }
  }

  // Pass 2: remove idle worktree projects Portal created, one worktree folder at a time.
  const cutoff = now - removeAfterHours * HOUR_MS;
  const byProject = byProjectOf(sessions);
  const listed = await deps.projects.list();
  const groups = new Map<string, WorktreeProject[]>();
  for (const project of listed) {
    if (!project.worktree) continue;
    if (signal?.aborted) return result;
    const worktreeProject = { ...project, worktree: project.worktree };
    const root = await deps.worktreeRoot(worktreeProject).catch((err: unknown) => {
      deps.logError(err, `Could not find the worktree folder of ${project.name}`);
      return null;
    }) ?? project.path;
    groups.set(root, [...(groups.get(root) ?? []), worktreeProject]);
  }
  for (const root of failedAt.keys()) if (!groups.has(root)) failedAt.delete(root);

  for (const [root, members] of groups) {
    if (signal?.aborted) return result;
    // The member nearest the folder's root first: its removal takes the folder, the others follow as entries.
    members.sort((a, b) => a.path.length - b.path.length);
    try {
      await sweepWorktree(root, members);
    } catch (err) {
      deps.logError(err, `Could not sweep worktree project ${members.map((project) => project.name).join(", ")}`);
    }
  }
  return result;

  /** Judge the projects of one worktree folder together and, when every one is due, remove them. */
  async function sweepWorktree(root: string, members: WorktreeProject[]): Promise<void> {
    const holds = members.map((project) => holdOf(project, byProject.get(project.id) ?? [], cutoff, deps.hasOpenTerminal));
    // A plain project added on a folder inside the worktree would lose its folder too.
    const plain = listed.find((project) => !project.worktree && within(project.path, root));
    if (plain || holds.some((hold) => hold !== null)) {
      // Not due now: a failure remembered from before is tried afresh once it is due again.
      failedAt.delete(root);
      const j = holds.findIndex((hold) => hold !== null && hold !== "terminal");
      const k = j >= 0 ? j : holds.findIndex((hold) => hold !== null);
      const holder = k >= 0 ? `${members[k].name}, which ${holdPhrase[holds[k] as Hold]}` : `${plain?.name}, which ${holdPhrase.plain}`;
      for (const [i, project] of members.entries()) {
        const hold = holds[i];
        if (hold === "terminal") await keep(project, OPEN_TERMINAL_REASON);
        else if (hold === null) await keep(project, `shares its worktree with ${holder}`);
        // Not due itself: whatever kept it no longer applies; the next due sweep decides again.
        else if (project.keptReason !== null) await deps.projects.setKeptReason(project.id, null);
      }
      return;
    }

    const clock = Math.max(...members.map((project) => clockOf(project, byProject.get(project.id) ?? [])));
    if (failedAt.get(root) === clock) {
      // Kept for a failure at this clock already; nothing has moved since, so it would only fail again.
      result.kept += members.length;
      return;
    }
    const dirty = await deps.isDirty(members[0]);
    if (dirty !== false) {
      for (const project of members) await keep(project, dirty === null ? STATUS_FAILED_REASON : DIRTY_REASON);
      return;
    }

    // What this pass read is old by now (git status, the folders before this one): judge again on live data.
    const ids = new Set(members.map((project) => project.id));
    const recheck = async () => {
      if (signal?.aborted) return false;
      const [projects, live] = await Promise.all([deps.projects.list(), deps.sessions()]);
      // A project added inside the folder since would lose its folder too.
      if (projects.some((project) => !ids.has(project.id) && within(project.path, root))) return false;
      const liveByProject = byProjectOf(live);
      return members.every((member) => {
        const project = projects.find((p) => p.id === member.id);
        return !!project?.worktree && holdOf(project, liveByProject.get(project.id) ?? [], cutoff, deps.hasOpenTerminal) === null;
      });
    };
    if (!(await recheck())) return;

    let branchDeleted: boolean;
    try {
      ({ branchDeleted } = await deps.removeWorktreeProjects(members, recheck));
    } catch (err) {
      if (err instanceof RemovalSkipped) return;
      // Git refused (the tree changed since the check), or the pre-delete script aborted.
      failedAt.set(root, clock);
      for (const project of members) await keep(project, failureReason(err));
      return;
    }
    failedAt.delete(root);
    const idle = hoursLabel(removeAfterHours);
    for (const project of members) {
      result.removed++;
      const branch = project.worktree.branch;
      await deps.activity?.log({
        actor: "system", kind: "worktree.removed_idle",
        summary: `Removed the worktree for ${project.name} after ${idle} idle${branchDeleted ? `, and its merged branch ${branch}` : `; the branch ${branch} stays`}`,
        refs: { projectId: project.id }, detail: { branch, branchDeleted, path: project.path, removeAfterHours },
      });
    }
  }

  /** Record why a due worktree was kept; Activity hears of it only when the reason changes. */
  async function keep(project: Project, reason: string): Promise<void> {
    result.kept++;
    if (project.keptReason === reason) return;
    // Stored before the log, so a failed write is retried (and logged) by the next sweep rather than logged twice.
    await deps.projects.setKeptReason(project.id, reason);
    await deps.activity?.log({
      actor: "system", kind: "worktree.kept",
      summary: `Kept the idle worktree for ${project.name}: ${reason}`,
      refs: { projectId: project.id }, detail: { reason, path: project.path },
    });
  }
}

export type LifecycleSweeper = {
  /** Sweep now; a call while a sweep runs gets that sweep's result instead of starting another. */
  run(): Promise<LifecycleSweepResult>;
  /** Stop the timer and wait for a running sweep to stop at its next project (or script). */
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
  const shutdown = new AbortController();
  const failedAt = new Map<string, number>();

  function run(): Promise<LifecycleSweepResult> {
    if (running) return running;
    running = runLifecycleSweep(deps, { signal: shutdown.signal, failedAt }).finally(() => { running = null; });
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
      shutdown.abort();
      for (const handle of handles) timers.clear(handle);
      await running?.catch(() => {});
    },
  };
}

const exists = (dir: string) => stat(dir).then((info) => info.isDirectory(), () => false);

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
    async worktreeRoot(project) {
      // readGitInfo walks up to parent folders, so a folder that is gone has no root of its own.
      if (!(await exists(project.path))) return null;
      return (await readGitInfo(project.path))?.root ?? null;
    },
    async isDirty(project) {
      if (!(await exists(project.path))) return false;
      // `git status` in any folder of the worktree reports the whole tree. A failure is not "clean".
      const status = await gitMaybe(project.path, ["status", "--porcelain"]);
      return status === null ? null : status.trim() !== "";
    },
    async removeWorktreeProjects([first, ...rest], recheck) {
      const result = await removeProject({ ...removalIo, recheck }, first, { deleteWorktree: true, force: false, deleteBranch: "merged" });
      // The folder went with the first; the others in it only leave the list.
      for (const project of rest) await removeProject(removalIo, project);
      return result;
    },
    get activity() {
      return ctx.orchestrator?.hub.activity ?? null;
    },
    logError: (err, message) => ctx.log.error({ err }, message),
  };
}
