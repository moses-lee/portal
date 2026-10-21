/**
 * Monitoring (docs/MONITORING.md): the sampler, the attributed process table, the disk survey, and
 * the rows the view shows, built from the probe and the other services. Numbers only: nothing here
 * acts on its own; the one action is the manual process stop.
 *
 * - The system sampler runs every 60 s from boot and feeds the portal stream's `monitoring` summary.
 * - The process table is read when asked, at most once per 5 s whoever asks (the view polls).
 * - The disk survey starts when a snapshot finds it older than 10 minutes, or on refresh.
 */
import os from "node:os";
import type {
  AttributedProcess, DiskSurvey, MonitoringDisk, MonitoringPoint, MonitoringSessionRow, MonitoringSnapshot, MonitoringSummary,
  MonitoringWorktreeRow, SystemSample,
} from "@portal/contracts/monitoring";
import type { Settings } from "@portal/shared/settings";
import { diskLevel } from "@portal/shared/monitoring";
import { sessionState } from "@portal/shared/session-state";
import type { AppContext } from "../context.ts";
import { httpError } from "../http/errors.ts";
import { idleStopAt } from "../lib/acp-runtime.ts";
import { removalAt } from "../lib/lifecycle-sweep.ts";
import { type ProcessTable, findSessionRoot, readProcessTable } from "../lib/process-probe.ts";
import { STOP_GRACE_MS, terminate } from "../lib/process-stop.ts";
import { type AttributionInput, attribute, cwdCandidates } from "./attribution.ts";
import { type DiskSurveyDeps, type DiskSurveyor, createDiskSurveyor, liveDu } from "./disk.ts";
import { type MonitoringProbe, createProbe } from "./probe/index.ts";
import { type Sampler, SAMPLE_EVERY_MS, createSampler } from "./sampler.ts";

/** A process table this fresh is reused by whoever asks. */
export const PROCESSES_FRESH_MS = 5_000;
/** A snapshot starts a disk survey when the last one is older than this. */
export const SURVEY_STALE_MS = 10 * 60_000;
/** The web and database processes are looked up again after this long. */
const PORTAL_PIDS_FRESH_MS = 30_000;
/** How far a process's start, worked out from `ps`'s one-second `etime`, may move between two reads and still be the same process. */
const STOP_START_SLACK_MS = 3_000;
/** The view lists this many of the largest processes nothing claims. */
const OTHER_PROCESSES = 15;

/** One read of the process table with every row attributed. */
export type AttributedTable = { at: number; table: ProcessTable; rows: AttributedProcess[] };

export type MonitoringOptions = {
  /** The OS probe; null is an unsupported OS. Defaults to the one for `process.platform`. */
  probe?: MonitoringProbe | null;
  /** False leaves the sampler's timer off (tests sample by hand). */
  start?: boolean;
  sampleEveryMs?: number;
  now?: () => number;
  readTable?: () => Promise<ProcessTable | null>;
  du?: DiskSurveyDeps["du"];
  /** The server's pid, which no stop may reach. */
  serverPid?: number;
  /** SIGTERM to SIGKILL, for the manual stop. */
  stopGraceMs?: number;
  /** Sends the manual stop's signals; tests pass a fake. */
  terminate?: typeof terminate;
};

export interface MonitoringService {
  supported: boolean;
  sampler: Sampler | null;
  disk: DiskSurveyor;
  snapshot(): Promise<MonitoringSnapshot>;
  /** Starts a disk survey now (or joins the running one) and answers the disk state. */
  refreshDisk(): MonitoringDisk;
  /** The attributed table, read fresh unless one is at most 5 s old. Null when it cannot be read. */
  processes(): Promise<AttributedTable | null>;
  /**
   * Stops a process from a table at most 5 s old: SIGTERM to its group when it leads one, else to
   * it, then SIGKILL after the grace. Refuses (with an HTTP status) a pid that is not in the table
   * (404), one whose row is not `stoppable` (403, with the row's reason), and one that is no longer
   * the process the decision was made on when the table is read again just before the signal
   * (404 gone, 409 changed).
   */
  stopProcess(pid: number): Promise<{ pid: number; target: "group" | "process" }>;
  /** The summary of the latest sample, or null before the first (or on an unsupported OS). */
  summary(): MonitoringSummary | null;
  /** Called with the summary after every sample; answers the unsubscribe function. */
  subscribe(listener: (summary: MonitoringSummary) => void): () => void;
  dispose(): Promise<void>;
}

