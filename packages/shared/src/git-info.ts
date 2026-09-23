/**
 * The pure half of git info: the wire type and the comparison both sides use. Reading `.git/HEAD`
 * and shortening paths against the home directory need Node, so they stay in the server
 * (`apps/server/src/lib/git-info.ts`).
 */
import type { GitInfo } from "@portal/contracts/git-info";
export type { GitInfo };

export function sameGitInfo(a: GitInfo, b: GitInfo) {
  return a === b || (!!a && !!b && a.root === b.root && a.branch === b.branch && a.detached === b.detached);
}
