"use client";

import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ProjectRequestError, type RemoveProjectOptions } from "./useProjects";
import type { ProjectSummary } from "@/lib/types";

export function RenameField({
  initial,
  onCommit,
  onCancel,
  inputRef,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState(initial);
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = draft.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  return (
    <input
      ref={inputRef}
      aria-label="Project name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onFocus={(e) => e.target.select()}
      className="my-1 w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-xs outline-none"
    />
  );
}

export function RemoveConfirm({
  project,
  onRemove,
  onCancel,
}: {
  project: ProjectSummary;
  onRemove: (opts: RemoveProjectOptions) => Promise<void>;
  onCancel: () => void;
}) {
  const [deleteWorktree, setDeleteWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    message: string;
    dirty: boolean;
  } | null>(null);
  const isWorktree = !!project.worktree;
  const checkboxId = `sidebar-delete-worktree-${project.id}`;

  const submit = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onRemove(isWorktree ? { deleteWorktree, force } : {});
    } catch (e) {
      setError({
        message:
          e instanceof Error && e.message
            ? e.message
            : "Could not remove the project. Try again.",
        dirty: e instanceof ProjectRequestError && e.dirty,
      });
      setBusy(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Remove ${project.name}?`}
      className="my-1 rounded border border-red-900/60 bg-red-950/30 px-2 py-2 text-xs"
    >
      {isWorktree ? (
        <>
          <p className="mb-2 text-zinc-300">
            Remove <span className="font-medium">{project.name}</span> from
            Portal? Any conversations it still has move to Removed, where you
            can bring it back.
          </p>
          <label
            htmlFor={checkboxId}
            className="mb-1 flex items-center gap-1.5 text-zinc-300"
          >
            <input
              id={checkboxId}
              type="checkbox"
              checked={deleteWorktree}
              disabled={busy}
              onChange={(e) => setDeleteWorktree(e.target.checked)}
              className="accent-indigo-500"
            />
            Also delete the worktree folder
          </label>
          {deleteWorktree && (
            <p className="mb-2 text-zinc-500">
              The branch is deleted too if it is fully merged.
            </p>
          )}
        </>
      ) : (
        <p className="mb-2 text-zinc-300">
          Remove <span className="font-medium">{project.name}</span> from
          Portal? The folder is untouched. Any conversations it still has move
          to Removed, where you can bring it back.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-2 break-words rounded bg-red-950/50 px-2 py-1.5 text-red-300"
        >
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit(false)}
          className="rounded bg-red-700 px-2 py-1 font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          {busy ? "Removing…" : "Remove"}
        </button>
        {error?.dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit(true)}
            title="Discard the worktree's uncommitted changes"
            className="rounded border border-red-700 px-2 py-1 font-medium text-red-200 hover:bg-red-900/40 disabled:opacity-50"
          >
            Remove anyway
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
