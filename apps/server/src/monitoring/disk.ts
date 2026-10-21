/**
 * The disk survey (docs/MONITORING.md): folder sizes for Portal's home (worktrees, blobs, logs and
 * the rest), each worktree project, each watched folder with its largest immediate children, and
 * the database. `du -sk -x` runs under `nice`, one folder at a time; the result is cached in memory
 * with its time, and a survey is never started while one runs (`start` answers the running one).
 * Every folder is measured once: the home's parts and a watched folder's total are sums of their
 * pieces, not a second `du` over the whole.
 */
import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { DiskEntry, DiskLargest, DiskSurvey, WatchedFolder, WatchedFolderChild } from "@portal/contracts/monitoring";

/** How long one `du` may run before it counts as failed. */
const DU_TIMEOUT_MS = 30 * 60_000;
/** A watched folder lists this many of its largest children. */
const WATCHED_CHILDREN = 10;
/** The survey's largest items, for the jar's card. */
const LARGEST = 5;

export type DiskSurveyDeps = {
  now(): number;
  portalHome: string;
  /** Portal's worktree projects as they are now. */
  worktrees(): { projectId: string; name: string; path: string }[];
  /** The watched folders from settings, absolute. */
  watchedFolders(): Promise<string[]>;
  /** The database's size and its five largest tables; null when it cannot be asked. */
  database(): Promise<DiskSurvey["database"]>;
  /** One folder's size in bytes, or null when it could not be measured. */
  du(folder: string, signal: AbortSignal): Promise<number | null>;
};

export interface DiskSurveyor {
  /** The last finished survey, or null before the first. */
  current(): DiskSurvey | null;
  running(): boolean;
  /** Starts a survey, or answers the running one; resolves with the result (the previous one when it was stopped). */
  start(): Promise<DiskSurvey | null>;
  /** Stops a running survey (its `du` is killed) and waits for it. */
  dispose(): Promise<void>;
}

/** `du -sk -x <folder>` under `nice`: kilobytes on the last line, even when `du` exits non-zero over a folder it could not read in part. */
export function liveDu(folder: string, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("nice", ["-n", "10", "du", "-sk", "-x", folder], { timeout: DU_TIMEOUT_MS, signal, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (_error, stdout) => {
      resolve(parseDu(typeof stdout === "string" ? stdout : ""));
    });
  });
}

/** Bytes from `du -sk` output (`<kilobytes>\t<path>`); null when there is no such line. */
export function parseDu(stdout: string): number | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const match = /^(\d+)\s/.exec(line);
  return match ? Number(match[1]) * 1024 : null;
}

const within = (folder: string, root: string) => folder === root || folder.startsWith(root + path.sep);

/** Entries of a folder, or none when it cannot be read. */
async function entries(folder: string): Promise<Dirent[]> {
  return readdir(folder, { withFileTypes: true }).catch(() => []);
}

/** The space a file takes on disk (not its length), as `du` would count it. */
const allocated = (stats: Stats) => (stats.blocks ? stats.blocks * 512 : stats.size);

