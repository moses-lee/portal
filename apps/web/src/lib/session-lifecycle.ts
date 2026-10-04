/**
 * The lifecycle sweep's clocks as the web shows them (docs/SESSION-LIFECYCLE.md, rules 1 and 2):
 * when a finished tracked session is untracked, and when an idle worktree project is removed or why
 * it is kept. Pure, so the node test runner can load it. The server decides; these only predict.
 */
import type { Project, SessionSummary } from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far ahead the sidebar announces a worktree's removal. */
export const REMOVAL_NOTICE_MS = 7 * DAY;

/**
 * A duration left on a clock: "1d 3h", "5h 20m", "12m". `coarse` keeps only the largest unit
 * ("2d", "5h", "12m") for tight rows. Under a minute (or past due) reads "soon".
 */
export function countdownText(ms: number, { coarse = false }: { coarse?: boolean } = {}): string {
  if (ms < MINUTE) return "soon";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return coarse || hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  if (hours > 0) return coarse || minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "in 2d", or "soon" when the clock has run out (the next sweep acts on it). */
function inText(ms: number, coarse: boolean): string {
  const text = countdownText(ms, { coarse });
  return text === "soon" ? text : `in ${text}`;
}

/**
 * The finished tracked row's subtitle, "untracks in 1d 3h", from `idleSince + untrackAfterHours`.
 * Null when the session is not idle (no clock is running).
 */
export function untrackCountdown(
  session: { idleSince?: number | null },
  untrackAfterHours: number,
  now: number,
): string | null {
  if (session.idleSince == null) return null;
  return `untracks ${inText(session.idleSince + untrackAfterHours * HOUR - now, false)}`;
}

/** The fields of a project the worktree clock reads. */
export type RetentionProject = Pick<Project, "id" | "createdAt" | "worktree" | "pinnedAt" | "keptReason">;
/** The fields of a session the worktree clock reads. */
export type RetentionSession = Pick<SessionSummary, "projectId"> & { idleSince?: number | null };

/**
 * A project's idle clock (rule 2): the newest `idleSince` among its sessions, or its `createdAt`
 * when it has none. Null while any of its sessions is not idle.
 */
export function projectIdleClock(project: Pick<Project, "id" | "createdAt">, sessions: readonly RetentionSession[]): number | null {
  let clock: number | null = null;
  for (const session of sessions) {
    if (session.projectId !== project.id) continue;
    if (session.idleSince == null) return null;
    clock = Math.max(clock ?? 0, session.idleSince);
  }
  return clock ?? project.createdAt;
}

/**
 * What a worktree project row says about the sweep, or null for nothing:
 * - only worktree projects Portal created, and never pinned ones;
 * - nothing while any of its sessions is not idle (no clock runs);
 * - "kept: uncommitted changes" (the sweep's reason) when it kept a due project;
 * - "removes in 2d" when removal is due within `REMOVAL_NOTICE_MS`.
 */
export function worktreeRetention(
  project: RetentionProject,
  sessions: readonly RetentionSession[],
  removeAfterHours: number,
  now: number,
): string | null {
  if (!project.worktree || project.pinnedAt != null) return null;
  const clock = projectIdleClock(project, sessions);
  if (clock == null) return null;
  if (project.keptReason) return `kept: ${project.keptReason}`;
  const left = clock + removeAfterHours * HOUR - now;
  if (left > REMOVAL_NOTICE_MS) return null;
  return `removes ${inText(left, true)}`;
}
