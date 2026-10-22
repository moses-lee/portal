/**
 * The adapters' process groups (docs/MONITORING.md, "Process cleanup"). Every ACP adapter leads a
 * process group of its own, so stopping it stops what it started (Claude Code CLIs, Codex's
 * app-server). While they run, the groups are listed in `<portalHome>/run/adapters.json`; on boot,
 * a group a crashed or SIGKILLed server left behind is killed before new adapters start.
 *
 * A pgid is only a number, and the system hands it out again once its group is gone, so a listed
 * group is killed only when what is in it still looks like the adapter Portal started
 * (`leftoverGroup`). Each entry names the server that started it (pid and start time): another
 * server sharing the Portal home (a scratch instance, a test's second app) is still running its
 * groups, and those are left alone. The file is re-read before every change, so servers sharing it
 * do not drop each other's entries, and written synchronously: it is small, and a write must be on
 * disk before a crash can make it matter.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ProcessRow, type ProcessTable, readProcessTable } from "./process-probe.ts";
import { type StopTarget, terminate } from "./process-stop.ts";

/** A server process: its pid and when it started (epoch ms), which together tell it from a later process with the same pid. */
export type ServerIdentity = { pid: number; startedAt: number };

/** One adapter group as listed in the file. */
export type AdapterGroup = {
  pgid: number;
  /** The adapter's command line as `ps` shows it: the command and its arguments, joined by spaces. */
  command: string;
  /** When Portal started the adapter, epoch ms. */
  startedAt: number;
  /** The server that started it; absent in entries written before servers were recorded. */
  server?: ServerIdentity;
};

/** This process as a `ServerIdentity`. */
export function thisServer(): ServerIdentity {
  return { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };
}

/** How far a process's start, worked out from `ps`'s one-second `etime`, may sit from the recorded one. */
const START_SLACK_MS = 5_000;

export type AdapterGroupFile = {
  list(): AdapterGroup[];
  /** Lists a group this server started (`server` is filled in). */
  add(group: Omit<AdapterGroup, "server">): void;
  remove(pgid: number): void;
};

/**
 * The groups file at `file`; a missing or unreadable file lists nothing, and a failed write is
 * logged, never thrown. `server` is who the added entries name (this process unless a test says).
 */
export function createAdapterGroupFile(
  file: string,
  warn: (message: string) => void = console.warn,
  { server = thisServer() }: { server?: ServerIdentity } = {},
): AdapterGroupFile {
  const save = (groups: AdapterGroup[]) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify({ groups }, null, 2)}\n`);
      renameSync(temporary, file);
    } catch (err) {
      warn(`Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    list: () => readGroups(file),
    add(group) {
      save([...readGroups(file).filter((entry) => entry.pgid !== group.pgid), { ...group, server }]);
    },
    remove(pgid) {
      const groups = readGroups(file);
      if (!groups.some((entry) => entry.pgid === pgid)) return;
      save(groups.filter((entry) => entry.pgid !== pgid));
    },
  };
}

function readGroups(file: string): AdapterGroup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (parsed as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is AdapterGroup =>
    !!entry && Number.isInteger(entry.pgid) && entry.pgid > 1 && typeof entry.command === "string" && entry.command !== ""
    && typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)
    && (entry.server === undefined || (!!entry.server && Number.isInteger(entry.server.pid) && Number.isFinite(entry.server.startedAt))));
}

/** Whether the process `server` names is still running: its pid is in the table with the recorded start time. */
export function serverAlive(server: ServerIdentity, table: ProcessTable): boolean {
  const row = table.rows.get(server.pid);
  return !!row && Math.abs(table.at - row.elapsedMs - server.startedAt) <= START_SLACK_MS;
}

/**
 * The members of `group` still running, when they can only be what a server that is gone left: the
 * server that started it is not running any more (another server sharing the Portal home may still
 * be), and either its leader is alive with the recorded command line and start time and has been
 * orphaned (re-parented to pid 1), or the leader is gone and every member started after the adapter
 * did, each orphaned unless its parent is in the group too. Null when the group is gone, still its
 * server's, or its pgid now belongs to something else (this server's own group never counts).
 */
export function leftoverGroup(group: AdapterGroup, table: ProcessTable): ProcessRow[] | null {
  if (group.server && serverAlive(group.server, table)) return null;
  const members = [...table.rows.values()].filter((row) => row.pgid === group.pgid);
  if (members.length === 0 || members.some((row) => row.pid === process.pid)) return null;
  const startOf = (row: ProcessRow) => table.at - row.elapsedMs;
  const leader = members.find((row) => row.pid === group.pgid);
  if (leader) {
    return leader.command === group.command && Math.abs(startOf(leader) - group.startedAt) <= START_SLACK_MS && leader.ppid === 1 ? members : null;
  }
  const inGroup = new Set(members.map((row) => row.pid));
  return members.every((row) => (inGroup.has(row.ppid) || row.ppid === 1) && startOf(row) >= group.startedAt - START_SLACK_MS) ? members : null;
}

export type LeftoverSweep = {
  killed: number[];
  /** Groups whose pgid now names something else; dropped from the file. */
  skipped: number[];
  /** Groups whose server still runs; they stay in the file. */
  kept: number[];
};

/**
 * Kill the groups the file lists that a server no longer running left (SIGTERM, SIGKILL after the
 * grace), and drop them from the file. A group a running server owns stays listed and untouched; one
 * whose pgid now names something else is left alone and dropped from the file. Resolves once the
 * killed groups are gone.
 */
export async function killLeftoverAdapters(
  file: AdapterGroupFile,
  { readProcesses = readProcessTable, graceMs, log = console.warn }: { readProcesses?: () => Promise<ProcessTable | null>; graceMs?: number; log?: (message: string) => void } = {},
): Promise<LeftoverSweep> {
  const listed = file.list();
  const result: LeftoverSweep = { killed: [], skipped: [], kept: [] };
  if (listed.length === 0) return result;
  const table = await readProcesses();
  // Without a process table nothing can be checked; the entries stay for the next boot.
  if (!table) return result;
  const targets: StopTarget[] = [];
  for (const group of listed) {
    if (group.server && serverAlive(group.server, table)) {
      result.kept.push(group.pgid);
      continue;
    }
    const members = leftoverGroup(group, table);
    if (members) {
      targets.push({ pgid: group.pgid });
      result.killed.push(group.pgid);
      log(`Stopping ${members.length} process(es) a previous Portal server left in adapter group ${group.pgid} (${group.command})`);
    } else if ([...table.rows.values()].some((row) => row.pgid === group.pgid)) {
      result.skipped.push(group.pgid);
    }
  }
  await terminate(targets, { graceMs }).done;
  for (const group of listed) if (!result.kept.includes(group.pgid)) file.remove(group.pgid);
  return result;
}