/** The loopback port of the database in `url`, or null for a remote or unreadable one (its processes are not on this host). */
export function localDatabasePort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) return null;
    return Number(parsed.port || 5432);
  } catch {
    return null;
  }
}

export function toPoint(sample: SystemSample): MonitoringPoint {
  return {
    at: sample.at,
    memoryUsedBytes: sample.memory.usedBytes,
    swapUsedBytes: sample.swap.usedBytes,
    diskFreeBytes: sample.volumes[0]?.freeBytes ?? null,
    pressure: sample.pressure.level,
  };
}

/** The stream's summary of `sample`, with the disk level by `levels` and the survey's largest items. */
export function summarize(sample: SystemSample, levels: Settings["monitoring"]["disk"], survey: DiskSurvey | null): MonitoringSummary {
  const volume = sample.volumes[0];
  return {
    at: sample.at,
    pressure: sample.pressure.level,
    memory: { usedBytes: sample.memory.usedBytes, totalBytes: sample.memory.totalBytes },
    swap: { usedBytes: sample.swap.usedBytes, totalBytes: sample.swap.totalBytes },
    disk: volume ? { path: volume.path, freeBytes: volume.freeBytes, totalBytes: volume.totalBytes, level: diskLevel(volume.freeBytes, levels) } : null,
    largest: survey?.largest ?? [],
    surveyedAt: survey?.finishedAt ?? null,
  };
}

