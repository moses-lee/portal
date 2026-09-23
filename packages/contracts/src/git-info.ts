/** Repository facts Portal attaches to sessions and terminals; `null` when the directory is not inside a git repository. */
export type GitInfo = {
  /** Repository root (the working tree that contains the directory). */
  root: string;
  displayRoot: string;
  /** Branch name, or an abbreviated commit hash when HEAD is detached. */
  branch: string;
  detached: boolean;
} | null;
