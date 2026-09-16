"use client";

import type { GitInfo } from "@/lib/git-info";

export function basename(directory: string) {
  return directory.split("/").filter(Boolean).at(-1) ?? directory;
}

export function BranchBadge({ git }: { git: GitInfo }) {
  if (!git) return null;
  return (
    <span
      title={git.detached ? `Detached HEAD at ${git.branch} in ${git.root}` : `Branch ${git.branch} in ${git.root}`}
      className="inline-flex max-w-48 shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200"
    >
      <span aria-hidden="true" className="text-zinc-500">⎇</span>
      <span className="truncate">{git.branch}</span>
      {git.detached && <span className="text-zinc-500">detached</span>}
    </span>
  );
}

/** Repository, branch, and directory the message box currently targets. */
export default function ContextBar({ cwd, displayCwd, git, note }: {
  cwd: string | undefined;
  displayCwd: string | undefined;
  git: GitInfo;
  note?: string;
}) {
  return (
    <div id="session-context" aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-[11px] text-zinc-500">
      {git && <span className="shrink-0 font-medium text-zinc-300">{basename(git.root)}</span>}
      <BranchBadge git={git} />
      <span title={cwd} className="min-w-0 truncate font-mono">{displayCwd ?? "No project selected"}</span>
      {note && <span className="shrink-0">· {note}</span>}
    </div>
  );
}

export { ContextBar };
