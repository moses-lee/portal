/**
 * Folder search for the start page's project picker (`GET /api/fs/search?q=`). A query that looks
 * like a path is completed: the children of the folder it names, filtered by its last segment. Any
 * other query is matched by name against the git repositories under the home folder, found by a
 * depth-capped walk that is cached between queries.
 */
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathError, expandHome, listDirectories, resolveDirectory } from "./fs-paths.ts";
import { displayPath } from "./git-info.ts";
import type { FolderHit, FolderSearch } from "@portal/contracts/types";

/** A query read as a path rather than a name: absolute, or the home folder and below. */
export function isPathQuery(query: string): boolean {
  return query.startsWith("/") || query === "~" || query.startsWith("~/");
}

const byPathLength = (a: FolderHit, b: FolderHit) => a.path.length - b.path.length || a.name.localeCompare(b.name);

/**
 * The folders completing a typed path: with a trailing slash (or for "~" alone), the folder itself
 * first and then its children; otherwise the children of its parent whose names start with the last segment
 * (case-insensitively; a segment starting with "." reveals hidden folders). A path that names
 * nothing, or that cannot be read, completes to nothing rather than failing.
 */
export async function completePath(query: string, { home = os.homedir(), limit = 20 }: { home?: string; limit?: number } = {}): Promise<FolderHit[]> {
  // "~" alone names the home folder: offer it and what is in it, not its siblings. The split is
  // made on the text as typed, since expansion normalises away a trailing "." or "/".
  const raw = query === "~" ? "~/" : query;
  const slash = raw.lastIndexOf("/");
  const dir = expandHome(raw.slice(0, slash + 1), home);
  const prefix = raw.slice(slash + 1).toLowerCase();
  if (!path.isAbsolute(dir)) return [];
  let real: string;
  let listing;
  try {
    real = await resolveDirectory(dir, home);
    listing = await listDirectories(real, { hidden: prefix.startsWith(".") });
  } catch (err) {
    if (err instanceof PathError) return [];
    throw err;
  }
  const hits: FolderHit[] = [];
  if (prefix === "") {
    const isGitRepo = await stat(path.join(real, ".git")).then(() => true, () => false);
    hits.push({ name: path.basename(real) || real, path: real, displayPath: displayPath(real), isGitRepo });
  }
  for (const entry of listing.entries) {
    if (!entry.name.toLowerCase().startsWith(prefix)) continue;
    hits.push({ name: entry.name, path: entry.path, displayPath: displayPath(entry.path), isGitRepo: entry.isGitRepo });
  }
  return hits.slice(0, limit);
}

/** Folders the repository walk never enters: dependency and cache trees, and macOS's own. */
export const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set([
  "node_modules", "Library", "Applications", "Music", "Movies", "Pictures", "Public",
  "vendor", "target", "dist", "build", "out", "tmp", "temp", "cache", "__pycache__", "venv",
]);

export type RepoIndexOptions = {
  /** The folder the walk starts from; the home folder by default. */
  root?: string;
  /** How many folders deep below the root a repository may sit (1 lists the root's own children). */
  depth?: number;
  exclude?: ReadonlySet<string>;
  /** How long a walk's answer serves queries before the next query triggers another walk. */
  ttlMs?: number;
  /** The walk stops listing once this many folders have been read. */
  maxDirs?: number;
  now?: () => number;
};

export type RepoIndex = {
  /** Repositories whose names (or paths, word by word) match `query`, best first; empty for a blank query. */
  search(query: string, limit?: number): Promise<FolderHit[]>;
  /** Walk again now, or join the walk in progress; answers every repository found. */
  refresh(): Promise<FolderHit[]>;
  /** Start a walk if none is fresh, without waiting for it. */
  warm(): void;
};

/**
 * Walk `root` for git repositories (a folder holding `.git`, a directory or a worktree's file).
 * Hidden folders and the excluded names are skipped, and the walk does not descend into a
 * repository. Breadth first, so a cap on folders read keeps the shallow, likelier ones.
 */
export async function walkRepos({ root, depth, exclude, maxDirs }: Required<Pick<RepoIndexOptions, "root" | "depth" | "exclude" | "maxDirs">>): Promise<FolderHit[]> {
  const hits: FolderHit[] = [];
  let level = [root];
  let read = 0;
  for (let d = 0; d < depth && level.length > 0 && read < maxDirs; d++) {
    const next: string[] = [];
    const batch = level.slice(0, maxDirs - read);
    read += batch.length;
    const listings = await Promise.all(batch.map((dir) => readdir(dir, { withFileTypes: true }).catch(() => [])));
    for (const [i, dirents] of listings.entries()) {
      const dir = batch[i];
      for (const entry of dirents) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || exclude.has(entry.name)) continue;
        next.push(path.join(dir, entry.name));
      }
    }
    const repos = await Promise.all(next.map((dir) => stat(path.join(dir, ".git")).then(() => true, () => false)));
    level = [];
    for (const [i, dir] of next.entries()) {
      if (repos[i]) hits.push({ name: path.basename(dir), path: dir, displayPath: displayPath(dir), isGitRepo: true });
      else level.push(dir);
    }
  }
  return hits.sort(byPathLength);
}

/**
 * Rank `hits` for `query`: a name equal to the query, then names starting with it, then names
 * containing it, then paths containing every word of it; ties go to the shorter path.
 */
export function rankHits(hits: readonly FolderHit[], query: string, limit = 20): FolderHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored: { hit: FolderHit; score: number }[] = [];
  for (const hit of hits) {
    const name = hit.name.toLowerCase();
    const full = hit.path.toLowerCase();
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (words.every((word) => full.includes(word))) score = 3;
    else continue;
    scored.push({ hit, score });
  }
  return scored.sort((a, b) => a.score - b.score || byPathLength(a.hit, b.hit)).slice(0, limit).map((s) => s.hit);
}

export function createRepoIndex({
  root = os.homedir(), depth = 4, exclude = DEFAULT_EXCLUDES, ttlMs = 60_000, maxDirs = 20_000, now = Date.now,
}: RepoIndexOptions = {}): RepoIndex {
  let cached: { at: number; hits: FolderHit[] } | null = null;
  let walking: Promise<FolderHit[]> | null = null;
  const refresh = () => {
    if (walking) return walking;
    walking = walkRepos({ root, depth, exclude, maxDirs })
      .then((hits) => {
        cached = { at: now(), hits };
        return hits;
      })
      .finally(() => {
        walking = null;
      });
    return walking;
  };
  const fresh = () => cached !== null && now() - cached.at < ttlMs;
  return {
    refresh,
    warm() {
      if (!fresh()) refresh().catch(() => {});
    },
    async search(query, limit = 20) {
      if (!query.trim()) return [];
      // A stale index answers now and is rebuilt behind the answer; the first query waits for the walk.
      const hits = cached ? (fresh() ? cached.hits : (refresh().catch(() => {}), cached.hits)) : await refresh();
      return rankHits(hits, query, limit);
    },
  };
}

/** Answer `GET /api/fs/search?q=`: path completion for a path, else the repository index. */
export async function searchFolders(query: string, index: RepoIndex, { home, limit = 20 }: { home?: string; limit?: number } = {}): Promise<FolderSearch> {
  const q = query.trim();
  if (isPathQuery(q)) return { mode: "path", hits: await completePath(q, { home, limit }) };
  if (!q) {
    index.warm();
    return { mode: "name", hits: [] };
  }
  return { mode: "name", hits: await index.search(q, limit) };
}
