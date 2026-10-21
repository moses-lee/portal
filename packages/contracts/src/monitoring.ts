/**
 * Wire types for Monitoring (docs/MONITORING.md): memory, swap, pressure and disk, and the
 * processes and folders that use them, attributed to sessions, worktrees and Portal itself. The
 * server measures; the view and the room only read. The pure helpers (levels, pressure mapping)
 * are in `@portal/shared/monitoring`.
 *
 * Only erasable TypeScript here (types and plain values), so Node can load it without a build step.
 *
 * HTTP surface:
 *   GET  /api/monitoring                        MonitoringSnapshot
 *   POST /api/monitoring/disk/refresh           -> { disk: MonitoringDisk } (origin-checked; starts a survey now)
 *   POST /api/monitoring/processes/:pid/stop    -> { pid, target: "group" | "process" } (origin-checked; refused unless the row is `stoppable`)
 * Live: the portal stream pushes `{ type: "monitoring", summary }` after every system sample (60 s).
 */

/** One scale for memory pressure on every OS, and for disk levels. */
export type MonitoringLevel = "normal" | "warning" | "critical";
export const monitoringLevels: readonly MonitoringLevel[] = ["normal", "warning", "critical"];

/** Free and total space of one volume Portal cares about; `path` is the first such folder found on it. */
export type MonitoringVolume = { path: string; totalBytes: number; freeBytes: number };

/** One reading of memory, swap, pressure, and free disk. */
export type SystemSample = {
  at: number;
  memory: { totalBytes: number; availableBytes: number; usedBytes: number };
  swap: { totalBytes: number; usedBytes: number };
  /** `raw` is what the OS said, for the tooltip: the macOS level number or the Linux PSI line. */
  pressure: { level: MonitoringLevel; raw: string };
  /** The volume holding Portal's home first, then any other volume a watched folder or worktree is on. */
  volumes: MonitoringVolume[];
};

/** A history point for the charts: one per system sample, smaller than the sample itself. */
export type MonitoringPoint = {
  at: number;
  memoryUsedBytes: number;
  swapUsedBytes: number;
  /** Free space on the volume holding Portal's home; null when it could not be read. */
  diskFreeBytes: number | null;
  pressure: MonitoringLevel;
};

/** One process from the process table. */
export type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  elapsedSeconds: number;
  cpuSeconds: number;
  /** Footprint on macOS (what Activity Monitor shows), RSS where that cannot be read and on Linux. */
  memoryBytes: number;
  command: string;
  /** Looked up only for processes above the 20 MB floor that no session or Portal claims; null otherwise or when unreadable. */
  cwd: string | null;
};

/** What Portal itself runs. */
export type PortalRole = "server" | "adapter" | "web" | "database";

/** Who a process is charged to; the first rule that matches wins (docs/MONITORING.md, Attribution). */
export type ProcessOwner =
  | { kind: "session"; sessionId: string }
  | { kind: "portal"; role: PortalRole }
  | { kind: "worktree"; projectId: string }
  | { kind: "none" };

export type AttributedProcess = ProcessRow & {
  owner: ProcessOwner;
  /**
   * Set when the owner (always a worktree) was inherited: the pid of the nearest ancestor that
   * matched on its own. Null when the process matched itself, or matched nothing.
   */
  inheritedFrom: number | null;
  /** Charged to a session or a worktree, and its parent is pid 1: nothing of Portal's will end it. */
  orphan: boolean;
  /** Whether "Stop process" may stop it; the stop route refuses exactly when this is false. */
  stoppable: boolean;
  /** Why it may not be stopped, in a few words ("Portal's database", "inherited from pid 812; stop that process"); null when `stoppable`. */
  stopBlockedReason: string | null;
};

/** One session with a live agent link. */
export type MonitoringSessionRow = {
  sessionId: string;
  title: string | null;
  projectId: string;
  projectName: string | null;
  agentId: string;
  agentName: string;
  busy: boolean;
  awaitingPermission: boolean;
  /** The shared `sessionState` of the session, as the sidebar shows it. */
  state: "approval" | "hung" | "offline" | "connecting" | "working" | "background" | "finished";
  /** The session's own CLI process; null for agents that serve every session from one process (Codex). */
  rootPid: number | null;
  /** The CLI and every process below it, parents first. */
  pids: number[];
  memoryBytes: number;
  processCount: number;
  /** Since when the session has had no open turn, approval or background work; null while it has any. */
  idleSince: number | null;
  /** When the agent was last attached; null where the runtime does not say. */
  attachedAt: number | null;
  /** When the idle stop is due (`max(idleSince, attachedAt)` plus the setting); null when idle stop is off or the session is not idle. */
  idleStopAt: number | null;
};

