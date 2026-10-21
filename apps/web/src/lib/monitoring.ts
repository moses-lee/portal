/**
 * The Monitoring view's rows and wording (docs/MONITORING.md, The Monitoring view): the summary
 * tiles and their levels, the session, worktree, Portal and other process rows, the charts' lines
 * and level bands, and the disk section's split. Pure, so the node test runner can load it; the
 * server measures and attributes, these only arrange what `GET /api/monitoring` answered.
 */
import type {
  AttributedProcess,
  DiskSurvey,
  FolderCheckResult,
  MonitoringDisk,
  MonitoringLevel,
  MonitoringPoint,
  MonitoringSessionRow,
  MonitoringSnapshot,
  MonitoringWorktreeRow,
  PortalRole,
} from "@portal/contracts/monitoring";
import { BYTES_PER_GB, formatBytes } from "@portal/shared/monitoring";
import { relativeTime } from "./orchestrator/format.ts";
import { countdownText } from "./session-lifecycle.ts";

export { formatBytes };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A worktree kept for uncommitted changes longer than this is highlighted (fixed in code). */
export const KEPT_HIGHLIGHT_MS = 7 * DAY;
/** How many unattributed processes the Other section lists. */
export const OTHER_PROCESSES = 15;

export const levelLabels: Record<MonitoringLevel, string> = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
};

/** A level's colour, as the views' badge tones name them: normal neutral, warning amber, critical red. */
export const levelTones: Record<MonitoringLevel, "neutral" | "amber" | "rose"> = {
  normal: "neutral",
  warning: "amber",
  critical: "rose",
};

/** Whole GB for the disk levels: `30 GB`. */
export const formatGb = (gb: number) => `${gb} GB`;

/** "2d 4h", "35m": a span of time already passed, at a glance. Under a minute reads "<1m". */
export function spanText(ms: number): string {
  const text = countdownText(ms);
  return text === "soon" ? "<1m" : text;
}

/** "9 days", "5 hours", "20 minutes": a duration in the largest whole unit, for sentences. */
export function durationWords(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms >= DAY) return plural(Math.floor(ms / DAY), "day");
  if (ms >= HOUR) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.max(1, Math.floor(ms / MINUTE)), "minute");
}

export type SummaryTile = {
  key: "memory" | "swap" | "disk" | "agents";
  label: string;
  value: string;
  detail: string;
  level: MonitoringLevel;
};

/**
 * The summary strip's four tiles; null without a sample. Memory follows pressure; swap follows
 * pressure too, having no level of its own; disk follows the configured levels; the agents tile
 * has no level of its own and stays neutral.
 */
export function summaryTiles(snapshot: MonitoringSnapshot): SummaryTile[] | null {
  const sample = snapshot.sample;
  if (!sample) return null;
  const pressure = sample.pressure.level;
  const volume = sample.volumes[0] ?? null;
  const agents = agentsTotal(snapshot);
  const swapShare = sample.swap.totalBytes > 0 ? Math.round((sample.swap.usedBytes / sample.swap.totalBytes) * 100) : 0;
  return [
    {
      key: "memory",
      label: "Memory",
      value: `${formatBytes(sample.memory.usedBytes, "memory")} of ${formatBytes(sample.memory.totalBytes, "memory")}`,
      detail: `Pressure ${levelLabels[pressure].toLowerCase()}`,
      level: pressure,
    },
    {
      key: "swap",
      label: "Swap",
      value: sample.swap.totalBytes > 0
        ? `${formatBytes(sample.swap.usedBytes, "memory")} of ${formatBytes(sample.swap.totalBytes, "memory")}`
        : formatBytes(sample.swap.usedBytes, "memory"),
      detail: sample.swap.totalBytes > 0 ? `${swapShare} % used` : "No swap in use",
      level: pressure,
    },
    {
      key: "disk",
      label: "Disk",
      value: volume ? `${formatBytes(volume.freeBytes)} free` : "—",
      detail: volume ? `of ${formatBytes(volume.totalBytes)} on ${volume.path}` : "Could not read the volume",
      level: snapshot.diskLevel ?? "normal",
    },
    {
      key: "agents",
      label: "Agents",
      value: `${agents.count} live ${agents.count === 1 ? "CLI" : "CLIs"}`,
      detail: `${formatBytes(agents.memoryBytes, "memory")} combined`,
      level: "normal",
    },
  ];
}

