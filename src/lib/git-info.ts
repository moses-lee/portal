import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GitInfo = {
  /** Repository root (the working tree that contains the directory). */
  root: string;
  displayRoot: string;
  /** Branch name, or an abbreviated commit hash when HEAD is detached. */
  branch: string;
  detached: boolean;
} | null;

export function displayPath(directory: string) {
  const home = os.homedir();
  return directory === home ? "~" : directory.startsWith(home + path.sep)
    ? "~" + directory.slice(home.length) : directory;
}

export function sameGitInfo(a: GitInfo, b: GitInfo) {
  return a === b || (!!a && !!b && a.root === b.root && a.branch === b.branch && a.detached === b.detached);
}

/** Locate the .git directory for a working tree, following worktree `gitdir:` pointers. */
async function gitDirectory(root: string): Promise<string | null> {
  const dotGit = path.join(root, ".git");
  let entry;
  try { entry = await stat(dotGit); } catch { return null; }
  if (entry.isDirectory()) return dotGit;
  if (!entry.isFile()) return null;
  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8").catch(() => ""));
  return pointer ? path.resolve(root, pointer[1]) : null;
}

/** Read the checked-out branch by inspecting .git/HEAD directly; no git process is spawned. */
export async function readGitInfo(directory: string): Promise<GitInfo> {
  let root = path.resolve(directory);
  for (;;) {
    const gitDir = await gitDirectory(root);
    if (gitDir) {
      const head = await readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => null);
      if (head === null) return null;
      const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head);
      const branch = ref ? ref[1] : head.trim().slice(0, 7);
      if (!branch) return null;
      return { root, displayRoot: displayPath(root), branch, detached: !ref };
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
