"use client";

import { useEffect, useRef, useState } from "react";
import { useGithubSummary } from "./useGithubSummary";
import type { CheckState, CheckSummary, CommitRow, ConflictSummary, GithubSummary, PullSummary, SessionSummary } from "@/lib/types";

/** Height of the always-visible header row in pixels; the sidebar collapses the panel to exactly this. */
export const GITHUB_PANEL_HEADER_PX = 28;

const iconButtonClass = "shrink-0 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:bg-zinc-800 focus-visible:text-zinc-200 focus-visible:outline-none disabled:opacity-50";
const chipClass = "inline-flex shrink-0 items-center rounded px-1 text-[10px] leading-4";

/** "now", "5m", "3h", "2d", "3w", "4mo", "2y" for an age in milliseconds. */
export function relativeAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

/**
 * Copy to the clipboard; `navigator.clipboard` only exists on secure origins, and Portal is often
 * reached over plain http on a LAN, so fall back to the selection-based command.
 */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable; try the fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

const checkDotClass: Record<CheckState, string> = {
  passing: "bg-green-500",
  failing: "bg-red-500",
  pending: "bg-amber-400",
  skipped: "bg-zinc-600",
};

function CheckDot({ state, title }: { state: CheckState; title: string }) {
  return <span role="img" aria-label={title} title={title} className={`inline-block h-2 w-2 shrink-0 rounded-full ${checkDotClass[state]}`} />;
}