export function createMonitoringService(
  ctx: Pick<AppContext, "config" | "log" | "sessions" | "projects" | "settings" | "sql">,
  {
    probe = createProbe(), start = true, sampleEveryMs = SAMPLE_EVERY_MS, now = Date.now, readTable = readProcessTable, du = liveDu,
    serverPid = process.pid, stopGraceMs = STOP_GRACE_MS, terminate: stop = terminate,
  }: MonitoringOptions = {},
): MonitoringService {
  const listeners = new Set<(summary: MonitoringSummary) => void>();
  let lastSummary: MonitoringSummary | null = null;
  const warn = (what: string) => (err: unknown) => ctx.log.warn(`Monitoring: ${what} (${err instanceof Error ? err.message : String(err)}).`);

  const worktreeProjects = () => ctx.projects.list().filter((project) => project.worktree);
  const watchedFolders = async () => (await ctx.settings.read()).monitoring.watchedFolders;

  const disk = createDiskSurveyor({
    now,
    portalHome: ctx.config.portalHome,
    worktrees: () => worktreeProjects().map((project) => ({ projectId: project.id, name: project.name, path: project.path })),
    watchedFolders,
    du,
    async database() {
      const [size] = await ctx.sql<{ bytes: string }[]>`select pg_database_size(current_database())::text as bytes`;
      const tables = await ctx.sql<{ name: string; bytes: string }[]>`
        select c.relname as name, pg_total_relation_size(c.oid)::text as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
        order by pg_total_relation_size(c.oid) desc
        limit 5`;
      return { bytes: Number(size.bytes), tables: tables.map((table) => ({ name: table.name, bytes: Number(table.bytes) })) };
    },
  });

  async function publish(sample: SystemSample) {
    const settings = await ctx.settings.read();
    lastSummary = summarize(sample, settings.monitoring.disk, disk.current());
    for (const listener of listeners) {
      try {
        listener(lastSummary);
      } catch (err) {
        warn("a summary listener failed")(err);
      }
    }
  }

  const sampler = probe
    ? createSampler({
      probe,
      // Portal's home first: its volume is the one the levels and the jar read.
      folders: async () => [ctx.config.portalHome, os.homedir(), ...(await watchedFolders()), ...worktreeProjects().map((project) => project.path)],
      now,
      everyMs: start ? sampleEveryMs : 0,
      onSample: (sample) => void publish(sample).catch(warn("could not publish a sample")),
      onError: warn("could not take a system sample"),
    })
    : null;

  // The web server's and the database's processes change rarely; they are looked up every 30 s at most.
  let portalPids: { at: number; web: number[]; database: number[] } | null = null;
  async function lookUpPortalPids(table: ProcessTable): Promise<{ web: number[]; database: number[] }> {
    if (portalPids && now() - portalPids.at < PORTAL_PIDS_FRESH_MS) return portalPids;
    const dbPort = localDatabasePort(ctx.config.databaseUrl);
    const [web, dbListeners] = await Promise.all([
      probe!.listeningPids(ctx.config.webPort).catch(() => []),
      dbPort === null ? Promise.resolve([]) : probe!.listeningPids(dbPort).catch(() => []),
    ]);
    // A local Postgres listens itself; anything else on the port forwards to a container. The
    // container is looked for even when no listener was seen (on Linux `ss` does not show root's).
    const local = dbListeners.some((pid) => /\bpostgres\b/.test(table.rows.get(pid)?.command ?? ""));
    const container = dbPort !== null && !local ? await probe!.containerPids(table, dbPort, dbListeners).catch(() => []) : [];
    portalPids = { at: now(), web, database: [...dbListeners, ...container] };
    return portalPids;
  }

  /** Every session whose agent is attached, with what the runtime knows of it. */
  function liveSessions() {
    return ctx.sessions.listSessions().flatMap((meta) => {
      const session = ctx.sessions.getSession(meta.id);
      const pid = session?.process?.proc.pid;
      if (!session || !session.process || session.process.failure || session.link.status !== "live" || typeof pid !== "number") return [];
      return [{ meta, session, agentPid: pid }];
    });
  }

  let latest: AttributedTable | null = null;
  let reading: Promise<AttributedTable | null> | null = null;

  async function readAttributed(): Promise<AttributedTable | null> {
    if (!probe) return null;
    const [table, memory] = await Promise.all([readTable(), probe.processMemory().catch(() => null)]);
    if (!table) return null;
    const live = liveSessions();
    const { web, database } = await lookUpPortalPids(table);
    const input: AttributionInput = {
      table,
      memory,
      sessions: live.map(({ meta, session, agentPid }) => ({ sessionId: meta.id, agentPid, marker: session.upstreamId })),
      adapterPids: [...new Set(live.map(({ agentPid }) => agentPid))],
      serverPid,
      webPids: web,
      databasePids: database,
      worktrees: worktreeProjects().map((project) => ({ projectId: project.id, path: project.path })),
    };
    const cwds = await probe.workingFolders(cwdCandidates(input)).catch(() => new Map<number, string>());
    latest = { at: table.at, table, rows: attribute({ ...input, cwds }) };
    return latest;
  }

  function processes(): Promise<AttributedTable | null> {
    if (latest && now() - latest.at < PROCESSES_FRESH_MS) return Promise.resolve(latest);
    reading ??= readAttributed().catch((err: unknown) => {
      warn("could not read the process table")(err);
      return null;
    }).finally(() => { reading = null; });
    return reading;
  }

  function diskState(): MonitoringDisk {
    const survey = disk.current();
    return { survey, ageMs: survey ? Math.max(0, now() - survey.finishedAt) : null, running: disk.running() };
  }

  async function snapshot(): Promise<MonitoringSnapshot> {
    const settings = await ctx.settings.read();
    const levels = settings.monitoring.disk;
    if (!probe || !sampler) {
      return {
        supported: false, now: now(), levels, sample: null, diskLevel: null, history: [], processesAt: null, processes: [],
        sessions: [], worktrees: [], disk: diskState(),
      };
    }
    const survey = disk.current();
    if (!disk.running() && (!survey || now() - survey.finishedAt > SURVEY_STALE_MS)) void disk.start();
    const sizes = new Map(survey?.worktrees.map((entry) => [entry.projectId, entry.bytes]) ?? []);

    const [sample, attributed] = await Promise.all([sampler.latest() ? Promise.resolve(sampler.latest()) : sampler.sample(), processes()]);
    const rows = attributed?.rows ?? [];
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const charged = (match: (row: AttributedProcess) => boolean) => {
      const own = rows.filter(match);
      return { pids: own.map((row) => row.pid), memoryBytes: own.reduce((sum, row) => sum + row.memoryBytes, 0), processCount: own.length };
    };

    const projects = ctx.projects.list();
    const projectName = new Map(projects.map((project) => [project.id, project.name]));
    const idleStop = settings.sessions.idleStop;
    const idleStopConfig = { enabled: idleStop?.enabled ?? false, afterMs: (idleStop?.afterMinutes ?? 0) * 60_000 };
    const sessions: MonitoringSessionRow[] = liveSessions().map(({ meta, session, agentPid }) => {
      const own = charged((row) => row.owner.kind === "session" && row.owner.sessionId === meta.id);
      const rootPid = attributed ? findSessionRoot(attributed.table, agentPid, session.upstreamId) : null;
      return {
        sessionId: meta.id,
        title: meta.title,
        projectId: meta.projectId,
        projectName: projectName.get(meta.projectId) ?? null,
        agentId: meta.agentId,
        agentName: meta.agentName,
        busy: meta.busy,
        awaitingPermission: meta.awaitingPermission,
        state: sessionState({ busy: meta.busy, awaitingPermission: meta.awaitingPermission, link: meta.link, liveness: meta.liveness.state }),
        rootPid: rootPid !== null && byPid.has(rootPid) ? rootPid : null,
        ...own,
        idleSince: meta.idleSince,
        attachedAt: session.attachedAt ?? null,
        idleStopAt: idleStopAt(session, idleStopConfig),
      };
    });

    const metas = ctx.sessions.listSessions();
    const removeAfterHours = settings.sessions.worktrees.removeAfterHours;
    const worktrees: MonitoringWorktreeRow[] = projects.flatMap((project) => {
      if (!project.worktree) return [];
      const own = metas.filter((meta) => meta.projectId === project.id);
      const due = removalAt(project, own, removeAfterHours);
      return [{
        projectId: project.id,
        name: project.name,
        path: project.path,
        branch: project.worktree.branch,
        sizeBytes: sizes.get(project.id) ?? null,
        sessionCount: own.length,
        ...charged((row) => row.owner.kind === "worktree" && row.owner.projectId === project.id),
        pinned: project.pinnedAt !== null,
        removalAt: due,
        keptReason: project.keptReason,
        keptSince: project.keptReason ? due : null,
      }];
    });

    const claimed = rows.filter((row) => row.owner.kind !== "none");
    const others = rows.filter((row) => row.owner.kind === "none").sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, OTHER_PROCESSES);
    const volume = sample?.volumes[0];
    return {
      supported: true,
      now: now(),
      levels,
      sample,
      diskLevel: volume ? diskLevel(volume.freeBytes, levels) : null,
      history: sampler.history().map(toPoint),
      processesAt: attributed?.at ?? null,
      processes: [...claimed, ...others].sort((a, b) => b.memoryBytes - a.memoryBytes),
      sessions,
      worktrees,
      disk: diskState(),
    };
  }

  async function stopProcess(pid: number) {
    // The decision is made on a table at most 5 s old (`processes` reads a new one otherwise).
    const attributed = await processes();
    if (!attributed) throw httpError("The process table could not be read.", 503);
    const row = attributed.rows.find((entry) => entry.pid === pid);
    const decided = attributed.table.rows.get(pid);
    if (!row || !decided) throw httpError(`Process ${pid} is not in the latest process table.`, 404);
    if (!row.stoppable) throw httpError(`Portal does not stop process ${pid}: ${row.stopBlockedReason ?? "it is not stoppable"}.`, 403);
    const group = row.pgid === row.pid;
    // Belt and braces: whatever the rules say, never the server, its group, or pid 1.
    const serverGroup = attributed.table.rows.get(serverPid)?.pgid ?? serverPid;
    if (pid === serverPid || pid <= 1 || row.pgid === serverGroup) throw httpError(`Stopping process ${pid} would stop the Portal server.`, 403);
    // Just before the signal, the process must still be the one decided on: same pid, command and
    // start (a pid is handed out again once its process is gone), and, for a group, still its leader.
    const fresh = await readTable();
    if (!fresh) throw httpError("The process table could not be read.", 503);
    const current = fresh.rows.get(pid);
    if (!current) throw httpError(`Process ${pid} is no longer running.`, 404);
    const sameStart = Math.abs((fresh.at - current.elapsedMs) - (attributed.table.at - decided.elapsedMs)) <= STOP_START_SLACK_MS;
    if (current.command !== decided.command || !sameStart || (group && current.pgid !== pid)) {
      latest = null;
      throw httpError(`Process ${pid} changed since the process table was read; refresh and try again.`, 409);
    }
    stop([group ? { pgid: row.pgid } : { pid }], { graceMs: stopGraceMs });
    // The next read must not offer what was just stopped.
    latest = null;
    return { pid, target: group ? "group" as const : "process" as const };
  }

  return {
    supported: probe !== null,
    sampler,
    disk,
    snapshot,
    refreshDisk() {
      void disk.start();
      return diskState();
    },
    processes,
    stopProcess,
    summary: () => lastSummary,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      sampler?.dispose();
      listeners.clear();
      await disk.dispose();
    },
  };
}