/**
 * The live agent CLIs and their memory: every session tree, plus the adapters (Codex serves all its
 * sessions from one adapter process, which no single session is charged with).
 */
export function agentsTotal(snapshot: Pick<MonitoringSnapshot, "sessions" | "processes">): { count: number; memoryBytes: number } {
  const sessionsBytes = snapshot.sessions.reduce((sum, row) => sum + row.memoryBytes, 0);
  const adapterBytes = snapshot.processes
    .filter((row) => row.owner.kind === "portal" && row.owner.role === "adapter")
    .reduce((sum, row) => sum + row.memoryBytes, 0);
  return { count: snapshot.sessions.length, memoryBytes: sessionsBytes + adapterBytes };
}

/** Whether the view offers Stop: exactly when the stop route would act (the server decides, `stoppable`). */
export const canStop = (process: Pick<AttributedProcess, "stoppable">): boolean => process.stoppable;

/** Why Stop is not offered, for the note where the button would be; null when it is. */
export function stopHint(process: Pick<AttributedProcess, "stoppable" | "stopBlockedReason">): string | null {
  if (canStop(process)) return null;
  return process.stopBlockedReason ?? "Portal does not stop this process.";
}

export type TreeRow = { process: AttributedProcess; depth: number };

/**
 * `pids` (parents first, as the server lists them) as an indented tree: a process's depth is one
 * more than its parent's when the parent is in the list. Pids missing from the table are skipped.
 */
export function processTree(processes: readonly AttributedProcess[], pids: readonly number[]): TreeRow[] {
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const depth = new Map<number, number>();
  const rows: TreeRow[] = [];
  for (const pid of pids) {
    const process = byPid.get(pid);
    if (!process) continue;
    const parent = depth.get(process.ppid);
    const level = parent === undefined ? 0 : parent + 1;
    depth.set(pid, level);
    rows.push({ process, depth: level });
  }
  return rows;
}

/** The last part of a process's command: the program and its first arguments, for a narrow cell. */
export function commandName(command: string): string {
  const [program = "", ...rest] = command.trim().split(/\s+/);
  const base = program.split("/").pop() || program;
  const shown = [base, ...rest].join(" ");
  return shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
}

export type SessionRowView = MonitoringSessionRow & {
  /** "idle 2h 5m", or "active" while a turn, approval or background work is open. */
  idleText: string;
  /** When the idle stop fires: "in 1h 55m", "soon", "off" (setting off), or "—" while not idle. */
  stopText: string;
};

/** The Sessions section's rows: most memory first. */
export function sessionRows(snapshot: Pick<MonitoringSnapshot, "sessions">, now: number): SessionRowView[] {
  return [...snapshot.sessions]
    .sort((a, b) => b.memoryBytes - a.memoryBytes)
    .map((row) => ({
      ...row,
      idleText: row.idleSince === null ? "active" : `idle ${spanText(now - row.idleSince)}`,
      // The server leaves `idleStopAt` empty both when the stop is off and when the session is busy; only an idle session tells them apart.
      stopText: row.idleStopAt !== null ? (row.idleStopAt <= now ? "soon" : `in ${countdownText(row.idleStopAt - now)}`) : row.idleSince === null ? "—" : "off",
    }));
}

export type WorktreeRowView = MonitoringWorktreeRow & {
  /** "removal in 1d 7h", "kept: uncommitted changes for 9 days", "pinned", "in use". */
  lifecycle: string;
  /** Kept for more than seven days: the row is highlighted. */
  stale: boolean;
  /** A session in the worktree has a turn, an approval or background work open: the cleanup script waits. */
  busy: boolean;
};