/** "3 passing, 1 failing, 2 pending" with the zero parts left out. */
function checksLabel(checks: CheckSummary) {
  const parts = [
    checks.passing > 0 && `${checks.passing} passing`,
    checks.failing > 0 && `${checks.failing} failing`,
    checks.pending > 0 && `${checks.pending} pending`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function BranchBadge({ summary }: { summary: GithubSummary }) {
  const name = summary.detached ? "detached" : summary.branch;
  if (!name) return null;
  return (
    <span
      title={summary.detached ? "Detached HEAD" : summary.upstream ? `Branch ${name}, tracking ${summary.upstream}` : `Branch ${name}`}
      className="inline-flex min-w-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200"
    >
      <span aria-hidden="true" className="text-zinc-500">⎇</span>
      <span className={`truncate ${summary.detached ? "text-zinc-500" : ""}`}>{name}</span>
    </span>
  );
}

const stateChipClass: Record<"open" | "draft" | "merged" | "closed", string> = {
  open: "bg-green-900/50 text-green-300",
  draft: "bg-zinc-800 text-zinc-400",
  merged: "bg-purple-900/50 text-purple-300",
  closed: "bg-red-900/50 text-red-300",
};

function PullBlock({ pull }: { pull: PullSummary }) {
  const state = pull.state === "open" && pull.draft ? "draft" : pull.state;
  const review = pull.reviewDecision === "approved"
    ? { glyph: "✓", label: "Approved", className: "text-green-400" }
    : pull.reviewDecision === "changes_requested"
      ? { glyph: "✗", label: "Changes requested", className: "text-red-400" }
      : pull.reviewDecision === "review_required"
        ? { glyph: "○", label: "Review required", className: "text-amber-400" }
        : null;
  return (
    <div className="px-1.5 py-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <a href={pull.url} target="_blank" rel="noreferrer" title={`${pull.title} (opens on GitHub)`} className="min-w-0 flex-1 truncate text-zinc-200 hover:underline">
          <span className="font-mono text-zinc-400">#{pull.number}</span> {pull.title}
        </a>
        <span className={`${chipClass} ${stateChipClass[state]}`}>{state}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
        <span className="truncate">@{pull.author}</span>
        {review && <span title={review.label} className={review.className}><span aria-hidden="true">{review.glyph}</span> {review.label}</span>}
        {pull.unresolvedThreads !== null && pull.unresolvedThreads > 0 && (
          <span className="text-amber-400">{pull.unresolvedThreads} unresolved</span>
        )}
        {pull.comments !== null && <span>{pull.comments} {pull.comments === 1 ? "comment" : "comments"}</span>}
      </div>
    </div>
  );
}

function ChecksLine({ checks, open, onToggle }: { checks: CheckSummary; open: boolean; onToggle: () => void }) {
  return (
    <div className="px-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? "Hide the checks" : "Show the checks"}
        className="flex w-full items-center gap-1.5 rounded py-0.5 text-left text-[11px] text-zinc-300 hover:bg-zinc-900"
      >
        <CheckDot state={checks.state} title={`Checks ${checks.state}`} />
        <span className="min-w-0 flex-1 truncate">Checks: {checksLabel(checks)}</span>
        <span aria-hidden="true" className="text-zinc-600">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mb-1 space-y-0.5 pl-3.5 text-[11px]">
          {checks.checks.map((check, i) => (
            <li key={`${check.name}:${i}`} className="flex min-w-0 items-center gap-1.5">
              <CheckDot state={check.state} title={check.state} />
              {check.url ? (
                <a href={check.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-zinc-300 hover:underline">{check.name}</a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-zinc-300">{check.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConflictsLine({ conflicts, open, onToggle }: { conflicts: ConflictSummary; open: boolean; onToggle: () => void }) {
  if (conflicts.status === "clean") {
    return (
      <p className="px-1.5 py-0.5 text-[11px] text-zinc-600" title={`Checked ${conflicts.source === "local" ? "locally" : "by GitHub"}`}>
        <span aria-hidden="true" className="text-green-700">●</span> merges cleanly into {conflicts.base}
      </p>
    );
  }
  if (conflicts.status === "unknown") {
    return <p className="px-1.5 py-0.5 text-[11px] text-zinc-500">Conflicts unknown: {conflicts.reason}</p>;
  }
  return (
    <div className="px-1.5 py-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={`${conflicts.files.length} conflicting ${conflicts.files.length === 1 ? "file" : "files"}, checked ${conflicts.source === "local" ? "locally" : "by GitHub"}`}
        className={`${chipClass} gap-1 bg-red-900/50 py-0.5 text-[11px] text-red-300 hover:bg-red-900/70`}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        Conflicts with {conflicts.base}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 pl-3.5 font-mono text-[10px] text-zinc-400">
          {conflicts.files.length === 0 && <li className="font-sans text-zinc-600">GitHub did not list the files.</li>}
          {conflicts.files.map((file) => <li key={file} title={file} className="truncate">{file}</li>)}
        </ul>
      )}
    </div>
  );
}

function CommitItem({ row, summary, baseName, now, copied, onCopy }: {
  row: CommitRow;
  summary: GithubSummary;
  baseName: string | null;
  now: number;
  copied: boolean;
  onCopy: (sha: string) => void;
}) {
  const { pull, repoUrl } = summary;
  const checks = pull && pull.checks && row.sha === pull.headSha ? pull.checks : null;
  const chips: { key: string; text: string; title: string; className: string }[] = [];
  if (row.head) chips.push({ key: "head", text: "HEAD", title: "The checked-out commit", className: "bg-indigo-900/60 text-indigo-200" });
  if (row.remoteHead) chips.push({ key: "origin", text: "origin", title: summary.upstream ? `Where ${summary.upstream} points` : "Where the remote branch points", className: "bg-zinc-800 text-zinc-300" });
  if (row.base) {
    if (baseName) chips.push({ key: "base", text: baseName, title: `Merge base with ${baseName}`, className: "bg-zinc-800 text-zinc-300" });
    chips.push({ key: "merge-base", text: "merge-base", title: `The newest commit shared with ${baseName ?? "the base branch"}`, className: "text-zinc-500" });
  }
  const title = `${row.sha}\n${row.author}\n${new Date(row.committedAt).toISOString()}`;
  const dot = row.head
    ? "bg-indigo-500"
    : row.base
      ? "border-2 border-zinc-400 bg-zinc-950"
      : "border border-zinc-600 bg-zinc-950";
  const content = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-mono text-[11px] text-zinc-400">{row.short}</span>
        {checks && <CheckDot state={checks.state} title={`Checks ${checks.state}: ${checksLabel(checks)}`} />}
        <span className="min-w-0 flex-1 truncate text-zinc-300">{row.subject}</span>
        <span className="shrink-0 text-[10px] text-zinc-600" title={new Date(row.committedAt).toLocaleString()}>{relativeAge(now - row.committedAt)}</span>
      </div>
      {chips.length > 0 && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {chips.map((chip) => <span key={chip.key} title={chip.title} className={`${chipClass} ${chip.className}`}>{chip.text}</span>)}
        </div>
      )}
    </>
  );
  return (
    <li className="group relative flex items-stretch gap-1.5">
      <div aria-hidden="true" className="relative flex w-3 shrink-0 justify-center">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-800 group-first:top-3 group-last:bottom-[calc(100%-0.75rem)]" />
        <span className={`relative mt-1.5 h-2.5 w-2.5 rounded-full ${dot}`} />
      </div>
      {repoUrl ? (
        <a
          href={`${repoUrl}/commit/${row.sha}`}
          target="_blank"
          rel="noreferrer"
          title={title}
          className="block min-w-0 flex-1 rounded px-1 py-0.5 hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none"
        >
          {content}
        </a>
      ) : (
        <div title={title} className="min-w-0 flex-1 px-1 py-0.5">{content}</div>
      )}
      <button
        type="button"
        aria-label={`Copy sha ${row.short}`}
        title="Copy the full sha"
        onClick={() => onCopy(row.sha)}
        className={`${iconButtonClass} absolute right-0 top-0.5 bg-zinc-950/80 text-[10px] focus-visible:opacity-100 ${copied ? "opacity-100 text-zinc-300" : "opacity-0 group-hover:opacity-100"}`}
      >
        {copied ? "copied" : "⧉"}
      </button>
    </li>
  );
}

export type GithubPanelProps = {
  /** The project shown, or null when there is none to show. */
  projectId: string | null;
  /** The active session's project was removed from Portal. */
  projectRemoved: boolean;
  session?: SessionSummary;
  collapsed: boolean;
  onToggle: () => void;
  /** Polling runs only while true (and the panel is expanded); the sidebar passes its own visibility. */
  visible: boolean;
};

/**
 * The sidebar's GitHub panel: branch and sync arrows in an always-visible header, and below it the
 * branch's pull request, checks, conflicts, and a commit rail down to the merge base.
 */
export default function GithubPanel({ projectId, projectRemoved, session, collapsed, onToggle, visible }: GithubPanelProps) {
  const { summary, error, loading, refreshing, refresh, pull, pulling, pullError, loadMore, loadingMore } = useGithubSummary({
    projectId,
    enabled: !collapsed && visible,
    session,
  });
  const [showChecks, setShowChecks] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyId = "github-panel-body";

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const copySha = (sha: string) => {
    void copyText(sha).then((ok) => {
      if (!ok) return;
      setCopied(sha);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1200);
    });
  };

  const baseName = summary ? summary.conflicts?.base ?? summary.pull?.baseBranch ?? summary.logBase?.replace(/^origin\//, "") ?? null : null;
  // Ages are relative to the snapshot, which polling keeps fresh; this keeps render pure.
  const now = summary?.at ?? 0;

  return (
    <section aria-label="GitHub" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1" style={{ height: GITHUB_PANEL_HEADER_PX }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-zinc-900"
        >
          <span aria-hidden="true" className="w-3 shrink-0 text-zinc-600">{collapsed ? "▸" : "▾"}</span>
          <span className="shrink-0 font-medium text-zinc-200">GitHub</span>
          {summary && <BranchBadge summary={summary} />}
        </button>
        {summary && summary.behind > 0 && (
          <button
            type="button"
            onClick={() => void pull()}
            disabled={pulling}
            aria-label={pullError ? `Pull failed: ${pullError}` : `Pull ${summary.behind} ${summary.behind === 1 ? "commit" : "commits"}`}
            title={pullError ?? `Pull ${summary.behind} ${summary.behind === 1 ? "commit" : "commits"} (git pull --ff-only)`}
            className={`${iconButtonClass} font-mono text-[11px] ${pullError ? "text-red-400 hover:text-red-300" : "text-amber-300 hover:text-amber-200"}`}
          >
            {pulling ? <span className="animate-pulse">…</span> : `↓${summary.behind}`}
          </button>
        )}
        {summary && summary.ahead > 0 && (
          <span title={`${summary.ahead} ${summary.ahead === 1 ? "commit" : "commits"} not pushed`} className="shrink-0 font-mono text-[11px] text-zinc-400">↑{summary.ahead}</span>
        )}
        {summary && !summary.upstream && !summary.detached && summary.branch && (
          <span title="The branch has no upstream on origin" className="shrink-0 text-[10px] text-zinc-600">not published</span>
        )}
        {summary?.fetchError && (
          <span role="img" aria-label={`Couldn't fetch: ${summary.fetchError}`} title={`couldn't fetch: ${summary.fetchError}`} className="shrink-0 px-0.5 text-[11px] text-zinc-500">!</span>
        )}
        {projectId && (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh GitHub status"
            title={summary?.fetchedAt ? `Fetch and refresh (last fetch ${relativeAge(now - summary.fetchedAt)} ago)` : "Fetch and refresh"}
            className={iconButtonClass}
          >
            <span aria-hidden="true" className={`inline-block ${refreshing ? "animate-spin" : ""}`}>↻</span>
          </button>
        )}
      </div>
      {!collapsed && (
        <div id={bodyId} className="min-h-0 flex-1 overflow-y-auto text-xs">
          {projectRemoved ? (
            <p className="px-1.5 py-1 text-zinc-500">Project removed</p>
          ) : !projectId ? (
            <p className="px-1.5 py-1 text-zinc-500">Select a project</p>
          ) : (
            <>
              {pullError && <p role="alert" className="mx-1.5 my-1 truncate rounded bg-red-950/50 px-2 py-1 text-red-300" title={pullError}>{pullError}</p>}
              {error && <p className="px-1.5 py-1 text-zinc-500">{error}</p>}
              {loading && <p className="px-1.5 py-1 text-zinc-500">Loading…</p>}
              {summary && (
                <>
                  {summary.pull ? (
                    <PullBlock pull={summary.pull} />
                  ) : summary.pullError ? (
                    <p className="px-1.5 py-1 text-zinc-500">PR: {summary.pullError}</p>
                  ) : (
                    <p className="px-1.5 py-1 text-zinc-500">No pull request</p>
                  )}
                  {summary.pull?.checks && <ChecksLine checks={summary.pull.checks} open={showChecks} onToggle={() => setShowChecks((v) => !v)} />}
                  {summary.conflicts && <ConflictsLine conflicts={summary.conflicts} open={showConflicts} onToggle={() => setShowConflicts((v) => !v)} />}
                  <ul aria-label="Commits" className="mt-1 px-1.5">
                    {summary.commits.map((row) => (
                      <CommitItem key={row.sha} row={row} summary={summary} baseName={baseName} now={now} copied={copied === row.sha} onCopy={copySha} />
                    ))}
                  </ul>
                  {summary.commits.length === 0 && <p className="px-1.5 py-1 text-zinc-600">No commits</p>}
                  {summary.cursor && (
                    <div className="flex justify-center py-1.5">
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        disabled={loadingMore}
                        className="rounded-full border border-zinc-800 px-3 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-900 disabled:opacity-60"
                      >
                        {loadingMore ? "Loading…" : "Show more"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