export function createDiskSurveyor(deps: DiskSurveyDeps): DiskSurveyor {
  let last: DiskSurvey | null = null;
  let runningSurvey: Promise<DiskSurvey | null> | null = null;
  let controller: AbortController | null = null;

  /** A folder's size by `du`, a file's or link's by `lstat`; null when neither works. */
  async function sizeOf(target: string, signal: AbortSignal): Promise<{ bytes: number | null; modifiedAt: number | null; folder: boolean } | null> {
    const stats = await lstat(target).catch(() => null);
    if (!stats) return null;
    if (!stats.isDirectory()) return { bytes: allocated(stats), modifiedAt: stats.mtimeMs, folder: false };
    return { bytes: await deps.du(target, signal), modifiedAt: stats.mtimeMs, folder: true };
  }

  async function survey(signal: AbortSignal): Promise<DiskSurvey> {
    const startedAt = deps.now();
    const home = deps.portalHome;
    const worktreesDir = path.join(home, "worktrees");
    const measured = new Map<string, number | null>();
    const measure = async (folder: string) => {
      if (!measured.has(folder)) measured.set(folder, (await sizeOf(folder, signal))?.bytes ?? null);
      return measured.get(folder) ?? null;
    };

    // Portal's worktree folders sit at <home>/worktrees/<repo>/<name>; each is measured once.
    let worktreesBytes = 0;
    const worktreeFolders: string[] = [];
    for (const repo of await entries(worktreesDir)) {
      const repoPath = path.join(worktreesDir, repo.name);
      if (!repo.isDirectory()) {
        worktreesBytes += (await sizeOf(repoPath, signal))?.bytes ?? 0;
        continue;
      }
      for (const entry of await entries(repoPath)) {
        if (signal.aborted) throw signal.reason;
        const folder = path.join(repoPath, entry.name);
        const bytes = await measure(folder);
        worktreesBytes += bytes ?? 0;
        if (entry.isDirectory()) worktreeFolders.push(folder);
      }
    }

    // A project at a worktree folder takes its size; one inside it (a subfolder project) or elsewhere is measured itself.
    const projects = deps.worktrees();
    const worktrees: DiskSurvey["worktrees"] = [];
    for (const project of projects) {
      if (signal.aborted) throw signal.reason;
      worktrees.push({ projectId: project.projectId, path: project.path, bytes: await measure(project.path) });
    }
    const strayWorktrees: DiskEntry[] = worktreeFolders
      .filter((folder) => !projects.some((project) => within(project.path, folder)))
      .map((folder) => ({ path: folder, bytes: measured.get(folder) ?? null }));

    // The home's own parts: blobs, logs, and everything else but the worktrees.
    // A part that does not exist yet takes no space; null is kept for a `du` that failed.
    const part = async (name: string) => {
      const size = await sizeOf(path.join(home, name), signal);
      return size ? size.bytes : 0;
    };
    const blobsBytes = await part("blobs");
    const logsBytes = await part("logs");
    let otherBytes = 0;
    for (const entry of await entries(home)) {
      if (["worktrees", "blobs", "logs"].includes(entry.name)) continue;
      if (signal.aborted) throw signal.reason;
      otherBytes += (await sizeOf(path.join(home, entry.name), signal))?.bytes ?? 0;
    }

    const watched: WatchedFolder[] = [];
    for (const folder of await deps.watchedFolders()) {
      if (signal.aborted) throw signal.reason;
      watched.push(await surveyWatched(folder, signal));
    }

    const database = await deps.database().catch(() => null);
    const byId = new Map(projects.map((project) => [project.projectId, project.name]));
    // A subfolder project is part of its worktree folder's size, so only the outermost one competes.
    const outer = worktrees.filter((entry) => !worktrees.some((other) => other.path !== entry.path && within(entry.path, other.path)));
    const candidates: (DiskLargest | null)[] = [
      ...outer.map((entry) => entry.bytes === null ? null : { label: byId.get(entry.projectId) ?? path.basename(entry.path), path: entry.path, bytes: entry.bytes }),
      ...strayWorktrees.map((entry) => entry.bytes === null ? null : { label: `${path.basename(entry.path)} (no project)`, path: entry.path, bytes: entry.bytes }),
      blobsBytes === null ? null : { label: "Portal images", path: path.join(home, "blobs"), bytes: blobsBytes },
      logsBytes === null ? null : { label: "Portal logs", path: path.join(home, "logs"), bytes: logsBytes },
      { label: "Portal home, other", path: home, bytes: otherBytes },
      database ? { label: "Database", path: null, bytes: database.bytes } : null,
      ...watched.map((entry) => entry.bytes === null ? null : { label: entry.path, path: entry.path, bytes: entry.bytes }),
    ];
    const largest = candidates
      .filter((entry): entry is DiskLargest => !!entry && entry.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, LARGEST);

    return {
      startedAt,
      finishedAt: deps.now(),
      home: { path: home, worktreesBytes, blobsBytes, logsBytes, otherBytes },
      worktrees,
      strayWorktrees,
      watched,
      database,
      largest,
    };
  }

  /** A watched folder: each immediate child measured once, the folder's size their sum. */
  async function surveyWatched(folder: string, signal: AbortSignal): Promise<WatchedFolder> {
    const stats = await lstat(folder).catch(() => null);
    if (!stats) return { path: folder, exists: false, bytes: null, children: [] };
    if (!stats.isDirectory()) return { path: folder, exists: true, bytes: allocated(stats), children: [] };
    const children: WatchedFolderChild[] = [];
    let bytes = 0;
    for (const entry of await entries(folder)) {
      if (signal.aborted) throw signal.reason;
      const size = await sizeOf(path.join(folder, entry.name), signal);
      if (!size) continue;
      bytes += size.bytes ?? 0;
      children.push({ name: entry.name, bytes: size.bytes, modifiedAt: size.modifiedAt });
    }
    children.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    return { path: folder, exists: true, bytes, children: children.slice(0, WATCHED_CHILDREN) };
  }

  return {
    current: () => last,
    running: () => runningSurvey !== null,
    start() {
      if (runningSurvey) return runningSurvey;
      controller = new AbortController();
      const { signal } = controller;
      runningSurvey = survey(signal)
        .then((result) => (last = result), () => last)
        .finally(() => {
          runningSurvey = null;
          controller = null;
        });
      return runningSurvey;
    },
    async dispose() {
      controller?.abort(new Error("The disk survey was stopped."));
      await runningSurvey;
    },
  };
}