/** The lifecycle state of a worktree row in words, and whether it has been kept long enough to highlight. */
export function worktreeLifecycle(row: MonitoringWorktreeRow, now: number): { lifecycle: string; stale: boolean } {
  if (row.pinned) return { lifecycle: "pinned", stale: false };
  if (row.keptReason) {
    if (row.keptSince === null) return { lifecycle: `kept: ${row.keptReason}`, stale: false };
    const kept = Math.max(0, now - row.keptSince);
    return { lifecycle: `kept: ${row.keptReason} for ${durationWords(kept)}`, stale: kept > KEPT_HIGHLIGHT_MS };
  }
  if (row.removalAt !== null) return { lifecycle: row.removalAt <= now ? "removal soon" : `removal in ${countdownText(row.removalAt - now)}`, stale: false };
  return { lifecycle: "in use", stale: false };
}

/** The Worktrees section's rows, in the server's (project) order. */
export function worktreeRows(snapshot: Pick<MonitoringSnapshot, "worktrees" | "sessions">, now: number): WorktreeRowView[] {
  return snapshot.worktrees.map((row) => ({
    ...row,
    ...worktreeLifecycle(row, now),
    busy: snapshot.sessions.some((session) => session.projectId === row.projectId && session.idleSince === null),
  }));
}

export const portalRoleLabels: Record<PortalRole, string> = {
  server: "Server",
  web: "Web server",
  adapter: "Adapter",
  database: "Database",
};
const roleOrder: PortalRole[] = ["server", "web", "adapter", "database"];

/** The Portal section: the server, the web server, the adapters, and Postgres, in that order, largest first within each. */
export function portalRows(processes: readonly AttributedProcess[]): (AttributedProcess & { role: PortalRole })[] {
  return processes
    .flatMap((row) => (row.owner.kind === "portal" ? [{ ...row, role: row.owner.role }] : []))
    .sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || b.memoryBytes - a.memoryBytes);
}

/** The Other section: the largest processes nothing claims, read-only. */
export function otherRows(processes: readonly AttributedProcess[]): AttributedProcess[] {
  return processes
    .filter((row) => row.owner.kind === "none")
    .sort((a, b) => b.memoryBytes - a.memoryBytes)
    .slice(0, OTHER_PROCESSES);
}

/** Portal's home split into its parts, for the disk section. */
export function homeSplit(survey: DiskSurvey): { label: string; bytes: number | null }[] {
  return [
    { label: "Worktrees", bytes: survey.home.worktreesBytes },
    { label: "Blobs", bytes: survey.home.blobsBytes },
    { label: "Logs", bytes: survey.home.logsBytes },
    { label: "Other", bytes: survey.home.otherBytes },
  ];
}

/** "measured 4 min ago", "measuring…" during the first survey, "not measured yet" before it. */
export function measuredText(disk: MonitoringDisk, now: number): string {
  if (disk.ageMs === null) return disk.running ? "measuring…" : "not measured yet";
  const ago = relativeTime(now - disk.ageMs, now);
  return `${disk.running ? "measuring again · last " : ""}measured ${ago}`;
}

/* Charts */

export type ChartPoint = { at: number; value: number | null };
/** A level shown as a band: across the chart's height over a time span (pressure), or across its width over a value range (disk levels). */
export type TimeBand = { from: number; to: number; level: Exclude<MonitoringLevel, "normal"> };
export type ValueBand = { min: number; max: number; level: Exclude<MonitoringLevel, "normal"> };

export type ChartModel = {
  key: "memory" | "swap" | "disk";
  label: string;
  kind: "memory" | "disk";
  points: ChartPoint[];
  /** The top of the y axis: the total where there is one, else the highest reading. */
  yMax: number;
  timeBands: TimeBand[];
  valueBands: ValueBand[];
};

/** Spans of samples read at warning or critical pressure; each sample covers the minute up to the next one. */
export function pressureBands(history: readonly MonitoringPoint[], sampleMs = MINUTE): TimeBand[] {
  const bands: TimeBand[] = [];
  history.forEach((point, index) => {
    const to = history[index + 1]?.at ?? point.at + sampleMs;
    if (point.pressure === "normal") return;
    const last = bands.at(-1);
    if (last && last.level === point.pressure && last.to >= point.at) last.to = to;
    else bands.push({ from: point.at, to, level: point.pressure });
  });
  return bands;
}

