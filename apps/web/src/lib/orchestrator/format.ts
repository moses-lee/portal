/**
 * Wording for the orchestrator views: relative times, schedules in words, durations, token counts,
 * and the live status line. Pure, so the unit tests pin the phrasing.
 */
import type { Approval, JobRun, JobSchedule, OrchestratorStatus, RunUsage } from "./types.ts";
import type { AgentActivity } from "../agent-activity.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * "in 5 min", "3 h ago", "in 2 d", "just now", "any moment" for a timestamp relative to `now`.
 * Rounds toward the nearer unit; a time a few seconds out reads as now, whichever side it is on.
 */
export function relativeTime(at: number, now: number): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 45 * SECOND) return future ? "any moment" : "just now";
  let amount: string;
  if (abs < HOUR) amount = `${Math.max(1, Math.round(abs / MINUTE))} min`;
  else if (abs < DAY) amount = `${Math.round(abs / HOUR)} h`;
  else amount = `${Math.round(abs / DAY)} d`;
  return future ? `in ${amount}` : `${amount} ago`;
}

/** "Every 2 minutes", "Every hour", "Every 90 minutes", "Every day" for an interval. */
export function describeEvery(ms: number): string {
  if (ms > 0 && ms % DAY === 0) return ms === DAY ? "Every day" : `Every ${plural(ms / DAY, "day")}`;
  if (ms > 0 && ms % HOUR === 0) return ms === HOUR ? "Every hour" : `Every ${plural(ms / HOUR, "hour")}`;
  if (ms >= MINUTE && ms % MINUTE === 0) return ms === MINUTE ? "Every minute" : `Every ${plural(ms / MINUTE, "minute")}`;
  const seconds = Math.max(1, Math.round(ms / SECOND));
  return seconds === 1 ? "Every second" : `Every ${plural(seconds, "second")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const weekdays = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** The common five-field cron shapes in words; null for anything else (the caller shows the expression). */
export function describeCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const isNum = (value: string) => /^\d+$/.test(value);
  const step = (value: string) => /^\*\/(\d+)$/.exec(value)?.[1];
  if (dom !== "*" || month !== "*") return null;
  if (hour === "*" && dow === "*") {
    if (minute === "*") return "Every minute";
    const every = step(minute);
    if (every) return describeEvery(Number(every) * MINUTE);
    if (isNum(minute)) return minute === "0" ? "Every hour" : `Every hour at :${pad(Number(minute))}`;
    return null;
  }
  if (minute === "0" && step(hour) && dow === "*") return describeEvery(Number(step(hour)) * HOUR);
  if (!isNum(minute) || !isNum(hour)) return null;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dow === "*") return `Daily at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  if (dow === "0,6" || dow === "6,0") return `Weekends at ${time}`;
  if (/^[0-7]$/.test(dow)) return `${weekdays[Number(dow) % 7]} at ${time}`;
  return null;
}

