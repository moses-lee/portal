import type { GitActionKind } from "./settings.ts";
import type { GithubSummary, PullSummary } from "./types.ts";

/**
 * Decides when the GitHub panel's "start a conversation about this" buttons apply and builds the
 * text they paste into the composer: the user's stored prompt followed by a plain-text context
 * block (PR, failing checks, conflicting files, or review state) drawn from a `GithubSummary`.
 */

/** True when the summary has something for this action to act on, so the panel should show its button. */
export function gitActionAvailable(kind: GitActionKind, summary: GithubSummary): boolean {
  switch (kind) {
    case "checks":
      return summary.pull?.checks?.state === "failing";
    case "conflicts":
      return summary.conflicts?.status === "conflicts";
    case "review": {
      const pull = summary.pull;
      if (!pull) return false;
      return (pull.unresolvedThreads ?? 0) > 0 || pull.reviewDecision === "changes_requested" || (pull.comments ?? 0) > 0;
    }
  }
}

/** `promptText` (the user's stored prompt) followed by a blank line and a context block built from `summary`. */
export function buildGitActionPrompt(kind: GitActionKind, summary: GithubSummary, promptText: string): string {
  const prompt = promptText.trim();
  const context = contextBlock(kind, summary);
  return prompt ? `${prompt}\n\n${context}` : context;
}

function contextBlock(kind: GitActionKind, summary: GithubSummary): string {
  const branch = summary.branch ?? "HEAD";
  const { pull } = summary;
  const lines = pull
    ? [`PR #${pull.number}: ${pull.url} (base: ${pull.baseBranch}, head: ${branch})`]
    : [`Branch: ${branch}`];
  switch (kind) {
    case "checks":
      lines.push("Failing checks:", ...failingCheckLines(pull));
      break;
    case "conflicts":
      lines.push(...conflictLines(summary, pull !== null));
      break;
    case "review":
      if (pull) lines.push(reviewLine(pull));
      break;
  }
  return lines.join("\n").trimEnd();
}

function failingCheckLines(pull: PullSummary | null): string[] {
  const checks = pull?.checks?.checks ?? [];
  return checks.filter((check) => check.state === "failing").map((check) => (check.url ? `- ${check.name}: ${check.url}` : `- ${check.name}`));
}

function conflictLines(summary: GithubSummary, hasPull: boolean): string[] {
  const { conflicts } = summary;
  if (conflicts?.status !== "conflicts") return [];
  const lines = hasPull ? [] : [`Conflicts with base: ${conflicts.base}`];
  if (conflicts.files.length === 0) lines.push("GitHub reported conflicts but did not list the files.");
  else lines.push("Conflicting files:", ...conflicts.files.map((file) => `- ${file}`));
  return lines;
}

const decisionLabels: Record<NonNullable<PullSummary["reviewDecision"]>, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: "review required",
};

function reviewLine(pull: PullSummary): string {
  const decision = pull.reviewDecision ? decisionLabels[pull.reviewDecision] : "no review decision";
  return `Review: ${decision}, ${count(pull.unresolvedThreads, "unresolved thread")}, ${count(pull.comments, "comment")}`;
}

/** "3 comments", "1 comment", or "unknown comments" for a null count. */
function count(n: number | null, noun: string): string {
  if (n === null) return `unknown ${noun}s`;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
