"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { gitActionAvailable } from "@/lib/git-action-prompt";
import { relativeAge } from "@/lib/relative-age";
import CopyButton from "./CopyButton";
import IconButton from "./IconButton";
import { useGithubSummary } from "./useGithubSummary";
import type { UseGithubSummary } from "./useGithubSummary";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { GitActionKind } from "@/lib/settings";
import type {
  CheckState,
  CheckSummary,
  CommitRow,
  GithubSummary,
  PullSummary,
  SessionSummary,
} from "@/lib/types";

const iconButtonClass =
  "shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-zinc-800 hover:text-zinc-200 focus-visible:bg-zinc-800 focus-visible:text-zinc-200 focus-visible:outline-none disabled:opacity-50";
const chipClass =
  "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] leading-4";
const checkDotClass: Record<CheckState, string> = {
  passing: "bg-green-500",
  failing: "bg-red-500",
  pending: "bg-amber-400",
  skipped: "bg-zinc-600",
};

function CheckDot({ state, title }: { state: CheckState; title: string }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${checkDotClass[state]}`}
    />
  );
}

function checksLabel(checks: CheckSummary) {
  const skipped = checks.checks.filter(
    (check) => check.state === "skipped",
  ).length;
  const parts = [
    checks.passing > 0 && `${checks.passing} passing`,
    checks.failing > 0 && `${checks.failing} failing`,
    checks.pending > 0 && `${checks.pending} pending`,
    skipped > 0 && `${skipped} skipped`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No checks reported";
}

const stateChipClass: Record<"open" | "draft" | "merged" | "closed", string> = {
  open: "bg-green-900/40 text-green-300",
  draft: "bg-zinc-800 text-zinc-400",
  merged: "bg-purple-900/40 text-purple-300",
  closed: "bg-red-900/40 text-red-300",
};

type OnGitAction = (kind: GitActionKind, summary: GithubSummary) => void;
const gitActionLabels: Record<GitActionKind, string> = {
  checks: "Investigate failing checks in a new conversation",
  conflicts: "Investigate merge conflicts in a new conversation",
  review: "Summarize review items in a new conversation",
};

function GitActionButton({
  kind,
  summary,
  onGitAction,
  reason,
}: {
  kind: GitActionKind;
  summary: GithubSummary;
  onGitAction?: OnGitAction;
  reason: string;
}) {
  const available = !!onGitAction && gitActionAvailable(kind, summary);
  const description = available
    ? `${gitActionLabels[kind]}. Prepares a draft for you to send.`
    : !onGitAction
      ? "Conversation actions are unavailable."
      : reason;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0" title={description}>
          <button
            type="button"
            aria-label={gitActionLabels[kind]}
            aria-describedby={`github-${kind}-status`}
            disabled={!available}
            onClick={() => onGitAction?.(kind, summary)}
            className="inline-flex min-h-8 items-center justify-center rounded-md border border-white/10 bg-white/5 px-2.5 text-[11px] font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:border-white/5 disabled:bg-transparent disabled:text-zinc-600"
          >
            {kind === "review" ? "Summarize" : "Investigate"}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{description}</TooltipContent>
    </Tooltip>
  );
}

function PullBlock({ pull }: { pull: PullSummary }) {
  const state = pull.state === "open" && pull.draft ? "draft" : pull.state;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">PR #{pull.number}</span>
        <span className={`${chipClass} ${stateChipClass[state]}`}>{state}</span>
        <span className="min-w-0 truncate">@{pull.author}</span>
      </div>
      <div className="flex items-start gap-2">
        <a
          href={pull.url}
          target="_blank"
          rel="noreferrer"
          title={`${pull.title} (opens on GitHub)`}
          className="min-w-0 flex-1 break-words pt-0.5 text-sm font-medium leading-5 text-zinc-200 underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          {pull.title}
        </a>
        <CopyButton
          text={pull.url}
          label="Copy PR link"
          iconOnly
          className="h-7 min-w-7 shrink-0 gap-1 px-1.5 text-muted-foreground [&>svg]:size-3.5"
        />
      </div>
      {pull.comments !== null && pull.comments > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {pull.comments} conversation{" "}
          {pull.comments === 1 ? "comment" : "comments"}
        </p>
      )}
    </div>
  );
}

function getReviewStatus(summary: GithubSummary) {
  const pull = summary.pull;
  if (!pull)
    return {
      status: summary.pullError ? "PR status unavailable" : "No pull request",
      color: "text-muted-foreground",
    };
  const threads = pull.unresolvedThreads;
  if ((threads ?? 0) > 0) {
    const decision =
      pull.reviewDecision === "changes_requested" ? " · Changes requested" : "";
    return {
      status: `${threads} unresolved ${threads === 1 ? "thread" : "threads"}${decision}`,
      color: "text-amber-300",
    };
  }
  if (pull.reviewDecision === "changes_requested")
    return { status: "Changes requested", color: "text-amber-300" };
  if (threads === null)
    return {
      status: "Review status unavailable",
      color: "text-muted-foreground",
    };
  if (pull.reviewDecision === "approved")
    return {
      status: "Approved · No unresolved threads",
      color: "text-green-400",
    };
  if (pull.reviewDecision === "review_required")
    return { status: "Awaiting review", color: "text-amber-300" };
  return { status: "No unresolved review items", color: "text-green-400" };
}

function ReviewRow({
  summary,
  onGitAction,
}: {
  summary: GithubSummary;
  onGitAction?: OnGitAction;
}) {
  const { status, color } = getReviewStatus(summary);
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-xs font-medium text-zinc-200">Review items</h3>
        <p
          id="github-review-status"
          className={`mt-1 text-[11px] leading-4 ${color}`}
        >
          {status}
        </p>
        {!onGitAction && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Conversation actions unavailable
          </p>
        )}
      </div>
      <GitActionButton
        kind="review"
        summary={summary}
        onGitAction={onGitAction}
        reason={status}
      />
    </div>
  );
}

function getConflictStatus(summary: GithubSummary) {
  const conflicts = summary.conflicts;
  const unavailable = { color: "text-muted-foreground", pending: false };
  if (!conflicts) {
    if (summary.detached)
      return { ...unavailable, status: "Unavailable for detached HEAD" };
    if (summary.branch && summary.branch === summary.defaultBranch)
      return { ...unavailable, status: "Already on base branch" };
    return { ...unavailable, status: "No base branch to compare" };
  }
  if (conflicts.status === "clean")
    return {
      status: "No merge conflicts",
      color: "text-green-400",
      pending: false,
    };
  if (conflicts.status === "conflicts")
    return {
      status:
        conflicts.files.length > 0
          ? `${conflicts.files.length} conflicting ${conflicts.files.length === 1 ? "file" : "files"}`
          : "Conflicts reported by GitHub",
      color: "text-red-300",
      pending: false,
    };
  if (conflicts.reason === "GitHub has not computed mergeability yet")
    return {
      status: "Checking mergeability…",
      color: "text-amber-300",
      pending: true,
    };
  return { ...unavailable, status: "Couldn't check conflicts" };
}

function ConflictsRow({
  summary,
  open,
  onToggle,
  onGitAction,
}: {
  summary: GithubSummary;
  open: boolean;
  onToggle: () => void;
  onGitAction?: OnGitAction;
}) {
  const conflicts = summary.conflicts;
  const hasConflicts = conflicts?.status === "conflicts";
  const { status, color, pending } = getConflictStatus(summary);
  const content = (
    <>
      <span className="flex items-center gap-1 text-xs font-medium text-zinc-200">
        Merge conflicts
        {hasConflicts &&
          (open ? (
            <ChevronDown
              aria-hidden="true"
              className="size-3 text-muted-foreground"
            />
          ) : (
            <ChevronRight
              aria-hidden="true"
              className="size-3 text-muted-foreground"
            />
          ))}
      </span>
      <span
        id="github-conflicts-status"
        className={`mt-1 block text-[11px] leading-4 ${color}`}
      >
        {status}
      </span>
    </>
  );
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {hasConflicts ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls="github-conflict-files"
              aria-label={`Conflicts with ${conflicts.base}: ${status}`}
              className="w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 hover:[&>span:first-child]:text-white"
            >
              {content}
            </button>
          ) : (
            <div>{content}</div>
          )}
          {conflicts?.base &&
            conflicts.base !==
              (summary.diff?.baseBranch ??
                summary.pull?.baseBranch ??
                conflicts.base) && (
              <p className="mt-1 break-all text-[11px] text-muted-foreground">
                Compared with {conflicts.base}
              </p>
            )}
          {conflicts?.status === "unknown" && !pending && (
            <p className="mt-1 break-words text-[11px] leading-4 text-muted-foreground">
              {conflicts.reason}
            </p>
          )}
          {!onGitAction && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Conversation actions unavailable
            </p>
          )}
        </div>
        <GitActionButton
          kind="conflicts"
          summary={summary}
          onGitAction={onGitAction}
          reason={status}
        />
      </div>
      {open && hasConflicts && (
        <ul
          id="github-conflict-files"
          className="mt-3 space-y-1 border-l border-white/10 pl-3 font-mono text-[11px] leading-4 text-zinc-400"
        >
          {conflicts.files.length === 0 && (
            <li className="font-sans">GitHub did not list the files.</li>
          )}
          {conflicts.files.map((file) => (
            <li key={file} className="break-all">
              {file}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChecksRow({
  summary,
  open,
  onToggle,
  onGitAction,
}: {
  summary: GithubSummary;
  open: boolean;
  onToggle: () => void;
  onGitAction?: OnGitAction;
}) {
  const checks = summary.pull?.checks;
  const hasDetails = !!checks && checks.checks.length > 0;
  const status = checks
    ? checksLabel(checks)
    : summary.pull
      ? "No checks reported"
      : summary.pullError
        ? "PR status unavailable"
        : "No pull request";
  const content = (
    <>
      <span className="flex items-center gap-1 text-xs font-medium text-zinc-200">
        Checks
        {hasDetails &&
          (open ? (
            <ChevronDown
              aria-hidden="true"
              className="size-3 text-muted-foreground"
            />
          ) : (
            <ChevronRight
              aria-hidden="true"
              className="size-3 text-muted-foreground"
            />
          ))}
      </span>
      <span
        id="github-checks-status"
        className="mt-1 flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground"
      >
        {checks && (
          <span className="flex h-4 items-center">
            <CheckDot state={checks.state} title={`Checks ${checks.state}`} />
          </span>
        )}
        <span>{status}</span>
      </span>
    </>
  );
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {hasDetails ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls="github-check-details"
              aria-label={`Checks: ${status}`}
              className="w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 hover:[&>span:first-child]:text-white"
            >
              {content}
            </button>
          ) : (
            <div>{content}</div>
          )}
          {!onGitAction && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Conversation actions unavailable
            </p>
          )}
        </div>
        <GitActionButton
          kind="checks"
          summary={summary}
          onGitAction={onGitAction}
          reason={checks ? "No failing checks to investigate." : status}
        />
      </div>
      {open && hasDetails && (
        <ul
          id="github-check-details"
          className="mt-3 space-y-2 border-l border-white/10 pl-3 text-[11px]"
        >
          {checks.checks.map((check, i) => (
            <li
              key={`${check.name}:${i}`}
              className="flex min-w-0 items-center gap-2"
            >
              <CheckDot state={check.state} title={check.state} />
              {check.url ? (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 break-words text-zinc-300 hover:underline"
                >
                  {check.name}
                </a>
              ) : (
                <span className="min-w-0 flex-1 break-words text-zinc-300">
                  {check.name}
                </span>
              )}
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {check.state}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function getCommitChips(
  row: CommitRow,
  upstream: string | null,
  baseName: string | null,
) {
  const chips: {
    key: string;
    text: string;
    title: string;
    className: string;
  }[] = [];
  if (row.head)
    chips.push({
      key: "head",
      text: "HEAD",
      title: "The checked-out commit",
      className: "bg-indigo-900/60 text-indigo-200",
    });
  if (row.remoteHead)
    chips.push({
      key: "origin",
      text: "origin",
      title: upstream
        ? `Where ${upstream} points`
        : "Where the remote branch points",
      className: "bg-zinc-800 text-zinc-300",
    });
  if (row.base) {
    if (baseName)
      chips.push({
        key: "base",
        text: baseName,
        title: `Merge base with ${baseName}`,
        className: "bg-zinc-800 text-zinc-300",
      });
    chips.push({
      key: "merge-base",
      text: "merge-base",
      title: `The newest commit shared with ${baseName ?? "the base branch"}`,
      className: "text-muted-foreground",
    });
  }
  return chips;
}

function CommitItem({
  row,
  summary,
  baseName,
  now,
  copied,
  onCopy,
}: {
  row: CommitRow;
  summary: GithubSummary;
  baseName: string | null;
  now: number;
  copied: boolean;
  onCopy: (sha: string) => void;
}) {
  const { pull, repoUrl } = summary;
  const checks = pull?.headSha === row.sha ? pull.checks : null;
  const chips = getCommitChips(row, summary.upstream, baseName);
  const title = `${row.sha}\n${row.author}\n${new Date(row.committedAt).toISOString()}`;
  const dot = row.head
    ? "bg-indigo-500"
    : row.base
      ? "border-2 border-zinc-400 bg-zinc-950"
      : "border border-zinc-600 bg-zinc-950";
  const content = (
    <>
      <p className="line-clamp-2 break-words pr-3 text-xs leading-5 text-zinc-300">
        {row.subject}
      </p>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-muted-foreground">
        <span className="shrink-0 font-mono">{row.short}</span>
        {checks && (
          <CheckDot
            state={checks.state}
            title={`Checks ${checks.state}: ${checksLabel(checks)}`}
          />
        )}
        <span aria-hidden="true">·</span>
        <span
          className="shrink-0"
          title={new Date(row.committedAt).toLocaleString()}
        >
          {relativeAge(now - row.committedAt)}
        </span>
        {chips.map((chip) => (
          <span
            key={chip.key}
            title={chip.title}
            className={`${chipClass} ${chip.className}`}
          >
            {chip.text}
          </span>
        ))}
      </div>
    </>
  );
  return (
    <li className="group relative flex items-stretch gap-1.5">
      <div
        aria-hidden="true"
        className="relative flex w-3 shrink-0 justify-center"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-zinc-800 group-first:top-3 group-last:bottom-[calc(100%-0.75rem)]" />
        <span className={`relative mt-3 h-2 w-2 rounded-full ${dot}`} />
      </div>
      {repoUrl ? (
        <a
          href={`${repoUrl}/commit/${row.sha}`}
          target="_blank"
          rel="noreferrer"
          title={title}
          className="block min-w-0 flex-1 rounded px-1 py-2 hover:bg-white/5 focus-visible:bg-zinc-900 focus-visible:outline-none"
        >
          {content}
        </a>
      ) : (
        <div title={title} className="min-w-0 flex-1 px-1 py-2">
          {content}
        </div>
      )}
      <button
        type="button"
        aria-label={`Copy sha ${row.short}`}
        title="Copy the full sha"
        onClick={() => onCopy(row.sha)}
        className={`${iconButtonClass} absolute right-0 top-0.5 bg-zinc-950/80 text-xs focus-visible:opacity-100 ${copied ? "opacity-100 text-zinc-300" : "opacity-0 group-hover:opacity-100"}`}
      >
        {copied ? "copied" : "⧉"}
      </button>
    </li>
  );
}

export type GithubPanelProps = {
  projectId: string | null;
  projectRemoved: boolean;
  session?: SessionSummary;
  onClose: () => void;
  /** Polling runs only while the inspector and document are visible. */
  visible: boolean;
  /** Prepare a new-conversation draft for an actionable status. */
  onGitAction?: OnGitAction;
};

function PanelHeader({
  projectId,
  projectRemoved,
  onClose,
  summary,
  refreshing,
  refresh,
}: Pick<GithubPanelProps, "projectId" | "projectRemoved" | "onClose"> &
  Pick<UseGithubSummary, "summary" | "refreshing" | "refresh">) {
  const now = summary?.at ?? 0;
  return (
    <div className="mb-4 flex shrink-0 items-center gap-1">
      <h2 className="flex-1 text-[10px] font-semibold tracking-[.12em] text-muted-foreground uppercase">
        Source control
      </h2>
      {projectId && !projectRemoved && (
        <IconButton
          label="Refresh GitHub status"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="size-7 text-muted-foreground"
          title={
            summary?.fetchedAt
              ? `Fetch and refresh (last fetch ${relativeAge(now - summary.fetchedAt)} ago)`
              : "Fetch and refresh"
          }
        >
          <RefreshCw
            aria-hidden="true"
            className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
        </IconButton>
      )}
      <IconButton
        label="Close GitHub inspector"
        onClick={onClose}
        className="size-7 text-muted-foreground"
      >
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

function UpstreamStatus({
  summary,
  pull,
  pulling,
}: { summary: GithubSummary } & Pick<UseGithubSummary, "pull" | "pulling">) {
  return (
    <>
      {summary.upstream ? (
        <div className="rounded-md bg-white/[.025] px-2.5 py-2 text-[11px]">
          <p className="break-all text-muted-foreground">
            Tracking <span className="font-mono">{summary.upstream}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 flex-1 text-zinc-400">
              {summary.ahead === 0 && summary.behind === 0
                ? "Up to date"
                : [
                    summary.ahead > 0 && `${summary.ahead} ahead`,
                    summary.behind > 0 && `${summary.behind} behind`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
            {summary.behind > 0 && (
              <button
                type="button"
                onClick={() => void pull()}
                disabled={pulling}
                aria-label={`Pull ${summary.behind} ${summary.behind === 1 ? "commit" : "commits"}`}
                title="Pull incoming commits with git pull --ff-only"
                className="inline-flex min-h-7 items-center gap-1 rounded border border-white/10 px-2 text-zinc-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
              >
                <ArrowDown aria-hidden="true" className="size-3" />
                {pulling ? "Pulling…" : "Pull"}
              </button>
            )}
          </div>
        </div>
      ) : !summary.detached && summary.branch ? (
        <p className="pl-5.5 text-[11px] text-muted-foreground">
          Not published · No upstream
        </p>
      ) : null}
    </>
  );
}

function BranchContext({
  summary,
  pull,
  pulling,
}: { summary: GithubSummary } & Pick<UseGithubSummary, "pull" | "pulling">) {
  const baseName =
    summary.diff?.baseBranch ??
    summary.pull?.baseBranch ??
    summary.conflicts?.base ??
    summary.logBase?.replace(/^origin\//, "") ??
    null;
  return (
    <div className="mb-4 space-y-2.5">
      <div className="flex items-start gap-2">
        <GitBranch
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <span
          className={`min-w-0 break-all font-mono text-xs leading-5 ${summary.detached ? "text-muted-foreground" : "text-zinc-200"}`}
        >
          {summary.detached ? "Detached HEAD" : (summary.branch ?? "No branch")}
        </span>
      </div>
      {baseName && (
        <p className="flex items-baseline gap-1.5 pl-5.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">Base:</span>
          <span className="min-w-0 break-all font-mono text-zinc-400">
            {baseName}
          </span>
        </p>
      )}
      <UpstreamStatus summary={summary} pull={pull} pulling={pulling} />
      {summary.fetchError && (
        <p
          role="status"
          className="break-words text-[11px] leading-4 text-amber-300"
        >
          Couldn&apos;t fetch: {summary.fetchError}
        </p>
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: GithubSummary["diff"] }) {
  if (!diff) return null;
  return (
    <div className="mt-3 space-y-1" aria-label="Change summary">
      <p className="text-[11px] text-muted-foreground">
        {diff.source === "pull" ? "PR changes" : "Committed branch changes"}{" "}
        <span className="break-all">vs {diff.baseBranch}</span>
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
        <span
          className="font-mono text-green-400"
          aria-label={`${diff.additions} additions`}
        >
          +{diff.additions.toLocaleString()}
        </span>
        <span
          className="font-mono text-red-400"
          aria-label={`${diff.deletions} deletions`}
        >
          −{diff.deletions.toLocaleString()}
        </span>
        <span className="text-[11px] text-muted-foreground">
          · {diff.files.toLocaleString()} {diff.files === 1 ? "file" : "files"}{" "}
          changed
        </span>
      </p>
    </div>
  );
}

function PullOverview({ summary }: { summary: GithubSummary }) {
  return (
    <div className="border-t border-white/5 py-4">
      {summary.pull ? (
        <PullBlock key={summary.pull.url} pull={summary.pull} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {summary.pullError
            ? `PR unavailable: ${summary.pullError}`
            : "No pull request"}
        </p>
      )}
      <DiffSummary diff={summary.diff} />
    </div>
  );
}

function StatusRows({
  summary,
  onGitAction,
}: {
  summary: GithubSummary;
  onGitAction?: OnGitAction;
}) {
  const [showChecks, setShowChecks] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  return (
    <div className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/10 bg-white/[.015]">
      <ConflictsRow
        summary={summary}
        open={showConflicts}
        onToggle={() => setShowConflicts((value) => !value)}
        onGitAction={onGitAction}
      />
      <ReviewRow summary={summary} onGitAction={onGitAction} />
      <ChecksRow
        summary={summary}
        open={showChecks}
        onToggle={() => setShowChecks((value) => !value)}
        onGitAction={onGitAction}
      />
    </div>
  );
}

function CommitHistory({
  summary,
  loadMore,
  loadingMore,
}: { summary: GithubSummary } & Pick<
  UseGithubSummary,
  "loadMore" | "loadingMore"
>) {
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copySha = (sha: string) => {
    void copyText(sha).then((ok) => {
      if (!ok) return;
      setCopied(sha);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1200);
    });
  };
  const historyBase = summary.logBase?.replace(/^origin\//, "") ?? null;
  // Polling refreshes the snapshot used for relative ages, keeping rendering pure.
  const now = summary.at;
  return (
    <div className="mt-5">
      <h3 className="mb-2 text-[10px] font-semibold tracking-[.1em] text-muted-foreground uppercase">
        {summary.logBase ? "Branch commits" : "Commit history"}
      </h3>
      <ul aria-label="Commits">
        {summary.commits.map((row) => (
          <CommitItem
            key={row.sha}
            row={row}
            summary={summary}
            baseName={historyBase}
            now={now}
            copied={copied === row.sha}
            onCopy={copySha}
          />
        ))}
      </ul>
      {summary.commits.length === 0 && (
        <p className="py-2 text-muted-foreground">No commits</p>
      )}
      {summary.cursor && (
        <div className="flex justify-center py-3">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-md border border-white/10 px-3 py-1.5 text-[11px] text-zinc-400 hover:bg-white/5 disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

function PanelContent({
  projectId,
  projectRemoved,
  github,
  onGitAction,
}: Pick<GithubPanelProps, "projectId" | "projectRemoved" | "onGitAction"> & {
  github: UseGithubSummary;
}) {
  if (projectRemoved)
    return <p className="py-2 text-muted-foreground">Project removed</p>;
  if (!projectId)
    return <p className="py-2 text-muted-foreground">Select a project</p>;
  const {
    summary,
    pullError,
    error,
    loading,
    pull,
    pulling,
    loadMore,
    loadingMore,
  } = github;
  return (
    <>
      {pullError && (
        <p
          role="alert"
          className="mb-3 break-words rounded-md bg-red-950/50 px-3 py-2 leading-5 text-red-300"
        >
          {pullError}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 break-words text-amber-300">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="py-2 text-muted-foreground">
          Loading source control…
        </p>
      )}
      {summary && (
        <>
          <BranchContext summary={summary} pull={pull} pulling={pulling} />
          <PullOverview summary={summary} />
          <StatusRows summary={summary} onGitAction={onGitAction} />
          <CommitHistory
            summary={summary}
            loadMore={loadMore}
            loadingMore={loadingMore}
          />
        </>
      )}
    </>
  );
}

export default function GithubPanel({
  projectId,
  projectRemoved,
  session,
  onClose,
  visible,
  onGitAction,
}: GithubPanelProps) {
  const github = useGithubSummary({ projectId, enabled: visible, session });
  return (
    <section aria-label="GitHub" className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        projectId={projectId}
        projectRemoved={projectRemoved}
        onClose={onClose}
        summary={github.summary}
        refreshing={github.refreshing}
        refresh={github.refresh}
      />
      <div
        id="github-panel-body"
        className="min-h-0 flex-1 overflow-y-auto text-xs"
      >
        <PanelContent
          projectId={projectId}
          projectRemoved={projectRemoved}
          github={github}
          onGitAction={onGitAction}
        />
      </div>
    </section>
  );
}
