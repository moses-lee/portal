"use client";

import { useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ProjectRequestError, type RemoveProjectOptions } from "./useProjects";
import { useSettings } from "./useSettings";
import { isScriptEnabled } from "@/lib/scripts";
import type { ProjectSummary } from "@/lib/types";

/**
 * An inline name editor: Enter or leaving the field commits a changed, non-blank name (trimmed);
 * Escape, or an unchanged or blank name, cancels. With `maxLength`, a longer name keeps the field
 * open with an inline error instead of committing.
 */
export function RenameField({
  initial,
  onCommit,
  onCancel,
  inputRef,
  ariaLabel = "Project name",
  maxLength,
  className = "my-1 w-full rounded border border-indigo-500 bg-zinc-900 px-2 py-1 text-xs outline-none",
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The input's accessible name: what is being renamed. */
  ariaLabel?: string;
  maxLength?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [tooLong, setTooLong] = useState(false);
  const errorId = useId();
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    const name = draft.trim();
    // Over the limit (an agent's long title, say): stay open with the draft and say why, rather
    // than close and have the server reject it.
    if (commit && maxLength !== undefined && name.length > maxLength && name !== initial.trim()) {
      setTooLong(true);
      return;
    }
    doneRef.current = true;
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
  // No native maxLength: it would block typing into a title already over the limit, so the length
  // is checked on commit instead.
  return (
    <>
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        aria-invalid={tooLong || undefined}
        aria-describedby={tooLong ? errorId : undefined}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (tooLong && maxLength !== undefined && e.target.value.trim().length <= maxLength) setTooLong(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        onFocus={(e) => e.target.select()}
        className={className}
      />
      {tooLong && maxLength !== undefined && (
        <p id={errorId} role="alert" className="mt-1 text-[11px] text-destructive">
          Keep it to {maxLength} characters ({draft.trim().length} now), or press Escape to cancel.
        </p>
      )}
    </>
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
  // Deleting the folder runs the user's pre-deletion script first, when one is set; say so and show it running.
  const { settings } = useSettings();
  const runsScript =
    isWorktree &&
    deleteWorktree &&
    !!settings &&
    isScriptEnabled(settings.scripts.preWorktreeDelete);

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
              {runsScript && "Your pre-deletion script runs first. "}
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
          className="mb-2 break-words whitespace-pre-wrap rounded bg-red-950/50 px-2 py-1.5 text-red-300"
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
          {busy ? (runsScript ? "Running script…" : "Removing…") : "Remove"}
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