/**
 * The three charts from the 24 h history: memory used and swap used with the pressure bands, and
 * free disk with the configured levels as bands under the line.
 */
export function chartModels(snapshot: Pick<MonitoringSnapshot, "history" | "sample" | "levels">): ChartModel[] {
  const history = snapshot.history;
  const sample = snapshot.sample;
  const highest = (values: (number | null)[]) => values.reduce<number>((max, value) => (value !== null && value > max ? value : max), 0);
  const bands = pressureBands(history);
  const memory = history.map((point) => ({ at: point.at, value: point.memoryUsedBytes }));
  const swap = history.map((point) => ({ at: point.at, value: point.swapUsedBytes }));
  const disk = history.map((point) => ({ at: point.at, value: point.diskFreeBytes }));
  const warn = snapshot.levels.warnFreeGb * BYTES_PER_GB;
  const critical = snapshot.levels.criticalFreeGb * BYTES_PER_GB;
  return [
    { key: "memory", label: "Memory used", kind: "memory", points: memory, yMax: Math.max(sample?.memory.totalBytes ?? 0, highest(memory.map((p) => p.value))), timeBands: bands, valueBands: [] },
    { key: "swap", label: "Swap used", kind: "memory", points: swap, yMax: Math.max(sample?.swap.totalBytes ?? 0, highest(swap.map((p) => p.value))), timeBands: bands, valueBands: [] },
    {
      key: "disk",
      label: "Free disk",
      kind: "disk",
      points: disk,
      // Scaled to the readings and the warning level, not the volume: on a 460 GB disk the last 30 GB would be a sliver.
      yMax: Math.max(highest(disk.map((p) => p.value)), warn) * 1.25,
      timeBands: [],
      valueBands: [
        { min: 0, max: critical, level: "critical" },
        { min: critical, max: warn, level: "warning" },
      ],
    },
  ];
}

export type ChartFrame = { from: number; to: number; yMax: number; width: number; height: number };

/** The SVG path of `points` in `frame` (time across, value up from the bottom); a null reading breaks the line. */
export function linePath(points: readonly ChartPoint[], frame: ChartFrame): string {
  const span = Math.max(1, frame.to - frame.from);
  const yMax = frame.yMax > 0 ? frame.yMax : 1;
  let path = "";
  let pen = false;
  for (const point of points) {
    if (point.value === null) {
      pen = false;
      continue;
    }
    const x = ((point.at - frame.from) / span) * frame.width;
    const y = frame.height - (Math.min(point.value, yMax) / yMax) * frame.height;
    path += `${pen ? "L" : "M"}${round(x)},${round(y)}`;
    pen = true;
  }
  return path;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** What `POST /api/projects/:id/cleanup-script` answers: the script's outcome and how long it took (the server's `CleanupScriptResult`). */
export type CleanupScriptResult = {
  ran: true;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

/** "Finished in 4 s", "Exited with code 2 after 1 s", "Timed out after 300 s". */
export function cleanupSummary(result: CleanupScriptResult): string {
  const seconds = `${Math.max(1, Math.round(result.durationMs / 1000))} s`;
  if (result.timedOut) return `Timed out after ${seconds}`;
  if (result.ok) return `Finished in ${seconds}`;
  return result.code === null ? `Failed after ${seconds}` : `Exited with code ${result.code} after ${seconds}`;
}

/**
 * The configured watched folders that `POST /api/monitoring/folders/check` found missing, as
 * configured. Folders the check did not cover (added since it ran) are not called missing.
 */
export function missingWatchedFolders(configured: readonly string[], check: FolderCheckResult | null): string[] {
  if (!check) return [];
  const missing = new Set(check.paths.filter((entry) => !entry.exists).map((entry) => entry.path));
  return configured.filter((entry) => missing.has(entry));
}