/** A local time of day, 24-hour: "14:05". */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** True when both times fall on the same local calendar day. */
export function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** A chat's day divider: "Today", "Yesterday", "Oct 3", or "Oct 3, 2025" outside the current year. */
export function formatDay(at: number, now = Date.now()): string {
  if (sameDay(at, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(at, yesterday.getTime())) return "Yesterday";
  const date = new Date(at);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * A chat message's time under its day divider (`day`, any time on that day): "14:05", or with the
 * day ("Yesterday 23:58") when the message fell on another day than the divider above it.
 */
export function formatMessageTime(at: number, day: number, now = Date.now()): string {
  return sameDay(at, day) ? formatClock(at) : `${formatDay(at, now)} ${formatClock(at)}`;
}

/**
 * Where a chat's day dividers go, for each message's time (0 or less when unknown): `divider`, the
 * time to label a divider before the message with (null for none), and `day`, a time on the day
 * the message sits under (0 before the first known time). A divider opens the first known day and
 * each day after it; a message of unknown time stays in the day before it.
 */
export function daySections(times: readonly number[]): { divider: number | null; day: number }[] {
  let day = 0;
  return times.map((at) => {
    if (!(at > 0) || (day > 0 && sameDay(at, day))) return { divider: null, day };
    day = at;
    return { divider: at, day };
  });
}

/** A short local date and time: "Tue 14:05" within a week, else "Sep 30, 14:05". */
export function formatDateTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = formatClock(at);
  if (sameDay(at, now)) return `today ${time}`;
  if (Math.abs(at - now) < 6 * DAY)
    return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** A job's schedule in words: "Every 2 minutes (every hour while you are away)", "Weekdays at 09:00", "Once, today 14:05". */
export function describeSchedule(schedule: JobSchedule, now = Date.now()): string {
  switch (schedule.type) {
    case "every": {
      const base = describeEvery(schedule.everyMs);
      if (!schedule.idleEveryMs || schedule.idleEveryMs === schedule.everyMs) return base;
      return `${base} (${describeEvery(schedule.idleEveryMs).toLowerCase()} while you are away)`;
    }
    case "cron": {
      const words = describeCron(schedule.expr) ?? `Cron ${schedule.expr}`;
      return schedule.tz ? `${words} (${schedule.tz})` : words;
    }
    case "at":
      return `Once, ${formatDateTime(schedule.at, now)}`;
  }
}

/** "800 ms", "12 s", "3 min 5 s", "1 h 2 min". */
export function formatDuration(ms: number): string {
  if (ms < SECOND) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < MINUTE) return `${Math.round(ms / SECOND)} s`;
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.round((ms % MINUTE) / SECOND);
    return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  }
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

/** "950", "12.3k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "12.3k in · 820 out · 10k cached" for a run's usage. */
export function describeUsage(usage: RunUsage): string {
  const parts = [`${formatTokens(usage.inputTokens)} in`, `${formatTokens(usage.outputTokens)} out`];
  if (usage.cachedInputTokens) parts.push(`${formatTokens(usage.cachedInputTokens)} cached`);
  if (usage.reasoningTokens) parts.push(`${formatTokens(usage.reasoningTokens)} reasoning`);
  return parts.join(" · ");
}

/** How long a run took, or has been going for. */
export function runDuration(run: Pick<JobRun, "startedAt" | "finishedAt">, now: number): string {
  return formatDuration(Math.max(0, (run.finishedAt ?? now) - run.startedAt));
}

/**
 * The room backdrop's activity marker on Talk to Portal, matching the session pages: working while Portal
 * answers the user in any thread, waiting while an approval is pending, idle otherwise. Background
 * jobs do not make the user wait.
 */
export function portalActivity(status: OrchestratorStatus | null, approvals: readonly Pick<Approval, "status">[]): AgentActivity {
  if (approvals.some((approval) => approval.status === "pending")) return "waiting";
  if (status && status.busyThreads.length > 0) return "working";
  return "idle";
}

export type StatusLine = {
  /** The server's line, verbatim. */
  line: string;
  /** What the client adds: when the next job is due (and which, while something runs). */
  next: string | null;
  tone: "connecting" | "paused" | "running" | "idle";
};

/**
 * The live status line: the server's `line` as it is, plus the next job's time computed here so
 * it keeps counting down between status events. While runs are going the line already names
 * them, so the next job gets its title too; while idle the line names it, so only the time is added.
 */
export function describeStatusLine(status: OrchestratorStatus | null, now: number): StatusLine {
  if (!status) return { line: "Connecting…", next: null, tone: "connecting" };
  if (!status.ready) return { line: status.line, next: null, tone: "paused" };
  const running = status.runs.length > 0;
  // A job already due (the worker has not claimed it yet) is about to run, not "3 min ago".
  const when = status.nextJob ? relativeTime(Math.max(status.nextJob.at, now + 1), now) : null;
  const next = status.nextJob ? (running ? `next: ${status.nextJob.title} ${when}` : when) : null;
  return { line: status.line, next, tone: running ? "running" : "idle" };
}
