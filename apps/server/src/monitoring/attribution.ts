/**
 * Attribution (docs/MONITORING.md): which owner each process is charged to, the first rule that
 * matches winning:
 *   1. Session: the session's CLI root (`findSessionRoot`) or a process below it.
 *   2. Portal: the server itself, the agent adapters and what runs below them outside the session
 *      trees, the web server (found by its listening port), and Postgres (its listener, plus the
 *      container's VM on macOS or the container's processes on Linux).
 *   3. Worktree: the working folder, or else a path in the command line, is inside a Portal
 *      worktree's folder (the deepest one wins). This is how a build server started with
 *      `--workspace_directory=<path>`, a dev server, or a test database is found, with no tool-specific code.
 *      A process that matches nothing on its own inherits the worktree of its nearest ancestor that
 *      matched on its own (`inheritedFrom`), so a build server's workers and a dev server's children
 *      count with it; only worktrees are inherited (session trees are rule 1 already).
 *   4. None.
 * Other processes below the server (terminals, scripts) are tried as worktrees first and are the
 * server's otherwise. Working folders are looked up only for processes above `CWD_FLOOR_BYTES`
 * that rules 1 and 2 leave, to keep `lsof` cheap; `cwdCandidates` names them. A process charged to
 * a session or a worktree whose parent is pid 1 is an orphan: nothing of Portal's will end it.
 *
 * Each row also says whether "Stop process" may stop it (`stopRefusal`), so the view and the stop
 * route apply the same rules. Pure: the service gathers the inputs.
 */
import path from "node:path";
import type { AttributedProcess, PortalRole, ProcessOwner } from "@portal/contracts/monitoring";
import { type ProcessTable, descendants, findSessionRoot } from "../lib/process-probe.ts";

/** Only processes using more than this get their working folder looked up. */
export const CWD_FLOOR_BYTES = 20 * 1024 * 1024;

export type AttributionInput = {
  table: ProcessTable;
  /** Footprint by pid where the OS measures it (macOS); RSS from the table otherwise. */
  memory: Map<number, number> | null;
  /** Sessions whose agent is attached: the adapter's pid and the marker that names the session's CLI. */
  sessions: { sessionId: string; agentPid: number; marker: string }[];
  /** Every running agent adapter. */
  adapterPids: number[];
  serverPid: number;
  /** Processes listening on the web server's port. */
  webPids: number[];
  /** Postgres's host processes: the listener and the container's processes (or VM). */
  databasePids: number[];
  worktrees: { projectId: string; path: string }[];
  /** Working folders of the candidates `cwdCandidates` named; absent ones are unknown. */
  cwds?: Map<number, string>;
};

/** A process's memory: the OS's measure when it has one, else RSS. */
export function memoryOf(input: Pick<AttributionInput, "table" | "memory">, pid: number): number {
  return input.memory?.get(pid) ?? input.table.rows.get(pid)?.rssBytes ?? 0;
}

const WEB_ANCESTOR = /\bnext\b/;

/** Rules 1 and 2, and the server's other descendants (which try rule 3 before falling back to the server). */
function claim(input: AttributionInput): { owners: Map<number, ProcessOwner>; serverTree: Set<number> } {
  const { table } = input;
  const owners = new Map<number, ProcessOwner>();
  const take = (pid: number, owner: ProcessOwner) => {
    if (table.rows.has(pid) && !owners.has(pid)) owners.set(pid, owner);
  };
  const takeTree = (pid: number, owner: ProcessOwner) => {
    take(pid, owner);
    for (const row of descendants(table, pid)) take(row.pid, owner);
  };

  for (const session of input.sessions) {
    const root = findSessionRoot(table, session.agentPid, session.marker);
    if (root !== null) takeTree(root, { kind: "session", sessionId: session.sessionId });
  }
  take(input.serverPid, { kind: "portal", role: "server" });
  for (const pid of input.adapterPids) takeTree(pid, { kind: "portal", role: "adapter" });
  for (const pid of input.webPids) {
    takeTree(pid, { kind: "portal", role: "web" });
    // The listener is often a worker of the `next` process that started it.
    let parent = table.rows.get(table.rows.get(pid)?.ppid ?? 0);
    while (parent && parent.pid > 1 && parent.pid !== input.serverPid && WEB_ANCESTOR.test(parent.command)) {
      take(parent.pid, { kind: "portal", role: "web" });
      parent = table.rows.get(parent.ppid);
    }
  }
  for (const pid of input.databasePids) takeTree(pid, { kind: "portal", role: "database" });

  const serverTree = new Set(descendants(table, input.serverPid).map((row) => row.pid).filter((pid) => !owners.has(pid)));
  return { owners, serverTree };
}

/** Processes whose working folder decides their owner: unclaimed by rules 1 and 2, and above the floor. */
export function cwdCandidates(input: AttributionInput): number[] {
  const { owners } = claim(input);
  return [...input.table.rows.keys()].filter((pid) => !owners.has(pid) && memoryOf(input, pid) > CWD_FLOOR_BYTES);
}

