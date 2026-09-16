"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import DirectoryBrowser from "./DirectoryBrowser";
import { basename } from "./ContextBar";

export type AddProjectDialogProps = {
  open: boolean;
  /** Called on Cancel, Escape, backdrop click, and after a successful add. */
  onClose: () => void;
  /** Resolve to close the dialog; reject with an Error whose message is shown in the dialog. */
  onAdd: (input: { path: string; name: string }) => Promise<void>;
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const inputClass = "w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs outline-none focus:border-indigo-500 disabled:opacity-50";

/** Modal for adding a project folder. Mounts fresh on every open, so its state does not leak between uses. */
export default function AddProjectDialog({ open, onClose, onAdd }: AddProjectDialogProps) {
  if (!open) return null;
  return <Dialog onClose={onClose} onAdd={onAdd} />;
}

function Dialog({ onClose, onAdd }: Omit<AddProjectDialogProps, "open">) {
  const [path, setPath] = useState("");
  /** Name typed by the user; null follows the folder's basename. */
  const [customName, setCustomName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const nameId = useId();
  const name = customName ?? (path ? basename(path) : "");
  const canAdd = !pending && !!path && !!name.trim();

  // Focus the dialog on open and hand focus back to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => opener?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!pending) onClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    // Trap Tab inside the dialog.
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (e.shiftKey && (activeElement === first || activeElement === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = async () => {
    if (!canAdd) return;
    setPending(true);
    setError(null);
    try {
      await onAdd({ path, name: name.trim() });
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not add the project. Try again.");
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={() => { if (!pending) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-zinc-100 shadow-xl outline-none"
      >
        <h2 id={titleId} className="text-sm font-semibold text-zinc-200">Add project</h2>
        <p className="text-xs text-zinc-500">Pick the folder new sessions should start in.</p>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <DirectoryBrowser value={path} onChange={setPath} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor={nameId} className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-zinc-500">
            name
            <input
              id={nameId}
              value={name}
              onChange={(e) => setCustomName(e.target.value)}
              disabled={pending}
              placeholder={path ? basename(path) : "Project name"}
              className={`${inputClass} normal-case tracking-normal`}
            />
          </label>
          {path && <p className="truncate font-mono text-[11px] text-zinc-400" title={path}>{path}</p>}
          {error && <p role="alert" className="rounded bg-red-950/50 px-2 py-2 text-xs text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={pending} className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40">
              Cancel
            </button>
            <button type="submit" disabled={!canAdd} className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40">
              {pending ? "Adding…" : "Add project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
