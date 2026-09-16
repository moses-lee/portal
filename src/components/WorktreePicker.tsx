"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BranchBadge } from "./ContextBar";
import {
  ORIGINAL,
  isProbablyRefName,
  isPullNumberQuery,
  rankPickerRows,
  type PickerRow,
  type WorktreeChoice,
} from "@/lib/branch-matching";
import type { BranchListing, ProjectSummary, PullInfo } from "@/lib/types";

export type { WorktreeChoice } from "@/lib/branch-matching";

export type WorktreePickerProps = {
  /** A git project that is not itself a worktree. */
  project: ProjectSummary;
  value: WorktreeChoice;
  onChange: (choice: WorktreeChoice) => void;
  disabled?: boolean;
};

/** Answer of `GET /branches`; `key` ties it to the fetch that produced it. */
type ListingResult = { key: string; projectId: string; listing: BranchListing | null; error: string | null };

/** Answer of `GET /pulls/<n>`: `pull` null when gh said not found (or failed, with `error`). */
type LookupResult = { projectId: string; number: number; pull: PullInfo | null; error: string | null };

const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";

const tagClass = "shrink-0 rounded bg-zinc-800 px-1 py-px text-[10px] text-zinc-400";

function errorMessage(e: unknown, fallback: string) {
  return e instanceof Error && e.message && e.message !== "Failed to fetch" ? e.message : fallback;
}

function rowKey(row: PickerRow) {
  switch (row.kind) {
    case "original": return "original";
    case "pull": return `pull:${row.pull.number}`;
    case "branch": return `branch:${row.branch.name}`;
    case "create": return "create";
  }
}

