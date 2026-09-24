"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Folder, FolderGit2, Trash2 } from "lucide-react";
import IconButton from "./IconButton";
import { Button } from "@/components/ui/button";
import { relativeAge } from "@/lib/relative-age";
import type { RemovedProjectSummary } from "@/lib/types";

export type RemovedProjectsProps = {
  rows: RemovedProjectSummary[];
  error: string | null;
  onBack: () => void;
  onRefresh: () => void | Promise<void>;
  /** Bring the project back; the caller leaves this view once it resolves. */
  onRestore: (id: string) => Promise<void>;
  /** Delete the row's conversations and forget the project. */
  onDiscard: (id: string) => Promise<void>;
};

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function RemovedRow({
  row,
  now,
  onRestore,
  onDiscard,
}: {
  row: RemovedProjectSummary;
  now: number;
  onRestore: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<"restore" | "discard" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "restore" | "discard") => {
    setBusy(action);
    setError(null);
    try {
      await (action === "restore" ? onRestore(row.id) : onDiscard(row.id));
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : action === "restore"
            ? "Could not restore the project. Try again."
            : "Could not delete the conversations. Try again.",
      );
      setBusy(null);
    }
  };
  const subtitle = row.worktree
    ? `${row.parentName ?? "removed project"} · ${row.worktree.branch}`
    : row.displayPath;
  const removed =
    row.removedAt === null
      ? null
      : `removed ${relativeAge(now - row.removedAt) === "now" ? "just now" : `${relativeAge(now - row.removedAt)} ago`}`;
  return (
    <li
      aria-label={row.name}
      className="rounded-xl border border-white/5 bg-white/[.02] px-2.5 py-2"
    >
      <div className="flex items-start gap-2">
        {row.worktree ? (
          <FolderGit2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Folder className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-zinc-300">
            {row.name}
          </span>
          <span
            className="block truncate text-[11px] text-muted-foreground"
            title={row.displayPath}
          >
            {subtitle}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {[plural(row.sessionCount, "conversation"), removed]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>
      {!row.restorable && row.reason && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300">
          {row.reason}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-1.5 break-words text-[11px] leading-relaxed text-destructive"
        >
          {error}
        </p>
      )}
      {confirming ? (
        <div
          role="group"
          aria-label={`Delete conversations of ${row.name}?`}
          className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 p-2 text-[11px]"
        >
          <p className="leading-relaxed">
            Delete {plural(row.sessionCount, "conversation")} and their
            terminals? Their transcripts are removed from Portal.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void run("discard")}
            >
              {busy === "discard" ? "Deleting…" : "Delete"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {row.restorable && (
            <Button
              size="xs"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void run("restore")}
            >
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
            className="text-muted-foreground"
          >
            <Trash2 />
            Delete conversations
          </Button>
        </div>
      )}
    </li>
  );
}

/** The sidebar's Removed view: projects taken out of the workspace whose conversations remain. */
export default function RemovedProjects({
  rows,
  error,
  onBack,
  onRefresh,
  onRestore,
  onDiscard,
}: RemovedProjectsProps) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, []);
  // Opening the view is the moment to make sure the list is current.
  useEffect(() => {
    void onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section
      aria-label="Removed projects"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="mb-3 flex items-center gap-1 px-1">
        <IconButton
          label="Back to projects"
          size="icon-xs"
          onClick={onBack}
          className="text-muted-foreground"
        >
          <ArrowLeft />
        </IconButton>
        <h2 className="text-[10px] font-semibold tracking-[.12em] text-muted-foreground/80 uppercase">
          Removed projects
        </h2>
      </div>
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-4">
        {rows.length === 0 && !error && (
          <li className="px-3 py-6 text-xs leading-relaxed text-muted-foreground">
            Nothing to bring back. Projects you remove while they still have
            conversations show up here.
          </li>
        )}
        {rows.map((row) => (
          <RemovedRow
            key={row.id}
            row={row}
            now={now || row.removedAt || 0}
            onRestore={onRestore}
            onDiscard={onDiscard}
          />
        ))}
      </ul>
    </section>
  );
}
