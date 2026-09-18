"use client";

import { Folder, GitBranch } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import CopyButton from "./CopyButton";
import type { GitInfo } from "@/lib/git-info";

export function basename(directory: string) {
  return directory.split("/").filter(Boolean).at(-1) ?? directory;
}

export function BranchBadge({ git }: { git: GitInfo }) {
  if (!git) return null;
  return (
    <span
      title={git.branch}
      className="inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{git.branch}</span>
      {git.detached && <span>detached</span>}
    </span>
  );
}

export default function ContextBar({
  cwd,
  displayCwd,
  git,
  note,
}: {
  cwd: string | undefined;
  displayCwd: string | undefined;
  git: GitInfo;
  label?: string;
  note?: string;
}) {
  if (!cwd) return null;
  return (
    <div className="composer-context">
      <span id="session-context" className="sr-only">
        Working directory: {displayCwd ?? cwd}.{" "}
        {git ? `Branch: ${git.branch}.` : ""} {note}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Working directory and branch"
            className="flex min-w-0 max-w-full items-center gap-2 rounded-md px-1 py-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {git && (
              <>
                <GitBranch className="size-3 shrink-0" />
                <span className="max-w-[45%] truncate font-mono">
                  {git.branch}
                </span>
                <span className="text-white/15">/</span>
              </>
            )}
            <Folder className="size-3 shrink-0" />
            <span className="min-w-0 truncate font-mono">
              {displayCwd ?? cwd}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-[min(380px,calc(100vw-32px))] space-y-4 rounded-2xl p-4"
        >
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Working directory
            </p>
            <p className="break-all font-mono text-xs leading-relaxed">{cwd}</p>
            <CopyButton text={cwd} label="Copy path" className="mt-2" />
          </div>
          {git && (
            <div className="border-t pt-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {git.detached ? "Detached HEAD" : "Branch"}
              </p>
              <p className="break-all font-mono text-xs">{git.branch}</p>
              <CopyButton
                text={git.branch}
                label="Copy branch"
                className="mt-2"
              />
            </div>
          )}
          {note && <p className="text-xs text-amber-200">{note}</p>}
        </PopoverContent>
      </Popover>
      {note && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-amber-300"
          aria-label={note}
          title={note}
        />
      )}
    </div>
  );
}
