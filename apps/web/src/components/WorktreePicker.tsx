"use client";

import { useEffect, useMemo, useState } from "react";
import { BranchBadge } from "./ContextBar";
import Picker from "./Picker";
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
  /** A git project; a worktree project lists and creates worktrees of the same repository. */
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
  const [listingResult, setListingResult] = useState<ListingResult | null>(null);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

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

  const choose = (row: PickerRow): boolean | void => {
    switch (row.kind) {
      case "original":
        onChange(ORIGINAL);
        break;
      case "pull":
        if (row.pull.fork) {
          setSelectError("Fork PRs are not supported.");
          return false;
        }
        onChange({
          kind: "branch",
          branch: row.pull.branch,
          pull: row.pull,
          path: listing?.branches.find((b) => b.name === row.pull.branch)?.worktreePath ?? undefined,
          repoWorktreesDir: listing?.repoWorktreesDir,
        });
        break;
      case "branch":
        onChange({ kind: "branch", branch: row.branch.name, path: row.branch.worktreePath ?? undefined, repoWorktreesDir: listing?.repoWorktreesDir });
        break;
      case "create":
        onChange({ kind: "create", branch: row.name, repoWorktreesDir: listing?.repoWorktreesDir });
        break;
    }
  };

  const defaultBranch = listing?.defaultBranch ?? null;
  const showHeadings = trimmed === "";
  const heading = (row: PickerRow, previous: PickerRow | undefined) =>
    showHeadings && row.kind !== "original" && previous?.kind !== row.kind
      ? (row.kind === "pull" ? "Open PRs" : row.kind === "branch" ? "Recent branches" : null)
      : null;

  return (
    <Picker
      label="worktree"
      trigger={<TriggerLabel project={project} value={value} />}
      open={open}
      onOpenChange={(next) => {
        if (next) setGeneration((n) => n + 1);
        else setSelectError(null);
        setOpen(next);
      }}
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setSelectError(null);
      }}
      searchLabel="Search branches and pull requests"
      placeholder="Branch, PR number, or title…"
      rows={rows}
      rowKey={rowKey}
      renderRow={(row) => <RowLabel row={row} git={project.git} defaultBranch={defaultBranch} />}
      heading={heading}
      onChoose={choose}
      disabled={disabled}
      status={
        <>
          {loading && <p className="py-1 text-zinc-500">Loading branches…</p>}
          {listingError && <p className="py-1 text-red-300">{listingError}</p>}
          {listing?.pullsError && <p className="py-1 text-zinc-500">Open PRs unavailable: {listing.pullsError}</p>}
          {lookupPending && <p className="py-1 text-zinc-500">Looking up PR #{number}…</p>}
          {lookupForQuery?.error && <p className="py-1 text-zinc-500">{lookupForQuery.error}</p>}
          {selectError && <p role="alert" className="py-1 text-red-300">{selectError}</p>}
          {!loading && listing && rows.length === 0 && !lookupPending && <p className="py-1 text-zinc-500">No matches.</p>}
        </>
      }
    />
  );
}
