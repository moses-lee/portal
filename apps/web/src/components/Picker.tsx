"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type PickerProps<Row> = {
  /** The visible label above the trigger; also names the trigger and the list for assistive tech. */
  label: string;
  /** What the trigger shows: the current choice. */
  trigger: ReactNode;
  /** Open state, held by the parent so it can fetch when the popover opens. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The search text, held by the parent so it can look things up as the user types. */
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  placeholder: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  renderRow: (row: Row) => ReactNode;
  /** The heading to show above `row`, given the row before it; null for none. */
  heading?: (row: Row, previous: Row | undefined) => string | null;
  /**
   * The user picked `row`. The popover closes unless this answers `false` (a refusal the parent
   * reports through `status`); an async answer keeps it open until it settles.
   */
  onChoose: (row: Row) => boolean | void | Promise<boolean | void>;
  /** Messages above the list: loading, errors, "no matches". */
  status?: ReactNode;
  disabled?: boolean;
  /** Extra classes for the trigger. */
  triggerClassName?: string;
};

/**
 * A combobox for the start page: a trigger showing the choice, and below it a popover with a search
 * field and a listbox of rows under optional headings. Arrow keys move the highlight, Enter picks,
 * Escape closes; clicking outside closes. The parent owns the open state and the query (it fetches
 * on both) and the rows; this owns the highlight, focus, and the popover's frame.
 */
export default function Picker<Row>({
  label, trigger, open, onOpenChange, query, onQueryChange, searchLabel, placeholder,
  rows, rowKey, renderRow, heading, onChoose, status, disabled = false, triggerClassName = "",
}: PickerProps<Row>) {
  const [highlight, setHighlight] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const triggerId = `${baseId}-trigger`;
  const listboxId = `${baseId}-listbox`;
  const selected = rows.length ? Math.min(highlight, rows.length - 1) : 0;

  const close = useCallback((refocus: boolean) => {
    onOpenChange(false);
    onQueryChange("");
    setHighlight(0);
    if (refocus) triggerRef.current?.focus();
  }, [onOpenChange, onQueryChange]);

  const toggle = () => {
    if (open) close(false);
    else onOpenChange(true);
  };

  // The trigger sits inside the container, so clicking it while open falls through to `toggle`.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  const choose = async (row: Row) => {
    if (choosing) return;
    setChoosing(true);
    let keepOpen = false;
    try {
      keepOpen = (await onChoose(row)) === false;
    } finally {
      setChoosing(false);
    }
    if (!keepOpen) close(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : rows.length - 1;
      setHighlight((selected + step) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      const row = rows[selected];
      if (row) void choose(row);
    }
  };

  return (
    <div className="mt-2">
      <label id={labelId} htmlFor={triggerId} className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">{label}</label>
      <div ref={containerRef} className="relative">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          // Name the button by the label and its own text, so the current choice is announced too.
          aria-labelledby={`${labelId} ${triggerId}`}
          aria-controls={open ? listboxId : undefined}
          disabled={disabled}
          onClick={toggle}
          className={`flex w-full min-w-0 items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-sm outline-none focus:border-indigo-500 disabled:opacity-50 ${triggerClassName}`}
        >
          {trigger}
          <span aria-hidden="true" className="ml-auto shrink-0 text-zinc-500">▾</span>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl">
            <div className="px-2 pb-1">
              <input
                autoFocus
                role="combobox"
                aria-label={searchLabel}
                aria-autocomplete="list"
                aria-expanded={true}
                aria-controls={listboxId}
                aria-activedescendant={rows.length ? `${listboxId}-${selected}` : undefined}
                value={query}
                onChange={(e) => {
                  onQueryChange(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs outline-none focus:border-indigo-500"
              />
            </div>
            {status && <div role="status" className="space-y-0.5 px-3">{status}</div>}
            <ul id={listboxId} role="listbox" aria-labelledby={labelId} aria-busy={choosing || undefined} className="max-h-72 overflow-y-auto">
              {rows.map((row, i) => {
                const title = heading?.(row, rows[i - 1]) ?? null;
                return (
                  <li key={rowKey(row)} role="presentation">
                    {title && <div role="presentation" className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-zinc-500">{title}</div>}
                    <div
                      id={`${listboxId}-${i}`}
                      role="option"
                      aria-selected={i === selected}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => void choose(row)}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${i === selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"}`}
                    >
                      {renderRow(row)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
