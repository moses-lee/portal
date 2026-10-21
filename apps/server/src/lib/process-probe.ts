/**
 * The machine's process table, read with one `ps` call: who is whose child and in which process
 * group, how long each process has run, how much CPU it has used, and its resident memory.
 * `ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,command=` means the same on macOS and Linux, so no
 * per-platform code is needed there; Windows has no `ps`, and the read answers null. Callers share
 * one read across every session they probe, and liveness and Monitoring share a read in flight.
 */
import { execFile } from "node:child_process";

export type ProcessRow = {
  pid: number;
  ppid: number;
  /** The process group; a group leader has `pgid === pid`. */
  pgid: number;
  /** How long the process has run, at `ProcessTable.at` (one-second resolution). */
  elapsedMs: number;
  /** User plus system CPU time used so far. */
  cpuMs: number;
  /** Resident memory. On macOS it undercounts processes the system has compressed (see monitoring/probe). */
  rssBytes: number;
  command: string;
};

export type ProcessTable = {
  at: number;
  rows: Map<number, ProcessRow>;
  /** Child pids by parent pid. */
  children: Map<number, number[]>;
};

const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,etime=,time=,rss=,command="];
const PS_TIMEOUT_MS = 5_000;
/** Enough for thousands of processes with long command lines. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Milliseconds from a `ps` duration: `etime` is `[[dd-]hh:]mm:ss`; `time` is the same on Linux and
 * `mm:ss.cc` (minutes may pass 59) on macOS. NaN for anything else.
 */
export function parseDuration(text: string): number {
  const match = /^(?:(\d+)-)?(\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2})$/.exec(text.trim());
  if (!match) return NaN;
  const days = match[1] ? Number(match[1]) : 0;
  const parts = match[2].split(":").map(Number).reverse();
  const [seconds = 0, minutes = 0, hours = 0] = parts;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** The table from `ps` output as `PS_ARGS` asks for it; malformed lines are skipped. */
export function parsePs(stdout: string, at: number): ProcessTable {
  const rows = new Map<number, ProcessRow>();
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, etime, time, rss, command] = match;
    const row = {
      pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), elapsedMs: parseDuration(etime), cpuMs: parseDuration(time),
      rssBytes: Number(rss) * 1024, command: command.trim(),
    };
    if (!Number.isFinite(row.elapsedMs) || !Number.isFinite(row.cpuMs)) continue;
    rows.set(row.pid, row);
  }
  for (const row of rows.values()) {
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  return { at, rows, children };
}

let reading: Promise<ProcessTable | null> | null = null;

/**
 * The whole table, or null where `ps` cannot be run (Windows) or fails. A call made while another
 * is running gets that read, so the liveness probe and Monitoring never run `ps` twice at once.
 */
export function readProcessTable(): Promise<ProcessTable | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  reading ??= new Promise<ProcessTable | null>((resolve) => {
    execFile("ps", PS_ARGS, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } }, (error, stdout) => {
      resolve(error ? null : parsePs(stdout, Date.now()));
    });
  }).finally(() => { reading = null; });
  return reading;
}

/** Every process below `pid` (not `pid` itself), parents before their children. */
export function descendants(table: ProcessTable, pid: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const seen = new Set<number>([pid]);
  const queue = [...(table.children.get(pid) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const row = table.rows.get(next);
    if (!row) continue;
    found.push(row);
    queue.push(...(table.children.get(next) ?? []));
  }
  return found;
}

/**
 * The process below `agentPid` that runs one session: the shallowest one whose command line names
 * `marker` (Claude Code starts `claude ... --session-id=<id>` or `--resume <id>` per session). Null
 * when none does, as for agents that serve every session from one process.
 */
export function findSessionRoot(table: ProcessTable, agentPid: number, marker: string): number | null {
  if (!marker) return null;
  return descendants(table, agentPid).find((row) => row.command.includes(marker))?.pid ?? null;
}
