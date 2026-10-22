import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * `instanceof`, so any error with a numeric `status` in the 4xx/5xx range maps to that status,
 * whichever module threw it.
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

/**
 * Turn a file path the browser sent into the absolute path it names (docs/FILES.md, "Paths"):
 * `file://` URLs are decoded, `~` and `~/…` expanded, and a relative path is resolved against
 * `cwd` (itself absolute or `~/…`), which it then requires. Symlinks are resolved: the target
 * itself when it exists, else its nearest existing ancestor, with the missing rest joined back on,
 * so a file about to be created has the same path it will have once it exists. Any path on the
 * host is allowed (no sandbox). Throws a 400 PathError for input it cannot read as a path.
 */
export async function resolveFilePath(input: string, cwd?: string | null, home?: string): Promise<string> {
  if (typeof input !== "string" || !input || input.includes("\0")) throw new PathError("Expected a path.", 400);
  let raw = input;
  if (/^file:/i.test(raw)) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      throw new PathError("Not a local file URL.", 400);
    }
    // `%00` decodes to a NUL, which no path may hold.
    if (raw.includes("\0")) throw new PathError("Expected a path.", 400);
  }
  let target = expandHome(raw, home);
  if (!path.isAbsolute(target)) {
    if (!cwd) throw new PathError("A relative path needs a working directory (cwd).", 400);
    const base = expandHome(cwd, home);
    if (!path.isAbsolute(base) || base.includes("\0")) throw new PathError("The working directory must be absolute (or start with ~/).", 400);
    target = path.resolve(base, target);
  }
  target = path.resolve(target);
  // Walk up to the nearest ancestor that exists (the root always does), then put the rest back.
  const rest: string[] = [];
  for (let at = target; ; at = path.dirname(at)) {
    try {
      return path.join(await realpath(at), ...rest.reverse());
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return target;
      rest.push(path.basename(at));
    }
  }
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
