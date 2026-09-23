import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { displayPath } from "./git-info.ts";
import type { DirEntry, DirListing } from "@portal/contracts/types";

/** A filesystem lookup failed in a way the browser should hear about, with its HTTP status. */
export class PathError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PathError";
    this.status = status;
  }
}

/**
 * HTTP status carried by a PathError-shaped error, else null. Duck-typed rather than
 * `instanceof`: the projects store lives on `globalThis` across dev HMR reloads, so the
 * error classes it throws may predate the ones a freshly reloaded route imports.
 */
export function errorStatus(err: unknown): number | null {
  const status = err instanceof Error ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 600 ? status : null;
}

/** Expand a leading `~` or `~/…` only; `~user` is left for the caller to reject as relative. */
export function expandHome(input: string, home = os.homedir()) {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

function fromFsError(err: unknown, target: string): Error {
  const code = (err as { code?: string })?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new PathError(`Directory not found: ${displayPath(target)}`, 404);
  if (code === "EACCES" || code === "EPERM") return new PathError(`Permission denied: ${displayPath(target)}`, 403);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Turn user input into the canonical directory it names. The realpath is what `lsof`
 * and `/proc` later report for a PTY's cwd, so storing it keeps comparisons exact.
 */
export async function resolveDirectory(input: string, home?: string): Promise<string> {
  const expanded = expandHome(input, home);
  if (!path.isAbsolute(expanded)) throw new PathError("Path must be absolute (or start with ~/).", 400);
  const resolved = path.resolve(expanded);
  let real: string;
  let info;
  try {
    real = await realpath(resolved);
    info = await stat(real);
  } catch (err) {
    throw fromFsError(err, resolved);
  }
  if (!info.isDirectory()) throw new PathError(`Not a directory: ${displayPath(resolved)}`, 400);
  return real;
}

/** The parent of `dir`, or null at the filesystem root. */
export function parentDirectory(dir: string): string | null {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name);

/** List the subdirectories of `dir` (symlinks to directories included, broken links skipped). */
export async function listDirectories(
  dir: string,
  { hidden = false, limit = 1000 }: { hidden?: boolean; limit?: number } = {},
): Promise<DirListing> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fromFsError(err, dir);
  }
  const candidates = dirents
    .filter((entry) => (hidden || !entry.name.startsWith(".")) && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort(byName);
  const entries = await Promise.all(candidates.map(async (entry): Promise<DirEntry | null> => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await stat(full).catch(() => null);
      if (!target?.isDirectory()) return null;
    }
    const isGitRepo = await stat(path.join(full, ".git")).then(() => true, () => false);
    return { name: entry.name, path: full, isGitRepo };
  }));
  return {
    path: dir,
    parent: parentDirectory(dir),
    entries: entries.filter((entry): entry is DirEntry => entry !== null).slice(0, limit),
  };
}
