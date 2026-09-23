/**
 * Job schedules: validation of what the agent, the user, or the settings ask for, and when a job
 * runs next. `every` counts from the end of the last run (the idle interval applies while no
 * browser is connected), `cron` is a five-field expression in an IANA zone, `at` runs once.
 */
import { Cron } from "croner";
import type { Job, JobSchedule } from "@portal/contracts/jobs";
import { httpError } from "../ops.ts";

/** The shortest interval a job may run at. */
export const MIN_EVERY_MS = 60_000;
/** The longest interval: anything rarer is a cron or an `at`. */
export const MAX_EVERY_MS = 31 * 24 * 60 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function interval(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw httpError(`${what} must be a number of milliseconds.`, 400);
  const ms = Math.round(value);
  if (ms < MIN_EVERY_MS || ms > MAX_EVERY_MS) throw httpError(`${what} must be between one minute and 31 days.`, 400);
  return ms;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cron(expr: string, tz: string | undefined): Cron {
  try {
    return new Cron(expr, { paused: true, mode: "5-part", ...(tz ? { timezone: tz } : {}) });
  } catch (err) {
    throw httpError(`Invalid cron expression "${expr}": ${err instanceof Error ? err.message : String(err)}`, 400);
  }
}

/** Unknown input reduced to a valid schedule, or a 400. */
export function parseSchedule(input: unknown): JobSchedule {
  if (!isRecord(input)) throw httpError("A schedule must be an object with a type of every, cron, or at.", 400);
  switch (input.type) {
    case "every": {
      const everyMs = interval(input.everyMs, "everyMs");
      if (input.idleEveryMs === undefined || input.idleEveryMs === null) return { type: "every", everyMs };
      return { type: "every", everyMs, idleEveryMs: interval(input.idleEveryMs, "idleEveryMs") };
    }
    case "cron": {
      if (typeof input.expr !== "string" || !input.expr.trim()) throw httpError("A cron schedule needs expr.", 400);
      const expr = input.expr.trim().replace(/\s+/g, " ");
      let tz: string | undefined;
      if (input.tz !== undefined && input.tz !== null) {
        if (typeof input.tz !== "string" || !isTimeZone(input.tz)) throw httpError(`Unknown time zone "${String(input.tz)}".`, 400);
        tz = input.tz;
      }
      if (cron(expr, tz).nextRun() === null) throw httpError(`The cron expression "${expr}" never fires.`, 400);
      return tz ? { type: "cron", expr, tz } : { type: "cron", expr };
    }
    case "at": {
      if (!Number.isSafeInteger(input.at) || (input.at as number) < 0) throw httpError("An at schedule needs at (epoch ms).", 400);
      return { type: "at", at: input.at as number };
    }
    default:
      throw httpError("A schedule's type is every, cron, or at.", 400);
  }
}

/** The interval an `every` schedule runs at right now. */
export function currentInterval(schedule: Extract<JobSchedule, { type: "every" }>, present: boolean): number {
  return !present && schedule.idleEveryMs ? schedule.idleEveryMs : schedule.everyMs;
}

/** Whether the schedule's cadence depends on presence. */
export const followsPresence = (schedule: JobSchedule) => schedule.type === "every" && !!schedule.idleEveryMs && schedule.idleEveryMs !== schedule.everyMs;

/**
 * When a job runs next after a run that ended at `lastRunAt` (null: it never ran; its first run is
 * one interval from `now`). Null when it is finished (an `at` that ran, a cron that never fires again).
 */
export function nextRunAt(schedule: JobSchedule, { now, lastRunAt, present }: { now: number; lastRunAt: number | null; present: boolean }): number | null {
  switch (schedule.type) {
    case "every": {
      const base = lastRunAt ?? now;
      return Math.max(base + currentInterval(schedule, present), now);
    }
    case "cron": {
      const next = cron(schedule.expr, schedule.tz).nextRun(new Date(Math.max(now, lastRunAt ?? 0)));
      return next ? next.getTime() : null;
    }
    case "at":
      return lastRunAt === null ? schedule.at : null;
  }
}

/**
 * The next run of a job whose schedule or cadence changed without a run (a reschedule, a presence
 * change). A job that never ran keeps an earlier plan than the new cadence gives.
 */
export function replanned(job: Pick<Job, "schedule" | "lastRunAt" | "nextRunAt">, now: number, present: boolean): number | null {
  const next = nextRunAt(job.schedule, { now, lastRunAt: job.lastRunAt, present });
  if (job.schedule.type === "every" && job.lastRunAt === null && job.nextRunAt !== null && next !== null) return Math.max(now, Math.min(job.nextRunAt, next));
  return next;
}

const minutes = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);

/** "every 10 min (60 min idle)", "cron 0 9 * * 1-5 (Europe/Berlin)", "once at 2026-09-23T10:00:00.000Z". */
export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.type) {
    case "every":
      return `every ${minutes(schedule.everyMs)}${schedule.idleEveryMs && schedule.idleEveryMs !== schedule.everyMs ? ` (${minutes(schedule.idleEveryMs)} idle)` : ""}`;
    case "cron":
      return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    case "at":
      return `once at ${new Date(schedule.at).toISOString()}`;
  }
}

export function sameSchedule(a: JobSchedule, b: JobSchedule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