/** One Portal worktree project. */
export type MonitoringWorktreeRow = {
  projectId: string;
  name: string;
  path: string;
  branch: string;
  /** From the last disk survey; null before the first or when `du` failed. */
  sizeBytes: number | null;
  sessionCount: number;
  /** Processes charged to the worktree (by working folder or a path in the command line, or inherited from an ancestor that was), parents first. */
  pids: number[];
  memoryBytes: number;
  processCount: number;
  pinned: boolean;
  /** When the lifecycle sweep is due to remove it; null while pinned or while a session is in use. */
  removalAt: number | null;
  /** Why the sweep kept it although it was due ("uncommitted changes"); null when nothing holds it. */
  keptReason: string | null;
  /** When it became due and was kept (the removal time it missed); null with no `keptReason`. */
  keptSince: number | null;
};

/** One measured folder; `bytes` is null when `du` failed. */
export type DiskEntry = { path: string; bytes: number | null };

export type WatchedFolderChild = { name: string; bytes: number | null; modifiedAt: number | null };

export type WatchedFolder = {
  /** As configured, `~` expanded. */
  path: string;
  exists: boolean;
  /** The sum of its immediate children; null when it does not exist or could not be read. */
  bytes: number | null;
  /** The 10 largest immediate children, largest first. */
  children: WatchedFolderChild[];
};

/** One of the largest things the survey found, for the jar's card and the disk section. */
export type DiskLargest = { label: string; path: string | null; bytes: number };

/** Cached folder sizes (docs/MONITORING.md, Disk survey). Sizes come from `du`, so APFS clones and hard links count in each place. */
export type DiskSurvey = {
  startedAt: number;
  finishedAt: number;
  home: {
    path: string;
    worktreesBytes: number;
    blobsBytes: number | null;
    logsBytes: number | null;
    otherBytes: number;
  };
  /** Each Portal worktree project's folder, by project id. */
  worktrees: (DiskEntry & { projectId: string })[];
  /** Folders under `<home>/worktrees` that no listed project uses. */
  strayWorktrees: DiskEntry[];
  watched: WatchedFolder[];
  /** Null when the database could not be asked. */
  database: { bytes: number; tables: { name: string; bytes: number }[] } | null;
  /** The five largest of the above (worktrees, home parts, database, watched folders), largest first. */
  largest: DiskLargest[];
};

export type MonitoringDisk = {
  survey: DiskSurvey | null;
  /** Milliseconds since the survey finished; null without one. */
  ageMs: number | null;
  /** True while a survey runs. */
  running: boolean;
};

/** `GET /api/monitoring`. */
export type MonitoringSnapshot = {
  /** False on an OS without a probe; every reading below is then null or empty. */
  supported: boolean;
  now: number;
  /** The disk levels in force, in GB (10^9 bytes). */
  levels: { warnFreeGb: number; criticalFreeGb: number };
  sample: SystemSample | null;
  /** The level of the volume holding Portal's home, by the configured levels. */
  diskLevel: MonitoringLevel | null;
  /** The last 24 h of samples, oldest first, one a minute. */
  history: MonitoringPoint[];
  /** When the process table was read; null when it could not be. */
  processesAt: number | null;
  /** Every attributed process, then the 15 largest that nothing claims; largest first. */
  processes: AttributedProcess[];
  sessions: MonitoringSessionRow[];
  worktrees: MonitoringWorktreeRow[];
  disk: MonitoringDisk;
};

/** The portal stream's `monitoring` event: just enough for the room's barometer and jar and the summary strip. */
export type MonitoringSummary = {
  at: number;
  pressure: MonitoringLevel;
  memory: { usedBytes: number; totalBytes: number };
  swap: { usedBytes: number; totalBytes: number };
  /** The volume holding Portal's home; null when it could not be read. */
  disk: { path: string; freeBytes: number; totalBytes: number; level: MonitoringLevel } | null;
  /** The five largest items of the last survey, largest first; empty before the first. */
  largest: DiskLargest[];
  /** When the last survey finished; null before the first. */
  surveyedAt: number | null;
};