function TriggerLabel({ project, value }: { project: ProjectSummary; value: WorktreeChoice }) {
  if (value.kind === "original") {
    return (
      <>
        <span className="text-zinc-200">Original</span>
        <BranchBadge git={project.git} />
      </>
    );
  }
  return (
    <>
      {value.kind === "branch" && value.pull && <span className="shrink-0 font-mono text-zinc-400">#{value.pull.number}</span>}
      <span className="min-w-0 truncate font-mono text-zinc-200">{value.branch}</span>
      {value.kind === "create" && <span className={tagClass}>new branch</span>}
    </>
  );
}

function RowLabel({ row, git, defaultBranch }: { row: PickerRow; git: ProjectSummary["git"]; defaultBranch: string | null }) {
  switch (row.kind) {
    case "original":
      return (
        <>
          <span>Original</span>
          <BranchBadge git={git} />
        </>
      );
    case "pull": {
      const { pull } = row;
      return (
        <>
          <span className="shrink-0 font-mono text-zinc-400">#{pull.number}</span>
          <span className="min-w-0 flex-1 truncate">{pull.title}</span>
          <span className="max-w-40 shrink-0 truncate font-mono text-zinc-500">{pull.branch}</span>
          {pull.state !== "open" && <span className={tagClass}>{pull.state}</span>}
          {pull.fork && <span className={tagClass}>fork</span>}
        </>
      );
    }
    case "branch": {
      const { branch } = row;
      return (
        <>
          <span className="min-w-0 flex-1 truncate font-mono">{branch.name}</span>
          {!branch.local && branch.remote && <span className={tagClass}>origin only</span>}
          {branch.worktreePath && <span title={branch.worktreePath} className={tagClass}>checked out</span>}
        </>
      );
    }
    case "create":
      return (
        <>
          <span className="shrink-0">Create branch</span>
          <span className="min-w-0 truncate font-mono text-zinc-100">{row.name}</span>
          {defaultBranch && <span className="shrink-0 text-zinc-500">from {defaultBranch}</span>}
        </>
      );
  }
}

/**
 * "Worktree" control for the start page: Original, an open PR, a recent branch, or a branch to
 * create. Only records a choice; starting the session does the git work.
 */
export default function WorktreePicker({ project, value, onChange, disabled = false }: WorktreePickerProps) {
  const [open, setOpen] = useState(false);
  /** Bumped on every open so the listing is refetched; the previous answer stays visible meanwhile. */
  const [generation, setGeneration] = useState(0);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [listingResult, setListingResult] = useState<ListingResult | null>(null);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const triggerId = `${baseId}-trigger`;
  const listboxId = `${baseId}-listbox`;

  const listingKey = `${project.id}\n${generation}`;
  const listing = listingResult?.projectId === project.id ? listingResult.listing : null;
  const listingError = listingResult?.key === listingKey ? listingResult.error : null;
  const loading = open && listingResult?.key !== listingKey;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = async () => {
      let result: ListingResult;
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(project.id)}/branches`, { signal: controller.signal });
        const j = (await r.json().catch(() => ({}))) as Partial<BranchListing> & { error?: string };
        if (!r.ok || !j.branches) throw new Error(j.error ?? "Could not list branches.");
        result = { key: listingKey, projectId: project.id, listing: j as BranchListing, error: null };
      } catch (e) {
        if (controller.signal.aborted) return;
        // Keep the previous listing for this project on screen so the picker stays usable.
        result = { key: listingKey, projectId: project.id, listing: null, error: errorMessage(e, NETWORK_ERROR) };
        setListingResult((prev) => ({ ...result, listing: prev?.projectId === project.id ? prev.listing : null }));
        return;
      }
      if (controller.signal.aborted) return;
      setListingResult(result);
    };
    void load();
    return () => controller.abort();
  }, [open, project.id, listingKey]);

  const trimmed = query.trim();
  const digits = isPullNumberQuery(trimmed);
  const number = digits ? Number(trimmed) : null;
  const lookupForQuery = number !== null && lookup?.projectId === project.id && lookup.number === number ? lookup : null;
  const lookupPending = open && number !== null && lookupForQuery === null;

  // Debounced PR-number lookup; the answer only counts while the same number is typed.
  useEffect(() => {
    if (!open || number === null || lookupForQuery !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let result: LookupResult;
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(project.id)}/pulls/${number}`, { signal: controller.signal });
        const j = (await r.json().catch(() => ({}))) as { pull?: PullInfo; error?: string };
        if (r.ok && j.pull) result = { projectId: project.id, number, pull: j.pull, error: null };
        else if (r.status === 404) result = { projectId: project.id, number, pull: null, error: null };
        else result = { projectId: project.id, number, pull: null, error: j.error ?? "Could not look up the pull request." };
      } catch (e) {
        if (controller.signal.aborted) return;
        result = { projectId: project.id, number, pull: null, error: errorMessage(e, NETWORK_ERROR) };
      }
      if (!controller.signal.aborted) setLookup(result);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, number, lookupForQuery, project.id]);

  const rows = useMemo(() => rankPickerRows(listing, trimmed, lookupForQuery?.pull ?? null, {
    canCreate: isProbablyRefName(trimmed),
    pullLookupPending: lookupPending,
  }), [listing, trimmed, lookupForQuery, lookupPending]);
  const selected = rows.length ? Math.min(highlight, rows.length - 1) : 0;

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    setSelectError(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    setGeneration((n) => n + 1);
    setOpen(true);
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

  const choose = (row: PickerRow) => {
    switch (row.kind) {
      case "original":
        onChange(ORIGINAL);
        break;
      case "pull":
        if (row.pull.fork) {
          setSelectError("Fork PRs are not supported.");
          return;
        }
        onChange({
          kind: "branch",
          branch: row.pull.branch,
          pull: row.pull,
          path: listing?.branches.find((b) => b.name === row.pull.branch)?.worktreePath ?? undefined,
          worktreesDir: listing?.worktreesDir,
        });
        break;
      case "branch":
        onChange({ kind: "branch", branch: row.branch.name, path: row.branch.worktreePath ?? undefined, worktreesDir: listing?.worktreesDir });
        break;
      case "create":
        onChange({ kind: "create", branch: row.name, worktreesDir: listing?.worktreesDir });
        break;
    }
    close(true);
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
      if (row) choose(row);
    }
  };

  const defaultBranch = listing?.defaultBranch ?? null;
  const showHeadings = trimmed === "";

  return (
    <div className="mt-2">
      <label id={labelId} htmlFor={triggerId} className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">worktree</label>
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
          className="flex w-full min-w-0 items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-sm outline-none focus:border-indigo-500 disabled:opacity-50"
        >
          <TriggerLabel project={project} value={value} />
          <span aria-hidden="true" className="ml-auto shrink-0 text-zinc-500">▾</span>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl">
            <div className="px-2 pb-1">
              <input
                autoFocus
                role="combobox"
                aria-label="Search branches and pull requests"
                aria-autocomplete="list"
                aria-expanded={true}
                aria-controls={listboxId}
                aria-activedescendant={rows.length ? `${listboxId}-${selected}` : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                  setSelectError(null);
                }}
                onKeyDown={onKeyDown}
                placeholder="Branch, PR number, or title…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs outline-none focus:border-indigo-500"
              />
            </div>
            <div role="status" className="space-y-0.5 px-3">
              {loading && <p className="py-1 text-zinc-500">Loading branches…</p>}
              {listingError && <p className="py-1 text-red-300">{listingError}</p>}
              {listing?.pullsError && <p className="py-1 text-zinc-500">Open PRs unavailable: {listing.pullsError}</p>}
              {lookupPending && <p className="py-1 text-zinc-500">Looking up PR #{number}…</p>}
              {lookupForQuery?.error && <p className="py-1 text-zinc-500">{lookupForQuery.error}</p>}
              {selectError && <p role="alert" className="py-1 text-red-300">{selectError}</p>}
              {!loading && listing && rows.length === 0 && !lookupPending && <p className="py-1 text-zinc-500">No matches.</p>}
            </div>
            <ul id={listboxId} role="listbox" aria-labelledby={labelId} className="max-h-72 overflow-y-auto">
              {rows.map((row, i) => {
                const previous = rows[i - 1];
                const heading = showHeadings && row.kind !== "original" && previous?.kind !== row.kind
                  ? (row.kind === "pull" ? "Open PRs" : row.kind === "branch" ? "Recent branches" : null)
                  : null;
                return (
                  <li key={rowKey(row)} role="presentation">
                    {heading && <div role="presentation" className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-zinc-500">{heading}</div>}
                    <div
                      id={`${listboxId}-${i}`}
                      role="option"
                      aria-selected={i === selected}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => choose(row)}
                      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${i === selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"}`}
                    >
                      <RowLabel row={row} git={project.git} defaultBranch={defaultBranch} />
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