const within = (folder: string, root: string) => folder === root || folder.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Characters that may stand right before and right after a path in a command line. */
const BEFORE = /[\s='":,]/;
const AFTER = /[/\s'":,;]/;

/** Whether `command` names `root` or a path inside it as a whole path (not `/a/bc` for `/a/b`). */
export function commandNames(command: string, root: string): boolean {
  const trimmed = root.replace(/\/+$/, "");
  if (!trimmed) return false;
  for (let at = command.indexOf(trimmed); at >= 0; at = command.indexOf(trimmed, at + 1)) {
    const before = at === 0 ? "" : command[at - 1];
    const after = command[at + trimmed.length] ?? "";
    if ((before === "" || BEFORE.test(before)) && (after === "" || AFTER.test(after))) return true;
  }
  return false;
}

/** The deepest worktree `match` accepts, or null. */
function deepest(worktrees: AttributionInput["worktrees"], match: (root: string) => boolean): string | null {
  let best: { projectId: string; path: string } | null = null;
  for (const worktree of worktrees) {
    if (match(worktree.path) && (!best || worktree.path.length > best.path.length)) best = worktree;
  }
  return best?.projectId ?? null;
}

/** The server and every process above it, up to (not including) pid 1. */
function serverAncestry(table: ProcessTable, serverPid: number): Set<number> {
  const chain = new Set<number>();
  for (let pid = serverPid; pid > 1 && !chain.has(pid);) {
    chain.add(pid);
    const row = table.rows.get(pid);
    if (!row) break;
    pid = row.ppid;
  }
  return chain;
}

/**
 * Why "Stop process" must not stop `row`, in a few words, or null when it may. Refused: anything
 * attributed to nothing; an inherited owner (stop the process it came from); Portal's server, web
 * server and database (an adapter may be stopped: the next session starts another); the server and
 * every process above it; and a process whose group holds the server or one of those (a group
 * leader is stopped with its group, and the rest of such a group is too close to the server to
 * touch). `ancestry` is `serverAncestry` of the table.
 */
export function stopRefusal(
  row: { pid: number; pgid: number; owner: ProcessOwner; inheritedFrom: number | null },
  table: ProcessTable,
  ancestry: Set<number>,
): string | null {
  if (row.owner.kind === "none") return "not attributed to a session, a worktree, or Portal";
  if (row.inheritedFrom !== null) return `inherited from pid ${row.inheritedFrom}; stop that process`;
  if (row.pid <= 1) return "a system process";
  if (row.owner.kind === "portal" && row.owner.role !== "adapter") return PORTAL_REFUSAL[row.owner.role];
  if (ancestry.has(row.pid)) return "the Portal server runs under it";
  for (const pid of ancestry) {
    if (table.rows.get(pid)?.pgid === row.pgid) return "its process group holds the Portal server";
  }
  return null;
}

const PORTAL_REFUSAL: Record<Exclude<PortalRole, "adapter">, string> = {
  server: "part of the Portal server",
  web: "Portal's web server",
  database: "Portal's database",
};

/**
 * Every process in the table with its owner (and where it was inherited from), its memory, whether
 * it is an orphan, and whether it may be stopped.
 */
export function attribute(input: AttributionInput): AttributedProcess[] {
  const { table, cwds = new Map<number, string>() } = input;
  const { owners, serverTree } = claim(input);
  // Rule 3 on each process's own folder and command line.
  const own = new Map(owners);
  for (const row of table.rows.values()) {
    if (own.has(row.pid)) continue;
    const cwd = cwds.get(row.pid) ?? null;
    const projectId = (cwd !== null ? deepest(input.worktrees, (root) => within(cwd, root)) : null)
      ?? deepest(input.worktrees, (root) => commandNames(row.command, root));
    if (projectId) own.set(row.pid, { kind: "worktree", projectId });
  }
  /** The nearest ancestor with an owner of its own, when that owner is a worktree. */
  const inheritable = (pid: number): { owner: ProcessOwner; from: number } | null => {
    const seen = new Set<number>([pid]);
    for (let parent = table.rows.get(pid)?.ppid ?? 0; parent > 1 && !seen.has(parent); parent = table.rows.get(parent)?.ppid ?? 0) {
      seen.add(parent);
      const owner = own.get(parent);
      if (owner) return owner.kind === "worktree" ? { owner, from: parent } : null;
    }
    return null;
  };
  const ancestry = serverAncestry(table, input.serverPid);
  const result: AttributedProcess[] = [];
  for (const row of table.rows.values()) {
    const cwd = cwds.get(row.pid) ?? null;
    let owner = own.get(row.pid);
    let inheritedFrom: number | null = null;
    if (!owner) {
      const inherited = inheritable(row.pid);
      if (inherited) {
        owner = inherited.owner;
        inheritedFrom = inherited.from;
      } else if (serverTree.has(row.pid)) owner = { kind: "portal", role: "server" };
      else owner = { kind: "none" };
    }
    const stopBlockedReason = stopRefusal({ pid: row.pid, pgid: row.pgid, owner, inheritedFrom }, table, ancestry);
    result.push({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      elapsedSeconds: Math.round(row.elapsedMs / 1000),
      cpuSeconds: Math.round(row.cpuMs / 10) / 100,
      memoryBytes: memoryOf(input, row.pid),
      command: row.command,
      cwd,
      owner,
      inheritedFrom,
      orphan: row.ppid === 1 && (owner.kind === "session" || owner.kind === "worktree"),
      stoppable: stopBlockedReason === null,
      stopBlockedReason,
    });
  }
  return result;
}
